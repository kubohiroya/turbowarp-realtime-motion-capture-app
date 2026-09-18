import type { Joint3D, PoseFrame3DPerson } from '../contracts.ts';

export interface PredictionOptions {
  /** The furthest ahead of the fused instant a joint is extrapolated, microseconds. */
  readonly maxLeadUs: number;
  /** How far back the fused positions a velocity is fitted to reach, microseconds. */
  readonly windowUs: number;
  /** The fewest fused positions of a joint in the window a velocity is fitted to. */
  readonly minSamples: number;
  /** The root-mean-square distance from the fitted line beyond which a joint is not extrapolated, metres. */
  readonly maxResidualM: number;
  /** The fastest a joint is extrapolated, metres per second. */
  readonly maxSpeedMps: number;
}

/**
 * Chosen on the synthetic scenes (#34 stage 2 tools, 10 s, seed 1) against the display error at
 * leads of 0, 50 and 100 ms. A window of two positions made it worse than no prediction; widening it
 * to 400 ms halved the median with one person, and the residual limit kept the 95th percentile from
 * growing where crowded triangulations are noisy. The venue recordings decide the final values.
 */
export const DEFAULT_PREDICTION_OPTIONS: PredictionOptions = Object.freeze({
  maxLeadUs: 200_000,
  windowUs: 400_000,
  minSamples: 3,
  maxResidualM: 0.03,
  maxSpeedMps: 3,
});

type Point = { readonly x: number; readonly y: number; readonly z: number };

interface Sample {
  readonly timeUs: number;
  readonly joints: ReadonlyMap<string, Point>;
}

/**
 * Carries each person's joints from the fused instant to the instant they will be shown at
 * (#34 stage 6, extrapolation only).
 *
 * The fused instant sits a frame behind the newest camera frame so the cameras line up, and the
 * frame is shown later still. Each person (stage 4 IDs) keeps the positions of their measured
 * joints over the last `windowUs`. A joint measured now with `minSamples` positions in the window
 * moves on at the velocity of the straight line fitted to them, at most `maxSpeedMps`, for at most
 * `maxLeadUs`, and is reported `predicted`. Two positions a frame apart would carry their noise into
 * the velocity many times over; the fit spreads it across the window, at the cost of reacting later
 * to a change of speed. A joint whose positions stray from the line by more than `maxResidualM` —
 * a mis-triangulation, or an ID that passed to someone else — is not extrapolated, nor is one
 * without enough history; it keeps its fused position and state.
 */
export class JointPrediction {
  private readonly options: PredictionOptions;
  private readonly history = new Map<string, Sample[]>();

  public constructor(options: PredictionOptions = DEFAULT_PREDICTION_OPTIONS) {
    this.options = options;
  }

  public reset(): void {
    this.history.clear();
  }

  /** Records the fused persons, and returns them extrapolated to `targetUs` when one is given. */
  public apply(
    persons: readonly PoseFrame3DPerson[],
    fusedUs: number,
    targetUs: number | null,
  ): { persons: PoseFrame3DPerson[]; timestampUs: number } {
    for (const person of persons) this.remember(person, fusedUs);
    this.forget(fusedUs);
    if (targetUs === null || targetUs <= fusedUs) {
      return { persons: [...persons], timestampUs: fusedUs };
    }
    const leadUs = Math.min(targetUs - fusedUs, this.options.maxLeadUs);
    return {
      timestampUs: fusedUs + leadUs,
      persons: persons.map((person) => {
        const samples = this.history.get(person.personId) ?? [];
        return {
          ...person,
          joints: person.joints.map((joint): Joint3D => {
            if (joint.state !== 'measured') return joint;
            const velocity = fitVelocity(samples, joint.id, this.options);
            if (!velocity) return joint;
            const seconds = leadUs / 1_000_000;
            return {
              ...joint,
              x: joint.x + velocity.x * seconds,
              y: joint.y + velocity.y * seconds,
              z: joint.z + velocity.z * seconds,
              state: 'predicted',
            };
          }),
        };
      }),
    };
  }

  private remember(person: PoseFrame3DPerson, fusedUs: number): void {
    const joints = new Map(
      person.joints
        .filter((joint) => joint.state === 'measured')
        .map(
          (joint) =>
            [joint.id, { x: joint.x, y: joint.y, z: joint.z }] as const,
        ),
    );
    const samples = this.history.get(person.personId) ?? [];
    const last = samples[samples.length - 1];
    // A repeated request for the same instant adds nothing to learn from.
    if (last && last.timeUs >= fusedUs) return;
    samples.push({ timeUs: fusedUs, joints });
    this.history.set(person.personId, samples);
  }

  private forget(fusedUs: number): void {
    for (const [personId, samples] of this.history) {
      const kept = samples.filter(
        (sample) => fusedUs - sample.timeUs <= this.options.windowUs,
      );
      if (kept.length === 0) this.history.delete(personId);
      else this.history.set(personId, kept);
    }
  }
}

/**
 * Metres per second of the least-squares line through a joint's positions, capped at
 * `maxSpeedMps`; none when there are too few positions or they stray from the line.
 */
function fitVelocity(
  samples: readonly Sample[],
  jointId: string,
  options: PredictionOptions,
): Point | undefined {
  const points = samples.flatMap((sample) => {
    const point = sample.joints.get(jointId);
    return point ? [{ t: sample.timeUs / 1_000_000, point }] : [];
  });
  if (points.length < Math.max(2, options.minSamples)) return undefined;
  const meanT = points.reduce((total, { t }) => total + t, 0) / points.length;
  const spread = points.reduce((total, { t }) => total + (t - meanT) ** 2, 0);
  if (!(spread > 0)) return undefined;
  const axes = (['x', 'y', 'z'] as const).map((axis) => {
    const mean =
      points.reduce((total, { point }) => total + point[axis], 0) /
      points.length;
    const slope =
      points.reduce(
        (total, { t, point }) => total + (t - meanT) * (point[axis] - mean),
        0,
      ) / spread;
    return { axis, mean, slope };
  });
  const squared =
    points.reduce(
      (total, { t, point }) =>
        total +
        axes.reduce(
          (sum, { axis, mean, slope }) =>
            sum + (point[axis] - (mean + slope * (t - meanT))) ** 2,
          0,
        ),
      0,
    ) / points.length;
  if (Math.sqrt(squared) > options.maxResidualM) return undefined;
  const [x, y, z] = axes.map(({ slope }) => slope) as [number, number, number];
  const speed = Math.hypot(x, y, z);
  const scale = speed > options.maxSpeedMps ? options.maxSpeedMps / speed : 1;
  return { x: x * scale, y: y * scale, z: z * scale };
}

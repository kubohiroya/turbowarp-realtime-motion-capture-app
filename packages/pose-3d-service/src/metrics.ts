/**
 * What a replay came to, against the truth the session carries (#34, stage 2).
 *
 * These are the figures the later stages are judged by, and they are defined here once so a figure
 * from stage 3 can be compared with the same figure from stage 6. Every one of them says how many
 * samples it came from: an error over three joints is not the same claim as an error over thirty
 * thousand, and a metric that hides the difference invites reading noise as progress.
 *
 * A session without truth — a venue recording — still yields the figures that need no truth: how many
 * requests were answered, how many people were reported, and how long the service took.
 */

import type {PoseFrame3DV2} from './contracts.ts';
import type {ReplayResult} from './replay.ts';
import type {Session, TruthFrame} from './session.ts';

export interface Distribution {
  readonly count: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

export interface EvaluationMetrics {
  readonly implementation: string;
  readonly requests: number;
  readonly answered: number;
  /** Answers that carried no frame, which is what a service says before it has enough to say. */
  readonly empty: number;
  readonly unanswered: number;
  readonly framesSent: number;
  readonly framesAccepted: number;
  readonly errors: number;
  /** Milliseconds inside the service, over every message. */
  readonly handleMs: Distribution;
  /** Present only for a session that carries truth. */
  readonly truth?: TruthMetrics;
}

export interface TruthMetrics {
  /** People reported minus people the truth says were visible to two cameras or more. */
  readonly personCountError: Distribution;
  /** Distance from a reported joint to the truth joint it was matched with, in meters. */
  readonly jointErrorMeters: Distribution;
  /** Truth joints seen by two cameras or more that were reported as measured or constrained. */
  readonly jointRecall: number;
  /** How often a person's reported ID changed while the truth person stayed the same. */
  readonly identitySwitches: number;
  /** Truth frames the answers were matched against. */
  readonly matchedFrames: number;
}

/** A joint is triangulable when two cameras or more saw it; nothing else can be asked of a service. */
const MINIMUM_CAMERAS = 2;

export function evaluate(session: Session, replay: ReplayResult): EvaluationMetrics {
  const base: EvaluationMetrics = {
    // What answered, which is the replay's implementation when it replaced the session's.
    implementation: replay.answers.find((answer) => answer.frame)?.frame?.implementation ?? session.configuration.implementation,
    requests: replay.requests,
    answered: replay.answers.length,
    empty: replay.answers.filter((answer) => answer.frame === null).length,
    unanswered: replay.unanswered,
    framesSent: replay.framesSent,
    framesAccepted: replay.framesAccepted,
    errors: replay.errors.length,
    handleMs: distribution(replay.handleMs)
  };
  const truth = session.truth;
  if (!truth || truth.length === 0) return base;
  return {...base, truth: truthMetrics(truth, replay)};
}

function truthMetrics(truth: readonly TruthFrame[], replay: ReplayResult): TruthMetrics {
  const countErrors: number[] = [];
  const jointErrors: number[] = [];
  let recallable = 0;
  let recalled = 0;
  let identitySwitches = 0;
  let matchedFrames = 0;
  /** The reported ID each truth person was last matched with. */
  const lastReportedId = new Map<string, string>();

  for (const answer of replay.answers) {
    const frame = answer.frame;
    if (!frame) continue;
    const truthFrame = nearestTruth(truth, frame.timestampUs);
    if (!truthFrame) continue;
    matchedFrames += 1;
    const expected = truthFrame.persons.filter((person) =>
      person.joints.some((joint) => joint.cameraIds.length >= MINIMUM_CAMERAS)
    );
    countErrors.push(frame.persons.length - expected.length);
    for (const person of expected) {
      for (const joint of person.joints) {
        if (joint.cameraIds.length < MINIMUM_CAMERAS) continue;
        recallable += 1;
      }
    }
    for (const [truthPerson, reported] of matchPersons(expected, frame)) {
      const previous = lastReportedId.get(truthPerson.personId);
      if (previous !== undefined && previous !== reported.personId) identitySwitches += 1;
      lastReportedId.set(truthPerson.personId, reported.personId);
      for (const joint of truthPerson.joints) {
        if (joint.cameraIds.length < MINIMUM_CAMERAS) continue;
        const estimated = reported.joints.find((candidate) => candidate.id === joint.id);
        if (!estimated || (estimated.state !== 'measured' && estimated.state !== 'constrained')) continue;
        recalled += 1;
        jointErrors.push(Math.hypot(estimated.x - joint.x, estimated.y - joint.y, estimated.z - joint.z));
      }
    }
  }

  return {
    personCountError: distribution(countErrors.map(Math.abs)),
    jointErrorMeters: distribution(jointErrors),
    jointRecall: recallable === 0 ? 0 : round4(recalled / recallable),
    identitySwitches,
    matchedFrames
  };
}

/**
 * Pairs each truth person with the reported person nearest to them, closest pair first.
 *
 * Greedy rather than optimal: with people a metre apart it gives the same pairing as the Hungarian
 * algorithm, and where it does not, the distances involved are already far beyond any threshold the
 * metric is read against.
 */
function matchPersons(
  expected: TruthFrame['persons'],
  frame: PoseFrame3DV2
): Array<[TruthFrame['persons'][number], PoseFrame3DV2['persons'][number]]> {
  const pairs: Array<{distance: number; truth: TruthFrame['persons'][number]; reported: PoseFrame3DV2['persons'][number]}> = [];
  for (const truthPerson of expected) {
    const truthCentre = centroid(truthPerson.joints.filter((joint) => joint.cameraIds.length >= MINIMUM_CAMERAS));
    if (!truthCentre) continue;
    for (const reported of frame.persons) {
      const reportedCentre = centroid(reported.joints.filter((joint) => joint.state !== 'missing'));
      if (!reportedCentre) continue;
      pairs.push({
        distance: Math.hypot(
          truthCentre[0] - reportedCentre[0],
          truthCentre[1] - reportedCentre[1],
          truthCentre[2] - reportedCentre[2]
        ),
        truth: truthPerson,
        reported
      });
    }
  }
  pairs.sort((left, right) => left.distance - right.distance);
  const usedTruth = new Set<string>();
  const usedReported = new Set<string>();
  const matches: Array<[TruthFrame['persons'][number], PoseFrame3DV2['persons'][number]]> = [];
  for (const pair of pairs) {
    if (usedTruth.has(pair.truth.personId) || usedReported.has(pair.reported.personId)) continue;
    usedTruth.add(pair.truth.personId);
    usedReported.add(pair.reported.personId);
    matches.push([pair.truth, pair.reported]);
  }
  return matches;
}

function centroid(joints: ReadonlyArray<{x: number; y: number; z: number}>): [number, number, number] | undefined {
  if (joints.length === 0) return undefined;
  const sum = joints.reduce(
    (total, joint) => [total[0] + joint.x, total[1] + joint.y, total[2] + joint.z] as [number, number, number],
    [0, 0, 0] as [number, number, number]
  );
  return [sum[0] / joints.length, sum[1] / joints.length, sum[2] / joints.length];
}

function nearestTruth(truth: readonly TruthFrame[], timestampUs: number): TruthFrame | undefined {
  let best: TruthFrame | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const frame of truth) {
    const distance = Math.abs(frame.timestampUs - timestampUs);
    if (distance < bestDistance) {
      best = frame;
      bestDistance = distance;
    }
  }
  return best;
}

export function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) return {count: 0, mean: 0, p50: 0, p95: 0, max: 0};
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
  return {
    count: sorted.length,
    mean: round4(values.reduce((total, value) => total + value, 0) / values.length),
    p50: round4(at(0.5)),
    p95: round4(at(0.95)),
    max: round4(sorted[sorted.length - 1] ?? 0)
  };
}

/** One readable block, for a terminal and for a record in an issue. */
export function formatMetrics(metrics: EvaluationMetrics): string {
  const lines = [
    `implementation: ${metrics.implementation}`,
    `requests: ${metrics.requests} (answered ${metrics.answered}, empty ${metrics.empty}, unanswered ${metrics.unanswered})`,
    `frames: sent ${metrics.framesSent}, accepted ${metrics.framesAccepted}, errors ${metrics.errors}`,
    `service time ms: p50 ${metrics.handleMs.p50}, p95 ${metrics.handleMs.p95}, max ${metrics.handleMs.max} (${metrics.handleMs.count} messages)`
  ];
  if (metrics.truth) {
    lines.push(
      `matched frames: ${metrics.truth.matchedFrames}`,
      `person count error: mean ${metrics.truth.personCountError.mean}, max ${metrics.truth.personCountError.max}`,
      `joint error m: p50 ${metrics.truth.jointErrorMeters.p50}, p95 ${metrics.truth.jointErrorMeters.p95}, max ${metrics.truth.jointErrorMeters.max} (${metrics.truth.jointErrorMeters.count} joints)`,
      `joint recall: ${metrics.truth.jointRecall}`,
      `identity switches: ${metrics.truth.identitySwitches}`
    );
  }
  return lines.join('\n');
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

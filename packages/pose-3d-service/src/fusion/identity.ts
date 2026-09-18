import type { FusedPerson, Vector3 } from './types.ts';

export interface IdentityOptions {
  /** The fastest a person's torso is taken to move, metres per second. */
  readonly maxSpeedMps: number;
  /**
   * Distance allowed on top of that, metres. A torso partly out of view moves its centre by tens of
   * centimetres, and a crowded instant can mis-triangulate it further. On the synthetic scenes
   * (#34 stage 2 tools, 10 s, seeds 1–3) identity switches with 8 cameras and 6 people fell as this
   * grew to 1.2 m and no further beyond it; the venue recordings decide the final value.
   */
  readonly marginM: number;
  /** How long a person may go unseen and still keep their ID, microseconds. */
  readonly holdUs: number;
  /**
   * How much further a person may be when a camera's tracker still names them as before. A bad
   * triangulation can throw the torso centre far off for an instant; the tracker is not fooled.
   */
  readonly sharedViewReachFactor: number;
}

export const DEFAULT_IDENTITY_OPTIONS: IdentityOptions = Object.freeze({
  maxSpeedMps: 3,
  marginM: 1.2,
  holdUs: 1_000_000,
  sharedViewReachFactor: 4,
});

const TORSO = ['left_shoulder', 'right_shoulder', 'left_hip', 'right_hip'];

interface Track {
  readonly id: number;
  center: Vector3;
  timeUs: number;
  /** `cameraId/trackingId` of the 2D persons it was last fused from. */
  views: Set<string>;
}

interface Pair {
  readonly track: number;
  readonly person: number;
  readonly distance: number;
  readonly shared: boolean;
}

/**
 * Keeps a person's ID from one output instant to the next (#34 stage 4).
 *
 * fusion-v0 finds people instant by instant; until now it named each after the tracker that saw them
 * first, so the name changed whenever that tracker did. This follows each person's torso centre
 * instead, with the camera trackers as a second witness. A person at one instant takes the ID of a
 * person of the last instants whose centre they could have reached, `marginM + maxSpeedMps ×
 * elapsed`. A pair that a camera's tracker still names alike goes first and may be
 * `sharedViewReachFactor` times as far apart, because a bad triangulation moves the centre and not
 * the tracker; the rest pair nearest first. Anyone left over gets a new ID, and an ID unseen for
 * `holdUs` is retired. Two people who pass within the margin of each other, unseen by a tracker
 * that tells them apart, can still swap IDs; that is what the glow sticks are for.
 */
export class PersonIdentities {
  private readonly options: IdentityOptions;
  private tracks: Track[] = [];
  private nextId = 1;
  private lastTimeUs: number | undefined;

  public constructor(options: IdentityOptions = DEFAULT_IDENTITY_OPTIONS) {
    this.options = options;
  }

  public reset(): void {
    this.tracks = [];
    this.nextId = 1;
    this.lastTimeUs = undefined;
  }

  /** One ID per person, in the order given. */
  public assign(persons: readonly FusedPerson[], timeUs: number): string[] {
    if (
      this.lastTimeUs !== undefined &&
      timeUs < this.lastTimeUs - this.options.holdUs
    ) {
      // The clock went back further than anyone is held: a new take, not a continuation.
      this.reset();
    }
    this.lastTimeUs = Math.max(this.lastTimeUs ?? timeUs, timeUs);
    this.tracks = this.tracks.filter(
      (track) => timeUs - track.timeUs <= this.options.holdUs,
    );

    const centers = persons.map(centerOf);
    const views = persons.map(
      (person) =>
        new Set(
          person.members.map((member) =>
            viewKey(member.cameraId, member.trackingId),
          ),
        ),
    );
    const pairs: Pair[] = [];
    this.tracks.forEach((track, trackIndex) => {
      const elapsedS = Math.max(0, timeUs - track.timeUs) / 1_000_000;
      const reach = this.options.marginM + this.options.maxSpeedMps * elapsedS;
      centers.forEach((center, personIndex) => {
        if (!center) return;
        const distance = Math.hypot(
          center.x - track.center.x,
          center.y - track.center.y,
          center.z - track.center.z,
        );
        const shared = [...(views[personIndex] as Set<string>)].some((view) =>
          track.views.has(view),
        );
        const limit = shared
          ? reach * this.options.sharedViewReachFactor
          : reach;
        if (distance <= limit) {
          pairs.push({
            track: trackIndex,
            person: personIndex,
            distance,
            shared,
          });
        }
      });
    });
    pairs.sort(
      (left, right) =>
        Number(right.shared) - Number(left.shared) ||
        left.distance - right.distance,
    );

    const ids = new Array<number | undefined>(persons.length).fill(undefined);
    const usedTracks = new Set<number>();
    for (const pair of pairs) {
      if (usedTracks.has(pair.track) || ids[pair.person] !== undefined)
        continue;
      usedTracks.add(pair.track);
      const track = this.tracks[pair.track] as Track;
      ids[pair.person] = track.id;
      track.center = centers[pair.person] as Vector3;
      track.timeUs = Math.max(track.timeUs, timeUs);
      track.views = views[pair.person] as Set<string>;
    }
    return ids.map((id, index) => {
      if (id !== undefined) return `person-${id}`;
      const fresh = this.nextId++;
      const center = centers[index];
      if (center) {
        this.tracks.push({
          id: fresh,
          center,
          timeUs,
          views: views[index] as Set<string>,
        });
      }
      return `person-${fresh}`;
    });
  }
}

/** The mean of the torso joints found, or of every joint found when no torso joint was. */
function centerOf(person: FusedPerson): Vector3 | undefined {
  const torso = person.keypoints.filter(
    (keypoint) => keypoint.point && TORSO.includes(keypoint.id),
  );
  const points = (
    torso.length > 0
      ? torso
      : person.keypoints.filter((keypoint) => keypoint.point)
  ).map((keypoint) => keypoint.point as Vector3);
  if (points.length === 0) return undefined;
  const sum = points.reduce(
    (total, point) => ({
      x: total.x + point.x,
      y: total.y + point.y,
      z: total.z + point.z,
    }),
    { x: 0, y: 0, z: 0 },
  );
  return {
    x: sum.x / points.length,
    y: sum.y / points.length,
    z: sum.z / points.length,
  };
}

function viewKey(cameraId: string, trackingId: string): string {
  return `${cameraId}/${trackingId}`;
}

import {
  personIdOf,
  POSE_FRAME_2D_SCHEMA,
  toPoseFrame3DV1,
  type PoseFrame2D,
  type PoseFrame3DV2,
} from './contracts.ts';

export const MAX_AVATAR_SLOTS = 6;

interface KeypointV1 {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly score: number;
}

interface PersonV1 {
  readonly personId: string;
  readonly keypoints: readonly KeypointV1[];
}

type Point = { readonly x: number; readonly y: number; readonly z: number };

interface FrameV1 {
  readonly persons: readonly PersonV1[];
}

export interface AvatarSlot {
  readonly slotId: string;
  readonly personId: string;
}

export interface AvatarPoses {
  /** `twrmc/pose-frame-3d` v1 with each person's ID replaced by their avatar slot. */
  readonly pose3d: unknown;
  /** `twrmc/pose-frame-2d` v1 whose tracking IDs are the same slots. */
  readonly pose2d: unknown;
  readonly slots: readonly AvatarSlot[];
}

/**
 * Turns the service's 3D frame into the pair of frames the avatar blocks of
 * `turbowarp-realtime-motion-capture` read, keyed by a fixed set of avatar slots.
 *
 * The avatar blocks join a 3D person to the 2D person whose tracking ID equals the 3D person ID, and
 * bind avatars to those IDs. fusion-v0 names a person after the camera and tracker that saw them
 * first, so the name changes whenever that tracker does (identity over time is #34 stage 4). Binding
 * an avatar per name would load a VRM each time. Instead avatars are bound once to `slot-1` ...
 * `slot-N`: a person who appears takes the lowest free slot, keeps it while they are seen, and frees
 * it after `holdMs` unseen. Until stage 4, a broken track can move an avatar to another person.
 *
 * The 2D person is the one the 3D person's ID names, from that camera's newest frame; the service
 * fused a slightly older instant, which is close enough for the screen position Kalidokit reads.
 * Persons from cameras of different sizes are scaled to the first one's size, so the frame keeps one
 * size, as the contract requires.
 *
 * A joint no camera measured comes out of version 1 at the origin with score 0. Kalidokit solves
 * every joint at once, and a joint at the origin makes a limb of no length and a non-finite
 * rotation, which loses the whole person. So each slot keeps where each joint was last measured and
 * puts an unmeasured joint there, still with score 0, as `turbowarp-realtime-motion-capture`'s own
 * fusion does; the avatar blocks leave a bone whose joints score 0 as it was. A limb or face joint
 * never measured since the person took the slot is put where a person at rest would have it (see
 * {@link restingJoints}), only so the solve stays finite. A person whose shoulders and hips were
 * never all measured is left out, which the avatar blocks report as unrecognized.
 */
export class AvatarPoseSlots {
  private readonly slots: Array<{
    personId: string;
    lastSeenUs: number;
    joints: Map<string, Point>;
  } | null>;
  private readonly holdUs: number;

  public constructor(count: number, holdMs: number) {
    if (!Number.isInteger(count) || count < 1 || count > MAX_AVATAR_SLOTS) {
      throw new Error(`Avatar slots must be 1 through ${MAX_AVATAR_SLOTS}.`);
    }
    if (!Number.isFinite(holdMs) || holdMs < 0) {
      throw new Error('Avatar slot hold must be a non-negative number of ms.');
    }
    this.slots = Array.from({ length: count }, () => null);
    this.holdUs = holdMs * 1000;
  }

  public get count(): number {
    return this.slots.length;
  }

  public update(
    frame: PoseFrame3DV2,
    frames2d: ReadonlyMap<string, PoseFrame2D>,
  ): AvatarPoses {
    const v1 = toPoseFrame3DV1(frame) as FrameV1 & Record<string, unknown>;
    const present = new Set(v1.persons.map((person) => person.personId));
    const now = frame.timestampUs;
    this.slots.forEach((slot, index) => {
      if (slot === null) return;
      if (present.has(slot.personId)) {
        slot.lastSeenUs = now;
      } else if (now - slot.lastSeenUs > this.holdUs) {
        this.slots[index] = null;
      }
    });
    for (const person of v1.persons) {
      if (this.slotOf(person.personId) >= 0) continue;
      const free = this.slots.indexOf(null);
      if (free < 0) break;
      this.slots[free] = {
        personId: person.personId,
        lastSeenUs: now,
        joints: new Map(),
      };
    }

    const persons3d: unknown[] = [];
    const persons2d: unknown[] = [];
    let size: { width: number; height: number; frame: PoseFrame2D } | undefined;
    for (const person of v1.persons) {
      const index = this.slotOf(person.personId);
      if (index < 0) continue;
      const keypoints = this.held(index, person.keypoints);
      if (keypoints === undefined) continue;
      const slotId = slotIdOf(index);
      persons3d.push({ ...person, personId: slotId, keypoints });
      const source = find2d(person.personId, frames2d);
      if (source === undefined) continue;
      size ??= {
        width: source.frame.frameWidth,
        height: source.frame.frameHeight,
        frame: source.frame,
      };
      const sx = size.width / source.frame.frameWidth;
      const sy = size.height / source.frame.frameHeight;
      persons2d.push({
        trackingId: slotId,
        score: source.person.score,
        keypoints: source.person.keypoints.map((keypoint) => ({
          id: keypoint.id,
          x: keypoint.x * sx,
          y: keypoint.y * sy,
          score: keypoint.score,
        })),
      });
    }
    const reference = size?.frame;
    return {
      pose3d: { ...v1, persons: persons3d },
      pose2d: {
        schema: POSE_FRAME_2D_SCHEMA,
        version: 1,
        cameraId: reference?.cameraId ?? 'avatar',
        peerId: reference?.peerId ?? 'avatar',
        sequence: frame.sequence,
        captureTimestampUs: frame.timestampUs,
        frameWidth: size?.width ?? 1,
        frameHeight: size?.height ?? 1,
        calibrationId: reference?.calibrationId ?? 'avatar',
        persons: persons2d,
      },
      slots: this.assignments(),
    };
  }

  public assignments(): AvatarSlot[] {
    return this.slots.flatMap((slot, index) =>
      slot === null
        ? []
        : [{ slotId: slotIdOf(index), personId: slot.personId }],
    );
  }

  /** The keypoints with unmeasured joints where they were last measured, or none if one never was. */
  private held(
    index: number,
    keypoints: readonly KeypointV1[],
  ): KeypointV1[] | undefined {
    const joints = this.slots[index]?.joints;
    if (!joints) return undefined;
    for (const keypoint of keypoints) {
      if (keypoint.score > 0) {
        joints.set(keypoint.id, {
          x: keypoint.x,
          y: keypoint.y,
          z: keypoint.z,
        });
      }
    }
    const rest = restingJoints(joints);
    if (rest === undefined) return undefined;
    return keypoints.map((keypoint) =>
      keypoint.score > 0
        ? keypoint
        : {
            ...keypoint,
            ...(joints.get(keypoint.id) ?? (rest.get(keypoint.id) as Point)),
          },
    );
  }

  private slotOf(personId: string): number {
    return this.slots.findIndex((slot) => slot?.personId === personId);
  }
}

export function slotIdOf(index: number): string {
  return `slot-${index + 1}`;
}

function find2d(
  personId: string,
  frames2d: ReadonlyMap<string, PoseFrame2D>,
): { frame: PoseFrame2D; person: PoseFrame2D['persons'][number] } | undefined {
  for (const [cameraId, frame] of frames2d) {
    const person = frame.persons.find(
      (candidate) => personIdOf(cameraId, candidate.trackingId) === personId,
    );
    if (person) return { frame, person };
  }
  return undefined;
}

const torso = ['left_shoulder', 'right_shoulder', 'left_hip', 'right_hip'];

/**
 * Where each joint of a person at rest would be, from their shoulders and hips: arms and legs
 * hanging along the torso, and the head above the shoulders. It stands in for a joint never
 * measured, so its only job is to give every limb a length; the bones it touches score 0 and are
 * not turned. Metres, along the torso's own direction, so it holds in any reference frame.
 */
function restingJoints(
  joints: ReadonlyMap<string, Point>,
): Map<string, Point> | undefined {
  const [ls, rs, lh, rh] = torso.map((id) => joints.get(id));
  if (!ls || !rs || !lh || !rh) return undefined;
  const shoulders = mid(ls, rs);
  const down = scale(sub(mid(lh, rh), shoulders), 1);
  const length = Math.hypot(down.x, down.y, down.z);
  if (!(length > 1e-6)) return undefined;
  const unit = scale(down, 1 / length);
  const across = sub(ls, rs);
  const at = (from: Point, metres: number) => add(from, scale(unit, metres));
  const rest = new Map<string, Point>();
  const set = (id: string, point: Point) => {
    rest.set(id, joints.get(id) ?? point);
  };
  set('left_elbow', at(ls, 0.28));
  set('right_elbow', at(rs, 0.28));
  set('left_wrist', at(rest.get('left_elbow') as Point, 0.25));
  set('right_wrist', at(rest.get('right_elbow') as Point, 0.25));
  set('left_knee', at(lh, 0.42));
  set('right_knee', at(rh, 0.42));
  set('left_ankle', at(rest.get('left_knee') as Point, 0.42));
  set('right_ankle', at(rest.get('right_knee') as Point, 0.42));
  const head = at(shoulders, -0.25);
  set('nose', head);
  set('left_eye', add(head, scale(across, 0.1)));
  set('right_eye', add(head, scale(across, -0.1)));
  set('left_ear', add(head, scale(across, 0.25)));
  set('right_ear', add(head, scale(across, -0.25)));
  return rest;
}

function mid(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}

function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scale(a: Point, factor: number): Point {
  return { x: a.x * factor, y: a.y * factor, z: a.z * factor };
}

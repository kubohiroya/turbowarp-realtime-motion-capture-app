import { describe, expect, it } from 'vitest';

import { AvatarPoseSlots } from '../src/avatar-poses.ts';
import {
  COCO_17_KEYPOINT_IDS,
  validatePoseFrame2D,
  type PoseFrame2D,
  type PoseFrame3DV2,
} from '../src/contracts.ts';
import { frame } from './fixtures.ts';

/** A fusion-v0 3D frame whose persons carry the 2D person each was fused from. */
function frame3d(
  timestampUs: number,
  personIds: readonly string[],
): PoseFrame3DV2 {
  return {
    schema: 'twrmc/pose-frame-3d',
    version: 2,
    sequence: timestampUs,
    timestampUs,
    referenceId: 'venue',
    implementation: 'fusion-v0',
    persons: personIds.map((personId, index) => ({
      personId,
      confidence: 0.9,
      identitySource: 'geometry',
      meanReprojectionErrorPx: 1,
      views: sources[personId] ? [sources[personId]] : [],
      joints: COCO_17_KEYPOINT_IDS.map((id, joint) => ({
        id,
        // A standing figure: each joint lower than the one before, persons side by side.
        x: index,
        y: joint * 0.1,
        z: 3,
        sigma: 0.01,
        state: 'measured',
        cameraIds: ['camera-1', 'camera-2'],
      })),
    })),
  };
}

function views(
  entries: ReadonlyArray<[cameraId: string, frame: PoseFrame2D]>,
): Map<string, PoseFrame2D> {
  return new Map(entries);
}

type Frame3dV1 = { persons: Array<{ personId: string; keypoints: unknown[] }> };
type Frame2dV1 = PoseFrame2D;

/** Stable 3D IDs, each fused from one 2D person. */
const a = 'person-1';
const b = 'person-2';
const c = 'person-3';
const sources: Record<string, { cameraId: string; trackingId: string }> = {
  [a]: { cameraId: 'camera-1', trackingId: 'movenet-1' },
  [b]: { cameraId: 'camera-1', trackingId: 'movenet-2' },
  [c]: { cameraId: 'camera-2', trackingId: 'movenet-1' },
};

describe('AvatarPoseSlots', () => {
  it('gives each person the lowest free slot and keeps it while they are seen', () => {
    const slots = new AvatarPoseSlots(2, 1000);
    const camera1 = frame('camera-1', 'lens-1', 1, 2);
    const first = slots.update(
      frame3d(0, [a, b]),
      views([['camera-1', camera1]]),
    );
    expect(first.slots).toEqual([
      { slotId: 'slot-1', personId: a },
      { slotId: 'slot-2', personId: b },
    ]);
    const second = slots.update(
      frame3d(33_000, [b, a]),
      views([['camera-1', camera1]]),
    );
    expect(
      (second.pose3d as Frame3dV1).persons.map((person) => person.personId),
    ).toEqual(['slot-2', 'slot-1']);
  });

  it('pairs each slot with the 2D person its 3D ID names, under the same slot', () => {
    const slots = new AvatarPoseSlots(6, 1000);
    const camera1 = frame('camera-1', 'lens-1', 1, 2);
    const poses = slots.update(frame3d(0, [b]), views([['camera-1', camera1]]));
    const pose2d = poses.pose2d as Frame2dV1;
    expect(validatePoseFrame2D(pose2d).ok).toBe(true);
    expect(pose2d.version).toBe(1);
    expect(pose2d.persons).toHaveLength(1);
    expect(pose2d.persons[0]?.trackingId).toBe('slot-1');
    expect(pose2d.persons[0]?.keypoints).toEqual(camera1.persons[1]?.keypoints);
    expect(pose2d.persons[0]?.trackingId).toMatch(/^[A-Za-z0-9._-]+$/u);
  });

  it('scales persons from a camera of another size into the first one', () => {
    const slots = new AvatarPoseSlots(6, 1000);
    const camera1 = frame('camera-1', 'lens-1', 1, 1);
    const camera2 = {
      ...frame('camera-2', 'lens-2', 1, 1),
      frameWidth: 640,
      frameHeight: 360,
    };
    const pose2d = slots.update(
      frame3d(0, [a, c]),
      views([
        ['camera-1', camera1],
        ['camera-2', camera2],
      ]),
    ).pose2d as Frame2dV1;
    expect(pose2d.frameWidth).toBe(1280);
    expect(pose2d.frameHeight).toBe(720);
    const scaled = pose2d.persons[1]?.keypoints[0];
    const source = camera2.persons[0]?.keypoints[0];
    expect(scaled?.x).toBeCloseTo((source?.x ?? NaN) * 2, 10);
    expect(scaled?.y).toBeCloseTo((source?.y ?? NaN) * 2, 10);
  });

  it('frees a slot only after the hold, and gives it to the next new person', () => {
    const slots = new AvatarPoseSlots(1, 1000);
    const none = views([]);
    slots.update(frame3d(0, [a]), none);
    expect(slots.update(frame3d(900_000, [b]), none).slots).toEqual([
      { slotId: 'slot-1', personId: a },
    ]);
    expect(slots.update(frame3d(1_100_000, [b]), none).slots).toEqual([
      { slotId: 'slot-1', personId: b },
    ]);
  });

  it('leaves a person without a free slot out of both frames', () => {
    const slots = new AvatarPoseSlots(1, 1000);
    const camera1 = frame('camera-1', 'lens-1', 1, 2);
    const poses = slots.update(
      frame3d(0, [a, b]),
      views([['camera-1', camera1]]),
    );
    expect(
      (poses.pose3d as Frame3dV1).persons.map((person) => person.personId),
    ).toEqual(['slot-1']);
    expect(
      (poses.pose2d as Frame2dV1).persons.map((person) => person.trackingId),
    ).toEqual(['slot-1']);
  });

  it('keeps a 3D person whose view is gone, so the avatar is reported unrecognized', () => {
    const slots = new AvatarPoseSlots(6, 1000);
    const poses = slots.update(frame3d(0, [a]), views([]));
    expect((poses.pose3d as Frame3dV1).persons).toHaveLength(1);
    expect((poses.pose2d as Frame2dV1).persons).toHaveLength(0);
  });

  it('puts an unmeasured joint where it was last measured, or at rest if it never was', () => {
    type Keypoint = {
      id: string;
      x: number;
      y: number;
      z: number;
      score: number;
    };
    const slots = new AvatarPoseSlots(6, 1000);
    const none = views([]);
    const without = (at: number, missing: string): PoseFrame3DV2 => {
      const base = frame3d(at, [a]);
      const person = base.persons[0]!;
      return {
        ...base,
        persons: [
          {
            ...person,
            joints: person.joints.map((joint) =>
              joint.id === missing
                ? {
                    ...joint,
                    x: 0,
                    y: 0,
                    z: 0,
                    state: 'missing',
                    cameraIds: [],
                  }
                : { ...joint, x: joint.x + at / 1_000_000 },
            ),
          },
        ],
      };
    };
    const keypoints = (poses: { pose3d: unknown }) =>
      (poses.pose3d as Frame3dV1).persons[0]!.keypoints as Keypoint[];
    const wristOf = (points: Keypoint[]) =>
      points.find((keypoint) => keypoint.id === 'left_wrist');

    // Never measured in this slot: the wrist hangs below the elbow, a finite point with score 0.
    const resting = wristOf(
      keypoints(slots.update(without(0, 'left_wrist'), none)),
    );
    expect(resting?.score).toBe(0);
    expect([resting?.x, resting?.y, resting?.z].every(Number.isFinite)).toBe(
      true,
    );
    expect(resting).not.toMatchObject({ x: 0, y: 0, z: 0 });

    // Measured once, then lost: it stays where it was measured.
    slots.update(frame3d(33_000, [a]), none);
    const held = keypoints(slots.update(without(66_000, 'left_wrist'), none));
    expect(wristOf(held)).toEqual({
      id: 'left_wrist',
      x: 0,
      y: 0.9,
      z: 3,
      score: 0,
    });
    expect(held.find((keypoint) => keypoint.id === 'nose')?.x).toBeCloseTo(
      0.066,
      10,
    );
  });

  it('leaves out a person whose shoulders and hips were never all measured', () => {
    const slots = new AvatarPoseSlots(6, 1000);
    const base = frame3d(0, [a]);
    const person = base.persons[0]!;
    const withoutHip: PoseFrame3DV2 = {
      ...base,
      persons: [
        {
          ...person,
          joints: person.joints.map((joint) =>
            joint.id === 'right_hip'
              ? { ...joint, x: 0, y: 0, z: 0, state: 'missing', cameraIds: [] }
              : joint,
          ),
        },
      ],
    };
    expect(
      (slots.update(withoutHip, views([])).pose3d as Frame3dV1).persons,
    ).toHaveLength(0);
    expect(slots.assignments()).toEqual([{ slotId: 'slot-1', personId: a }]);
  });

  it('uses predicted joints, which are where the person will be when shown', () => {
    const slots = new AvatarPoseSlots(6, 1000);
    const base = frame3d(0, [a]);
    const person = base.persons[0]!;
    const predicted: PoseFrame3DV2 = {
      ...base,
      persons: [
        {
          ...person,
          joints: person.joints.map((joint) => ({
            ...joint,
            x: joint.x + 0.1,
            state: 'predicted' as const,
          })),
        },
      ],
    };
    const keypoints = (slots.update(predicted, views([])).pose3d as Frame3dV1)
      .persons[0]!.keypoints as Array<{ x: number; score: number }>;
    expect(keypoints.every((keypoint) => keypoint.score === 0.9)).toBe(true);
    expect(keypoints[0]?.x).toBeCloseTo(0.1, 10);
  });

  it('refuses slot counts and holds it cannot honour', () => {
    expect(() => new AvatarPoseSlots(0, 1000)).toThrow(/1 through 6/u);
    expect(() => new AvatarPoseSlots(7, 1000)).toThrow(/1 through 6/u);
    expect(() => new AvatarPoseSlots(2, -1)).toThrow(/non-negative/u);
  });
});

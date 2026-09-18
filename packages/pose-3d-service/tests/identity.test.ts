import { describe, expect, it } from 'vitest';

import { PersonIdentities } from '../src/fusion/identity.ts';
import type { FusedPerson } from '../src/fusion/types.ts';
import { COCO_17_KEYPOINT_IDS } from '../src/contracts.ts';

/** A person whose torso centre is at (x, 1, z), seen by the given camera trackers. */
function person(
  x: number,
  z: number,
  views: ReadonlyArray<[string, string]> = [],
): FusedPerson {
  return {
    members: views.map(([cameraId, trackingId]) => ({ cameraId, trackingId })),
    cameraIds: [...new Set(views.map(([cameraId]) => cameraId))],
    score: 0.9,
    meanReprojectionErrorPx: 1,
    keypoints: COCO_17_KEYPOINT_IDS.map((id) => ({
      id,
      point: { x, y: 1, z },
      score: 0.9,
      meanReprojectionErrorPx: 1,
    })),
  };
}

const frame = 33_000;

describe('PersonIdentities', () => {
  it('keeps each person their ID while they move, whatever order they come in', () => {
    const identities = new PersonIdentities();
    expect(identities.assign([person(0, 3), person(3, 3)], 0)).toEqual([
      'person-1',
      'person-2',
    ]);
    expect(
      identities.assign([person(3.05, 3), person(0.05, 3)], frame),
    ).toEqual(['person-2', 'person-1']);
  });

  it('gives a new ID to someone who could not have walked from anyone', () => {
    const identities = new PersonIdentities();
    identities.assign([person(0, 3)], 0);
    expect(identities.assign([person(4, 3)], frame)).toEqual(['person-2']);
  });

  it('lets a camera tracker vouch for a person whose centre jumped', () => {
    const identities = new PersonIdentities();
    identities.assign([person(0, 3, [['camera-1', 'movenet-1']])], 0);
    // 2.5 m in one frame is beyond the reach, but camera-1 still tracks them as movenet-1.
    expect(
      identities.assign([person(2.5, 3, [['camera-1', 'movenet-1']])], frame),
    ).toEqual(['person-1']);
  });

  it('prefers the person a tracker vouches for over a nearer stranger', () => {
    const identities = new PersonIdentities();
    identities.assign([person(0, 3, [['camera-1', 'movenet-1']])], 0);
    expect(
      identities.assign(
        [
          person(0.1, 3, [['camera-2', 'movenet-7']]),
          person(0.6, 3, [['camera-1', 'movenet-1']]),
        ],
        frame,
      ),
    ).toEqual(['person-2', 'person-1']);
  });

  it('holds an ID for a second unseen, then retires it', () => {
    const identities = new PersonIdentities();
    identities.assign([person(0, 3)], 0);
    identities.assign([], 500_000);
    expect(identities.assign([person(0.1, 3)], 900_000)).toEqual(['person-1']);
    identities.assign([], 1_000_000);
    expect(identities.assign([person(0.1, 3)], 2_000_000)).toEqual([
      'person-2',
    ]);
  });

  it('starts again when the clock goes back further than anyone is held', () => {
    const identities = new PersonIdentities();
    identities.assign([person(0, 3)], 5_000_000);
    expect(identities.assign([person(0, 3)], 1_000_000)).toEqual(['person-1']);
    expect(identities.assign([person(9, 3)], 1_033_000)).toEqual(['person-2']);
  });
});

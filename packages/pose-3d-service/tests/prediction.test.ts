import { describe, expect, it } from 'vitest';

import {
  COCO_17_KEYPOINT_IDS,
  type Joint3D,
  type PoseFrame3DPerson,
} from '../src/contracts.ts';
import { JointPrediction } from '../src/fusion/prediction.ts';

/** A person whose every joint is at (x, 1, 3), measured, and `nose` optionally elsewhere. */
function person(x: number, nose?: { x: number }): PoseFrame3DPerson {
  return {
    personId: 'person-1',
    confidence: 0.9,
    identitySource: 'geometry',
    meanReprojectionErrorPx: 1,
    joints: COCO_17_KEYPOINT_IDS.map((id): Joint3D => ({
      id,
      x: id === 'nose' && nose ? nose.x : x,
      y: 1,
      z: 3,
      sigma: 0.01,
      state: 'measured',
      cameraIds: ['camera-1', 'camera-2'],
    })),
  };
}

const step = 33_000;
/** Walking at 1.5 m/s along x, fused every frame from time 0. */
const walk = (prediction: JointPrediction, frames: number) => {
  for (let index = 0; index < frames; index += 1) {
    prediction.apply(
      [person((1.5 * (index * step)) / 1_000_000)],
      index * step,
      null,
    );
  }
};

describe('JointPrediction', () => {
  it('carries a joint moving at constant speed to the instant asked for', () => {
    const prediction = new JointPrediction();
    walk(prediction, 5);
    const fusedUs = 5 * step;
    const result = prediction.apply(
      [person((1.5 * fusedUs) / 1_000_000)],
      fusedUs,
      fusedUs + 100_000,
    );
    expect(result.timestampUs).toBe(fusedUs + 100_000);
    const joint = result.persons[0]!.joints[0]!;
    expect(joint.state).toBe('predicted');
    expect(joint.x).toBeCloseTo((1.5 * (fusedUs + 100_000)) / 1_000_000, 9);
  });

  it('leaves the fused instant alone when no target is asked for, or one already past', () => {
    const prediction = new JointPrediction();
    walk(prediction, 5);
    const fusedUs = 5 * step;
    for (const target of [null, fusedUs - 1]) {
      const result = prediction.apply([person(0.3)], fusedUs, target);
      expect(result.timestampUs).toBe(fusedUs);
      expect(result.persons[0]!.joints[0]).toMatchObject({
        x: 0.3,
        state: 'measured',
      });
    }
  });

  it('does not extrapolate without enough history, or further than 200 ms', () => {
    const prediction = new JointPrediction();
    walk(prediction, 1);
    // One earlier position and this one: two, short of the three a line is fitted to.
    const early = prediction.apply([person(0.05)], step, step + 50_000);
    expect(early.persons[0]!.joints[0]!.state).toBe('measured');

    const walking = new JointPrediction();
    walk(walking, 5);
    const fusedUs = 5 * step;
    const far = walking.apply(
      [person((1.5 * fusedUs) / 1_000_000)],
      fusedUs,
      fusedUs + 900_000,
    );
    expect(far.timestampUs).toBe(fusedUs + 200_000);
    expect(far.persons[0]!.joints[0]!.x).toBeCloseTo(
      (1.5 * (fusedUs + 200_000)) / 1_000_000,
      9,
    );
  });

  it('keeps a joint that strays from its line where it was fused', () => {
    const prediction = new JointPrediction();
    for (let index = 0; index < 5; index += 1) {
      // The nose jumps 20 cm back and forth: a mis-triangulation, not a movement.
      prediction.apply(
        [person(0, { x: index % 2 === 0 ? 0 : 0.2 })],
        index * step,
        null,
      );
    }
    const result = prediction.apply(
      [person(0, { x: 0 })],
      5 * step,
      5 * step + 50_000,
    );
    const nose = result.persons[0]!.joints.find((joint) => joint.id === 'nose');
    expect(nose).toMatchObject({ x: 0, state: 'measured' });
    expect(result.persons[0]!.joints[1]!.state).toBe('predicted');
  });

  it('caps the speed it carries a joint at', () => {
    const prediction = new JointPrediction();
    for (let index = 0; index < 5; index += 1) {
      prediction.apply(
        [person((10 * (index * step)) / 1_000_000)],
        index * step,
        null,
      );
    }
    const fusedUs = 5 * step;
    const start = (10 * fusedUs) / 1_000_000;
    const result = prediction.apply(
      [person(start)],
      fusedUs,
      fusedUs + 100_000,
    );
    expect(result.persons[0]!.joints[0]!.x).toBeCloseTo(start + 3 * 0.1, 9);
  });

  it('learns nothing from a repeated request for the same instant', () => {
    const prediction = new JointPrediction();
    prediction.apply([person(0)], 0, null);
    prediction.apply([person(0)], 0, null);
    prediction.apply([person(0)], 0, null);
    const result = prediction.apply([person(0.05)], step, step + 50_000);
    expect(result.persons[0]!.joints[0]!.state).toBe('measured');
  });
});

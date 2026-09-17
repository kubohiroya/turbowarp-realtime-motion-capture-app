import { describe, expect, it } from 'vitest';

import {
  LIMITS,
  toPoseFrame3DV1,
  validateConfiguration,
  validatePoseFrame2D,
  validatePoseFrame3D,
  validateResponse,
  type PoseFrame3DV2,
} from '../src/contracts.ts';
import { Pose3dService } from '../src/service.ts';
import { configuration, frame } from './fixtures.ts';

function pose3d(): PoseFrame3DV2 {
  const service = new Pose3dService();
  service.handle({
    interface: 'twrmc/pose-3d-service',
    version: 1,
    id: 1,
    type: 'configure',
    payload: configuration(),
  });
  service.handle({
    interface: 'twrmc/pose-3d-service',
    version: 1,
    id: 2,
    type: 'frame2d',
    payload: { cameraId: 'camera-1', frame: frame('camera-1', 'cal-1', 1) },
  });
  service.handle({
    interface: 'twrmc/pose-3d-service',
    version: 1,
    id: 3,
    type: 'frame2d',
    payload: { cameraId: 'camera-2', frame: frame('camera-2', 'cal-2', 1) },
  });
  const answer = service.handle({
    interface: 'twrmc/pose-3d-service',
    version: 1,
    id: 4,
    type: 'requestPose3d',
    payload: { timestampUs: null },
  });
  if (answer?.type !== 'pose3d' || answer.payload === null)
    throw new Error('no frame');
  return answer.payload;
}

describe('validatePoseFrame2D', () => {
  it('accepts a MoveNet frame of version 1', () => {
    expect(validatePoseFrame2D(frame('camera-1', 'cal-1', 0)).ok).toBe(true);
  });

  it('refuses another schema, an unknown version, a non-finite keypoint and too many persons', () => {
    expect(
      validatePoseFrame2D({
        ...frame('camera-1', 'cal-1', 0),
        schema: 'other',
      }),
    ).toMatchObject({ ok: false, code: 'invalid-payload' });
    expect(
      validatePoseFrame2D({ ...frame('camera-1', 'cal-1', 0), version: 3 }),
    ).toMatchObject({ ok: false, code: 'unsupported-version' });
    const broken = frame('camera-1', 'cal-1', 0);
    const person = broken.persons[0];
    if (!person) throw new Error('fixture');
    const keypoints = person.keypoints.map((keypoint, index) =>
      index === 4 ? { ...keypoint, x: Number.NaN } : keypoint,
    );
    expect(
      validatePoseFrame2D({ ...broken, persons: [{ ...person, keypoints }] })
        .ok,
    ).toBe(false);
    expect(
      validatePoseFrame2D(frame('camera-1', 'cal-1', 0, LIMITS.maxPersons + 1))
        .ok,
    ).toBe(false);
  });
});

describe('validateConfiguration', () => {
  it('needs two to eight cameras, each with a distortion model and a 4x4 placement', () => {
    expect(validateConfiguration(configuration()).ok).toBe(true);
    const one = {
      ...configuration(),
      cameras: configuration().cameras.slice(0, 1),
    };
    expect(validateConfiguration(one).ok).toBe(false);
    const cameras = configuration().cameras.map((camera) => ({
      ...camera,
      cameraFromReference: [1, 0, 0],
    }));
    expect(validateConfiguration({ ...configuration(), cameras }).ok).toBe(
      false,
    );
    expect(
      validateConfiguration({
        ...configuration(),
        implementation: 'triangulate-everything',
      }).ok,
    ).toBe(false);
  });
});

describe('validatePoseFrame3D', () => {
  it('accepts the stub service frame', () => {
    expect(validatePoseFrame3D(pose3d()).ok).toBe(true);
  });

  it('refuses a measured joint seen by fewer than two cameras', () => {
    const value = pose3d();
    const person = value.persons[0];
    if (!person) throw new Error('fixture');
    const joints = person.joints.map((joint, index) =>
      index === 0 ? { ...joint, cameraIds: ['camera-1'] } : joint,
    );
    expect(
      validatePoseFrame3D({ ...value, persons: [{ ...person, joints }] }).ok,
    ).toBe(false);
  });

  it('refuses a missing joint that carries a position', () => {
    const value = pose3d();
    const person = value.persons[0];
    if (!person) throw new Error('fixture');
    const joints = person.joints.map((joint, index) =>
      index === 0 ? { ...joint, state: 'missing' as const } : joint,
    );
    expect(
      validatePoseFrame3D({ ...value, persons: [{ ...person, joints }] }).ok,
    ).toBe(false);
  });

  it('refuses duplicate person ids and a truncated skeleton', () => {
    const value = pose3d();
    const person = value.persons[0];
    if (!person) throw new Error('fixture');
    expect(
      validatePoseFrame3D({ ...value, persons: [person, person] }).ok,
    ).toBe(false);
    expect(
      validatePoseFrame3D({
        ...value,
        persons: [{ ...person, joints: person.joints.slice(0, 16) }],
      }).ok,
    ).toBe(false);
  });
});

describe('validateResponse', () => {
  it('refuses another interface, another version and an oversized message', () => {
    expect(
      validateResponse({
        interface: 'other',
        version: 1,
        id: 1,
        type: 'pose3d',
        payload: null,
      }),
    ).toMatchObject({ code: 'unsupported-interface' });
    expect(
      validateResponse({
        interface: 'twrmc/pose-3d-service',
        version: 2,
        id: 1,
        type: 'pose3d',
        payload: null,
      }),
    ).toMatchObject({ code: 'unsupported-version' });
    const huge = {
      interface: 'twrmc/pose-3d-service',
      version: 1,
      id: 1,
      type: 'error',
      payload: { code: 'timeout', message: 'x'.repeat(LIMITS.maxMessageBytes) },
    };
    expect(validateResponse(huge)).toMatchObject({ code: 'payload-too-large' });
  });
});

describe('toPoseFrame3DV1', () => {
  it('produces the avatar version with unmeasured joints at score 0', () => {
    const value = pose3d();
    const person = value.persons[0];
    if (!person) throw new Error('fixture');
    const joints = person.joints.map((joint, index) =>
      index === 3 ? { ...joint, state: 'predicted' as const } : joint,
    );
    const v1 = toPoseFrame3DV1({
      ...value,
      persons: [{ ...person, joints }],
    }) as {
      version: number;
      persons: Array<{
        cameraIds: string[];
        keypoints: Array<{ score: number }>;
      }>;
    };
    expect(v1.version).toBe(1);
    expect(v1.persons[0]?.cameraIds).toEqual(['camera-1', 'camera-2']);
    expect(v1.persons[0]?.keypoints[3]?.score).toBe(0);
    expect(v1.persons[0]?.keypoints[4]?.score).toBe(person.confidence);
  });
});

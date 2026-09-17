import { describe, expect, it } from 'vitest';

import {
  COCO_17_KEYPOINT_IDS,
  request,
  validateResponse,
  type PoseFrame3DV2,
  type ServiceCamera,
} from '../src/contracts.ts';
import {
  createCameraModel,
  normalizedFromPixel,
  pixelFromNormalized,
  projectPoint,
  triangulate,
} from '../src/fusion/geometry.ts';
import { FusionEstimator } from '../src/fusion/estimator.ts';
import { evaluate } from '../src/metrics.ts';
import { replaySession } from '../src/replay.ts';
import { Pose3dService } from '../src/service.ts';
import { generateScene } from '../src/synthetic.ts';

const camera = (
  cameraId: string,
  cameraFromReference: number[],
  coefficients: number[] = [],
): ServiceCamera => ({
  cameraId,
  model: {
    intrinsics: { fx: 900, fy: 900, cx: 639.5, cy: 359.5, skew: 0 },
    distortion: {
      model: coefficients.length === 0 ? 'none' : 'brown-conrady',
      coefficients,
    },
    intrinsicProfileId: `cal-${cameraId}`,
    imageWidth: 1280,
    imageHeight: 720,
  },
  cameraFromReference,
  timeCorrespondence: null,
});

/** Looking straight down +z from the origin, and the same shifted a metre to the right. */
const straight = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const shifted = [1, 0, 0, -1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe('camera models', () => {
  it('takes the placement as it is, without inverting it', () => {
    const model = createCameraModel(camera('camera-1', shifted));
    const projected = projectPoint(model, { x: 1, y: 0, z: 4 });
    // A point a metre to the right of the origin is straight ahead of a camera a metre to the right.
    expect(projected?.x).toBeCloseTo(639.5, 6);
    expect(projected?.y).toBeCloseTo(359.5, 6);
  });

  it('undistorts a pixel back to where it was distorted from', () => {
    const model = createCameraModel(
      camera('camera-1', straight, [0.12, -0.03, 0.001, -0.002, 0.004]),
    );
    const pixel = pixelFromNormalized(model, 0.31, -0.18);
    const normalized = normalizedFromPixel(model, pixel.x, pixel.y);
    expect(normalized.x).toBeCloseTo(0.31, 6);
    expect(normalized.y).toBeCloseTo(-0.18, 6);
  });

  it('triangulates a point two cameras agree on', () => {
    const left = createCameraModel(camera('camera-1', straight));
    const right = createCameraModel(camera('camera-2', shifted));
    const truth = { x: 0.4, y: -0.2, z: 3.5 };
    const observations = [left, right].map((model) => {
      const pixel = projectPoint(model, truth);
      const normalized = normalizedFromPixel(
        model,
        pixel?.x ?? 0,
        pixel?.y ?? 0,
      );
      return {
        model,
        x: normalized.x,
        y: normalized.y,
        pixelX: pixel?.x ?? 0,
        pixelY: pixel?.y ?? 0,
        score: 0.9,
      };
    });
    const point = triangulate(observations);
    expect(point?.x).toBeCloseTo(truth.x, 6);
    expect(point?.y).toBeCloseTo(truth.y, 6);
    expect(point?.z).toBeCloseTo(truth.z, 6);
  });

  it('refuses a placement that is not a rigid transform', () => {
    expect(() =>
      createCameraModel(
        camera('camera-1', [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      ),
    ).toThrow();
    expect(() => createCameraModel(camera('camera-1', [1, 0, 0, 0]))).toThrow();
  });
});

describe('fusion-v0', () => {
  it('estimates the synthetic people to within centimetres', () => {
    const { session } = generateScene({ seconds: 3, cameras: 4, persons: 3 });
    const metrics = evaluate(
      session,
      replaySession(session, { implementation: 'fusion-v0' }),
    );
    expect(metrics.implementation).toBe('fusion-v0');
    expect(metrics.truth?.jointErrorMeters.p50).toBeLessThan(0.03);
    expect(metrics.truth?.jointErrorMeters.p95).toBeLessThan(0.15);
    expect(metrics.truth?.jointRecall).toBeGreaterThan(0.95);
    expect(metrics.truth?.personCountError.mean).toBeLessThan(0.5);
    expect(metrics.errors).toBe(0);
  });

  it('is far better than the stub it replaces, on the same input', () => {
    const { session } = generateScene({ seconds: 2, cameras: 3, persons: 2 });
    const fusion = evaluate(
      session,
      replaySession(session, { implementation: 'fusion-v0' }),
    );
    const stub = evaluate(
      session,
      replaySession(session, { implementation: 'stub-normal' }),
    );
    expect(fusion.truth?.jointErrorMeters.p50 ?? 1).toBeLessThan(
      (stub.truth?.jointErrorMeters.p50 ?? 0) / 10,
    );
  });

  it('marks a joint only one camera saw as missing, and names the cameras behind one it kept', () => {
    const { session } = generateScene({ seconds: 2, cameras: 3, persons: 2 });
    const replay = replaySession(session, { implementation: 'fusion-v0' });
    const frames = replay.answers
      .map((answer) => answer.frame)
      .filter((frame): frame is PoseFrame3DV2 => frame !== null);
    const joints = frames.flatMap((frame) =>
      frame.persons.flatMap((person) => person.joints),
    );
    expect(joints.some((joint) => joint.state === 'missing')).toBe(true);
    for (const joint of joints) {
      if (joint.state === 'missing') {
        expect([joint.x, joint.y, joint.z, joint.sigma]).toEqual([0, 0, 0, 0]);
        continue;
      }
      expect(joint.state).toBe('measured');
      expect(joint.cameraIds.length).toBeGreaterThanOrEqual(2);
      expect(joint.sigma).toBeGreaterThan(0);
    }
  });

  it('answers nothing until two cameras have shown the same person', () => {
    const { session } = generateScene({ seconds: 1, cameras: 3, persons: 1 });
    const estimator = new FusionEstimator();
    estimator.configure(session.configuration);
    expect(estimator.estimate(null)).toBeNull();

    const firstCamera = session.events.find(
      (event) => event.type === 'frame2d' && event.cameraId === 'camera-1',
    );
    if (firstCamera?.type !== 'frame2d') throw new Error('no frame');
    estimator.accept(firstCamera.frame);
    expect(estimator.estimate(null)).toBeNull();
    expect(estimator.status()).toMatchObject({ cameras: 3, acceptedFrames: 1 });
  });

  it('refuses a configuration it cannot build a camera model from', () => {
    const service = new Pose3dService();
    const broken = {
      implementation: 'fusion-v0' as const,
      referenceId: 'venue',
      cameras: [
        camera('camera-1', straight),
        { ...camera('camera-2', shifted), cameraFromReference: [1, 2, 3] },
      ],
    };
    const answer = validateResponse(
      service.handle(request(1, 'configure', broken)),
    );
    expect(answer.ok && answer.value.type).toBe('error');
    // And nothing was configured, so a frame afterwards is refused rather than fused.
    const frames = validateResponse(
      service.handle(
        request(2, 'frame2d', { cameraId: 'camera-1', frame: {} as never }),
      ),
    );
    expect(
      answer.ok &&
        frames.ok &&
        frames.value.type === 'error' &&
        frames.value.payload.code,
    ).toBe('not-configured');
  });

  it('keeps every COCO-17 joint in order, present or not', () => {
    const { session } = generateScene({ seconds: 1, cameras: 3, persons: 1 });
    const replay = replaySession(session, { implementation: 'fusion-v0' });
    const frame = replay.answers
      .map((answer) => answer.frame)
      .find((candidate): candidate is PoseFrame3DV2 => candidate !== null);
    expect(frame?.persons[0]?.joints.map((joint) => joint.id)).toEqual([
      ...COCO_17_KEYPOINT_IDS,
    ]);
    expect(frame?.implementation).toBe('fusion-v0');
  });
});

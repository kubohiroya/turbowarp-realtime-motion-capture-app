import {
  COCO_17_KEYPOINT_IDS,
  type ImplementationId,
  type PoseFrame2D,
  type ServiceConfiguration,
} from '../src/contracts.js';

export const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 3, 0, 0, 0, 1];

export function model(profileId: string) {
  return {
    intrinsics: { fx: 1000, fy: 1000, cx: 640, cy: 360, skew: 0 },
    distortion: {
      model: 'brown-conrady',
      coefficients: [0.01, -0.002, 0, 0, 0],
    },
    intrinsicProfileId: profileId,
    imageWidth: 1280,
    imageHeight: 720,
  };
}

export function configuration(
  implementation: ImplementationId = 'stub-normal',
): ServiceConfiguration {
  return {
    implementation,
    referenceId: 'venue-projection',
    cameras: [
      {
        cameraId: 'camera-1',
        model: model('cal-1'),
        cameraFromReference: identity,
        timeCorrespondence: null,
      },
      {
        cameraId: 'camera-2',
        model: model('cal-2'),
        cameraFromReference: identity,
        timeCorrespondence: null,
      },
    ],
  };
}

export function frame(
  peerId: string,
  calibrationId: string,
  sequence: number,
  persons = 2,
): PoseFrame2D {
  return {
    schema: 'twrmc/pose-frame-2d',
    version: 1,
    cameraId: 'pose',
    peerId,
    sequence,
    captureTimestampUs: 1_789_000_000_000_000 + sequence * 33_333,
    frameWidth: 1280,
    frameHeight: 720,
    calibrationId,
    persons: Array.from({ length: persons }, (_, index) => ({
      trackingId: `movenet-${index + 1}`,
      score: 0.9,
      keypoints: COCO_17_KEYPOINT_IDS.map((id, keypoint) => ({
        id,
        x: 0.4 + index * 0.1,
        y: 0.2 + keypoint * 0.03,
        score: 0.8,
      })),
    })),
  };
}

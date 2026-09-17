import type { Coco17KeypointId } from '../contracts.ts';

/** One temporally resampled COCO-17 keypoint of one tracked person. */
export interface SynchronizedKeypoint2D {
  id: Coco17KeypointId;
  x: number;
  y: number;
  score: number;
  /** True when x, y, or score came from temporal interpolation or occlusion fill. */
  filled: boolean;
}

export interface SynchronizedPerson2D {
  trackingId: string;
  score: number;
  keypoints: SynchronizedKeypoint2D[];
  /** Glow stick observations carried by PoseFrame2D v2, empty for v1. */
}

/** One camera's contribution to a single synchronized instant. */
export interface SynchronizedCameraSample {
  cameraId: string;
  calibrationId: string;
  frameWidth: number;
  frameHeight: number;
  /** Buffered frame timestamps that produced this sample. */
  previousTimestampUs: number;
  nextTimestampUs: number;
  /** 0 when the sample equals the previous frame, 1 when it equals the next one. */
  alpha: number;
  /** True when no buffered frame matched the requested instant exactly. */
  interpolated: boolean;
  persons: SynchronizedPerson2D[];
}

export interface SynchronizedPoseSample {
  timestampUs: number;
  cameras: SynchronizedCameraSample[];
}

/** Rigid camera model derived from one configured service camera. */
export interface CameraModel {
  cameraId: string;
  calibrationId: string;
  imageWidth: number;
  imageHeight: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  skew: number;
  /** k1, k2, p1, p2, k3, k4, k5, k6 in OpenCV order, zero padded. */
  distortion: number[];
  /** Row-major reference-to-camera rotation. */
  rotation: number[];
  /** Reference-to-camera translation. */
  translation: number[];
}

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface KeypointObservation {
  model: CameraModel;
  /** Undistorted normalized image coordinates. */
  x: number;
  y: number;
  /** Original distorted pixel coordinates, kept for reprojection error. */
  pixelX: number;
  pixelY: number;
  score: number;
}

export interface TriangulatedKeypoint {
  point: Vector3;
  score: number;
  meanReprojectionErrorPx: number;
  cameraIds: string[];
}

export interface FusedPersonMember {
  cameraId: string;
  trackingId: string;
}

export interface FusedPerson {
  members: FusedPersonMember[];
  cameraIds: string[];
  score: number;
  meanReprojectionErrorPx: number;
  keypoints: Array<{
    id: Coco17KeypointId;
    point: Vector3 | undefined;
    score: number;
    meanReprojectionErrorPx: number;
  }>;
}

import type { ServiceCamera } from '../contracts.ts';
import type { CameraModel, KeypointObservation, Vector3 } from './types.ts';

const SUPPORTED_DISTORTION_LENGTHS = new Set([0, 4, 5, 8]);
const ORTHONORMAL_TOLERANCE = 1e-3;
const UNDISTORT_ITERATIONS = 20;
const MINIMUM_DEPTH = 1e-6;

/**
 * The projection model of one configured camera.
 *
 * The placement solve already gives reference-to-camera, so nothing is inverted here. Distortion
 * coefficients travel in OpenCV order and are zero padded, so a profile with none projects as a
 * pinhole camera rather than being refused.
 */
export function createCameraModel(camera: ServiceCamera): CameraModel {
  const { intrinsics } = camera.model;
  const { fx, fy, cx, cy, skew } = intrinsics;
  if (
    !(fx > 0) ||
    !(fy > 0) ||
    !isFiniteNumber(cx) ||
    !isFiniteNumber(cy) ||
    !isFiniteNumber(skew)
  ) {
    throw new Error(
      `Camera ${camera.cameraId} needs finite intrinsics with positive focal lengths.`,
    );
  }
  const coefficients = camera.model.distortion.coefficients;
  if (!SUPPORTED_DISTORTION_LENGTHS.has(coefficients.length)) {
    throw new Error(
      `Camera ${camera.cameraId} must carry 0, 4, 5 or 8 OpenCV distortion coefficients.`,
    );
  }
  const distortion = Array.from(
    { length: 8 },
    (_, index) => coefficients[index] ?? 0,
  );
  if (!distortion.every(isFiniteNumber)) {
    throw new Error(
      `Camera ${camera.cameraId} distortion coefficients must be finite.`,
    );
  }
  const matrix = camera.cameraFromReference;
  if (matrix.length !== 16 || !matrix.every(isFiniteNumber)) {
    throw new Error(
      `Camera ${camera.cameraId} needs a 16 number cameraFromReference.`,
    );
  }
  for (const [index, expected] of [
    [12, 0],
    [13, 0],
    [14, 0],
    [15, 1],
  ] as const) {
    if (Math.abs(element(matrix, index) - expected) > 1e-6) {
      throw new Error(
        `Camera ${camera.cameraId} cameraFromReference must be an affine transform.`,
      );
    }
  }
  const rotation = [0, 1, 2, 4, 5, 6, 8, 9, 10].map((index) =>
    element(matrix, index),
  );
  const translation = [3, 7, 11].map((index) => element(matrix, index));
  requireOrthonormal(rotation);

  return {
    cameraId: camera.cameraId,
    calibrationId: camera.model.intrinsicProfileId,
    imageWidth: camera.model.imageWidth,
    imageHeight: camera.model.imageHeight,
    fx,
    fy,
    cx,
    cy,
    skew,
    distortion,
    rotation,
    translation,
  };
}

/** Applies the OpenCV rational distortion model to normalized coordinates. */
export function distortNormalized(
  model: CameraModel,
  x: number,
  y: number,
): { x: number; y: number } {
  const [k1, k2, p1, p2, k3, k4, k5, k6] = distortionCoefficients(model);
  const r2 = x * x + y * y;
  const r4 = r2 * r2;
  const r6 = r4 * r2;
  const denominator = 1 + k4 * r2 + k5 * r4 + k6 * r6;
  const radial =
    denominator === 0 ? 1 : (1 + k1 * r2 + k2 * r4 + k3 * r6) / denominator;
  return {
    x: x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x),
    y: y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y,
  };
}

export function pixelFromNormalized(
  model: CameraModel,
  x: number,
  y: number,
): { x: number; y: number } {
  const distorted = distortNormalized(model, x, y);
  return {
    x: model.fx * distorted.x + model.skew * distorted.y + model.cx,
    y: model.fy * distorted.y + model.cy,
  };
}

/** Removes intrinsics and distortion from one observed pixel. */
export function normalizedFromPixel(
  model: CameraModel,
  pixelX: number,
  pixelY: number,
): { x: number; y: number } {
  const [k1, k2, p1, p2, k3, k4, k5, k6] = distortionCoefficients(model);
  const observedY = (pixelY - model.cy) / model.fy;
  const observedX = (pixelX - model.cx - model.skew * observedY) / model.fx;
  let x = observedX;
  let y = observedY;
  for (let iteration = 0; iteration < UNDISTORT_ITERATIONS; iteration += 1) {
    const r2 = x * x + y * y;
    const r4 = r2 * r2;
    const r6 = r4 * r2;
    const numerator = 1 + k1 * r2 + k2 * r4 + k3 * r6;
    if (numerator === 0) break;
    const inverseRadial = (1 + k4 * r2 + k5 * r4 + k6 * r6) / numerator;
    const tangentialX = 2 * p1 * x * y + p2 * (r2 + 2 * x * x);
    const tangentialY = p1 * (r2 + 2 * y * y) + 2 * p2 * x * y;
    x = (observedX - tangentialX) * inverseRadial;
    y = (observedY - tangentialY) * inverseRadial;
  }
  return { x, y };
}

/** Projects a reference point into one camera, or returns undefined behind it. */
export function projectPoint(
  model: CameraModel,
  point: Vector3,
): { x: number; y: number } | undefined {
  const camera = multiplyRotation(model.rotation, [point.x, point.y, point.z]);
  const x = element(camera, 0) + element(model.translation, 0);
  const y = element(camera, 1) + element(model.translation, 1);
  const z = element(camera, 2) + element(model.translation, 2);
  if (!(z > MINIMUM_DEPTH)) return undefined;
  return pixelFromNormalized(model, x / z, y / z);
}

export function depthOf(model: CameraModel, point: Vector3): number {
  const camera = multiplyRotation(model.rotation, [point.x, point.y, point.z]);
  return element(camera, 2) + element(model.translation, 2);
}

/**
 * Score-weighted linear triangulation. Observations are undistorted normalized
 * coordinates, so the projection rows are the pure rigid transform.
 */
export function triangulate(
  observations: readonly KeypointObservation[],
): Vector3 | undefined {
  if (observations.length < 2) return undefined;
  if (observations.length === 2) {
    const [first, second] = observations;
    if (first && second) return triangulateTwoViews(first, second);
  }
  const normal = new Array<number>(16).fill(0);
  for (const observation of observations) {
    const rotation = observation.model.rotation;
    const translation = observation.model.translation;
    const rows: number[][] = [];
    for (const axis of [0, 1] as const) {
      const image = axis === 0 ? observation.x : observation.y;
      rows.push([
        image * element(rotation, 6) - element(rotation, axis * 3),
        image * element(rotation, 7) - element(rotation, axis * 3 + 1),
        image * element(rotation, 8) - element(rotation, axis * 3 + 2),
        image * element(translation, 2) - element(translation, axis),
      ]);
    }
    const weight = Math.max(observation.score, 1e-3);
    for (const row of rows) {
      for (let i = 0; i < 4; i += 1) {
        for (let j = 0; j < 4; j += 1) {
          normal[i * 4 + j] =
            element(normal, i * 4 + j) +
            weight * weight * element(row, i) * element(row, j);
        }
      }
    }
  }
  const solution = smallestEigenvector4(normal);
  const w = element(solution, 3);
  if (Math.abs(w) < 1e-12) return undefined;
  const point = {
    x: element(solution, 0) / w,
    y: element(solution, 1) / w,
    z: element(solution, 2) / w,
  };
  if (
    !isFiniteNumber(point.x) ||
    !isFiniteNumber(point.y) ||
    !isFiniteNumber(point.z)
  ) {
    return undefined;
  }
  return point;
}

/**
 * Closed-form two-view triangulation: the midpoint of the shortest segment
 * between both viewing rays. Two rays carry no redundancy to weight, so this
 * replaces the iterative solver on the hot association path.
 */
function triangulateTwoViews(
  first: KeypointObservation,
  second: KeypointObservation,
): Vector3 | undefined {
  const firstCenter = cameraCenter(first.model);
  const secondCenter = cameraCenter(second.model);
  const firstRay = rayDirection(first.model, first.x, first.y);
  const secondRay = rayDirection(second.model, second.x, second.y);
  const between = [
    element(firstCenter, 0) - element(secondCenter, 0),
    element(firstCenter, 1) - element(secondCenter, 1),
    element(firstCenter, 2) - element(secondCenter, 2),
  ];
  const rayDot = dot(firstRay, secondRay);
  const denominator = 1 - rayDot * rayDot;
  if (Math.abs(denominator) < 1e-12) return undefined;
  const firstOffset = dot(firstRay, between);
  const secondOffset = dot(secondRay, between);
  const firstDepth = (rayDot * secondOffset - firstOffset) / denominator;
  const secondDepth = (secondOffset - rayDot * firstOffset) / denominator;
  const point = {
    x:
      (element(firstCenter, 0) +
        firstDepth * element(firstRay, 0) +
        element(secondCenter, 0) +
        secondDepth * element(secondRay, 0)) /
      2,
    y:
      (element(firstCenter, 1) +
        firstDepth * element(firstRay, 1) +
        element(secondCenter, 1) +
        secondDepth * element(secondRay, 1)) /
      2,
    z:
      (element(firstCenter, 2) +
        firstDepth * element(firstRay, 2) +
        element(secondCenter, 2) +
        secondDepth * element(secondRay, 2)) /
      2,
  };
  if (
    !isFiniteNumber(point.x) ||
    !isFiniteNumber(point.y) ||
    !isFiniteNumber(point.z)
  ) {
    return undefined;
  }
  return point;
}

/** Camera position in world coordinates. */
function cameraCenter(model: CameraModel): number[] {
  return transposedRotationTimes(model.rotation, model.translation).map(
    (value) => -value,
  );
}

/** Unit viewing ray of one normalized observation in world coordinates. */
function rayDirection(model: CameraModel, x: number, y: number): number[] {
  const direction = transposedRotationTimes(model.rotation, [x, y, 1]);
  const length = Math.hypot(
    element(direction, 0),
    element(direction, 1),
    element(direction, 2),
  );
  if (length === 0) return [0, 0, 1];
  return direction.map((value) => value / length);
}

function transposedRotationTimes(
  rotation: readonly number[],
  vector: readonly number[],
): number[] {
  return [0, 1, 2].map(
    (row) =>
      element(rotation, row) * element(vector, 0) +
      element(rotation, row + 3) * element(vector, 1) +
      element(rotation, row + 6) * element(vector, 2),
  );
}

function dot(left: readonly number[], right: readonly number[]): number {
  return (
    element(left, 0) * element(right, 0) +
    element(left, 1) * element(right, 1) +
    element(left, 2) * element(right, 2)
  );
}

/** Mean pixel distance between the reprojected point and every observation. */
export function meanReprojectionError(
  point: Vector3,
  observations: readonly KeypointObservation[],
): number | undefined {
  let total = 0;
  for (const observation of observations) {
    const projected = projectPoint(observation.model, point);
    if (!projected) return undefined;
    total += Math.hypot(
      projected.x - observation.pixelX,
      projected.y - observation.pixelY,
    );
  }
  return observations.length === 0 ? undefined : total / observations.length;
}

/** Cyclic Jacobi eigenvalue decomposition of a symmetric 4 by 4 matrix. */
function smallestEigenvector4(matrix: readonly number[]): number[] {
  const a = matrix.slice();
  const v = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  let scale = 0;
  for (let index = 0; index < 4; index += 1) {
    scale += element(a, index * 4 + index) ** 2;
  }
  // Relative threshold: an absolute one never fires for well-scaled systems and
  // would always spend the full sweep budget.
  const converged = Math.max(scale, 1e-300) * 1e-24;
  for (let sweep = 0; sweep < 32; sweep += 1) {
    let off = 0;
    for (let p = 0; p < 3; p += 1) {
      for (let q = p + 1; q < 4; q += 1) off += element(a, p * 4 + q) ** 2;
    }
    if (off < converged) break;
    for (let p = 0; p < 3; p += 1) {
      for (let q = p + 1; q < 4; q += 1) {
        const apq = element(a, p * 4 + q);
        if (Math.abs(apq) < 1e-18) continue;
        const theta =
          (element(a, q * 4 + q) - element(a, p * 4 + p)) / (2 * apq);
        const sign = theta >= 0 ? 1 : -1;
        const t = sign / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 4; k += 1) {
          const akp = element(a, k * 4 + p);
          const akq = element(a, k * 4 + q);
          a[k * 4 + p] = c * akp - s * akq;
          a[k * 4 + q] = s * akp + c * akq;
        }
        for (let k = 0; k < 4; k += 1) {
          const apk = element(a, p * 4 + k);
          const aqk = element(a, q * 4 + k);
          a[p * 4 + k] = c * apk - s * aqk;
          a[q * 4 + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 4; k += 1) {
          const vkp = element(v, k * 4 + p);
          const vkq = element(v, k * 4 + q);
          v[k * 4 + p] = c * vkp - s * vkq;
          v[k * 4 + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let index = 1; index < 4; index += 1) {
    if (element(a, index * 4 + index) < element(a, best * 4 + best)) {
      best = index;
    }
  }
  return [0, 1, 2, 3].map((row) => element(v, row * 4 + best));
}

function requireOrthonormal(rotation: readonly number[]): void {
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      let dot = 0;
      for (let k = 0; k < 3; k += 1) {
        dot += element(rotation, k * 3 + i) * element(rotation, k * 3 + j);
      }
      const expected = i === j ? 1 : 0;
      if (Math.abs(dot - expected) > ORTHONORMAL_TOLERANCE) {
        throw new Error(
          'worldFromCameraMatrix rotation must be orthonormal within 1e-3.',
        );
      }
    }
  }
  const determinant =
    element(rotation, 0) *
      (element(rotation, 4) * element(rotation, 8) -
        element(rotation, 5) * element(rotation, 7)) -
    element(rotation, 1) *
      (element(rotation, 3) * element(rotation, 8) -
        element(rotation, 5) * element(rotation, 6)) +
    element(rotation, 2) *
      (element(rotation, 3) * element(rotation, 7) -
        element(rotation, 4) * element(rotation, 6));
  if (Math.abs(determinant - 1) > ORTHONORMAL_TOLERANCE) {
    throw new Error(
      'worldFromCameraMatrix rotation must be a right-handed rotation.',
    );
  }
}

function multiplyRotation(
  rotation: readonly number[],
  vector: readonly number[],
): number[] {
  return [0, 1, 2].map(
    (row) =>
      element(rotation, row * 3) * element(vector, 0) +
      element(rotation, row * 3 + 1) * element(vector, 1) +
      element(rotation, row * 3 + 2) * element(vector, 2),
  );
}

type DistortionTuple = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

function distortionCoefficients(model: CameraModel): DistortionTuple {
  const d = model.distortion;
  return [
    d[0] ?? 0,
    d[1] ?? 0,
    d[2] ?? 0,
    d[3] ?? 0,
    d[4] ?? 0,
    d[5] ?? 0,
    d[6] ?? 0,
    d[7] ?? 0,
  ];
}

function element(values: readonly number[], index: number): number {
  return values[index] ?? 0;
}

function isFiniteNumber(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

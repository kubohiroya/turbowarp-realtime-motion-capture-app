import { COCO_17_KEYPOINT_IDS } from '../contracts.ts';
import type { Coco17KeypointId } from '../contracts.ts';
import {
  depthOf,
  meanReprojectionError,
  normalizedFromPixel,
  triangulate,
} from './geometry.ts';
import type {
  CameraModel,
  FusedPerson,
  FusedPersonMember,
  KeypointObservation,
  SynchronizedPoseSample,
  Vector3,
} from './types.ts';

export interface FusionGeometryOptions {
  /** Keypoints below this score never enter triangulation. */
  minKeypointScore: number;
  /** Shared visible keypoints required to consider two views the same person. */
  minSharedKeypoints: number;
  /** Reprojection error that rejects a match or a fused keypoint. */
  maxReprojectionErrorPx: number;
  /** Cameras required before a cluster becomes a 3D person. */
  minCamerasPerPerson: number;
  maxPersons: number;
}

export const DEFAULT_FUSION_GEOMETRY_OPTIONS: FusionGeometryOptions = {
  minKeypointScore: 0.3,
  minSharedKeypoints: 4,
  maxReprojectionErrorPx: 25,
  minCamerasPerPerson: 2,
  maxPersons: 6,
};

const COORDINATE_LIMIT = 1_000_000;
/** Shared keypoints that already decide one person-pair cost. */
const MAX_PAIR_KEYPOINTS = 12;

interface FusedKeypoint {
  point: Vector3;
  score: number;
  error: number;
}

interface PersonView {
  cameraId: string;
  trackingId: string;
  model: CameraModel;
  observations: Map<Coco17KeypointId, KeypointObservation>;
}

/**
 * Associates the tracked persons of a synchronized instant across cameras and
 * triangulates every COCO-17 keypoint of each multi-camera cluster.
 */
export function fuseSynchronizedSample(
  sample: SynchronizedPoseSample,
  models: ReadonlyMap<string, CameraModel>,
  options: FusionGeometryOptions,
): FusedPerson[] {
  const views = collectViews(sample, models, options.minKeypointScore);
  const clusters = associateViews(views, options);
  const persons: FusedPerson[] = [];
  for (const cluster of clusters) {
    const cameraIds = [
      ...new Set(cluster.map((index) => views[index]?.cameraId ?? '')),
    ]
      .filter((cameraId) => cameraId.length > 0)
      .sort();
    if (cameraIds.length < options.minCamerasPerPerson) continue;
    const clusterViews = cluster
      .map((index) => views[index])
      .filter((view): view is PersonView => view !== undefined);
    persons.push(fuseCluster(clusterViews, cameraIds, options));
  }
  return persons
    .sort((left, right) => right.score - left.score)
    .slice(0, options.maxPersons);
}

function collectViews(
  sample: SynchronizedPoseSample,
  models: ReadonlyMap<string, CameraModel>,
  minKeypointScore: number,
): PersonView[] {
  const views: PersonView[] = [];
  for (const camera of sample.cameras) {
    const model = models.get(camera.cameraId);
    if (!model) continue;
    for (const person of camera.persons) {
      const observations = new Map<Coco17KeypointId, KeypointObservation>();
      for (const keypoint of person.keypoints) {
        if (keypoint.score < minKeypointScore) continue;
        const normalized = normalizedFromPixel(model, keypoint.x, keypoint.y);
        observations.set(keypoint.id, {
          model,
          x: normalized.x,
          y: normalized.y,
          pixelX: keypoint.x,
          pixelY: keypoint.y,
          score: keypoint.score,
        });
      }
      views.push({
        cameraId: camera.cameraId,
        trackingId: person.trackingId,
        model,
        observations,
      });
    }
  }
  return views;
}

/** Greedy lowest-cost clustering with at most one view per camera per person. */
function associateViews(
  views: readonly PersonView[],
  options: FusionGeometryOptions,
): number[][] {
  const pairs: Array<{ left: number; right: number; cost: number }> = [];
  for (let left = 0; left < views.length; left += 1) {
    for (let right = left + 1; right < views.length; right += 1) {
      const first = views[left];
      const second = views[right];
      if (!first || !second || first.cameraId === second.cameraId) continue;
      const cost = pairCost(first, second, options);
      if (cost === undefined) continue;
      pairs.push({ left, right, cost });
    }
  }
  pairs.sort((first, second) => first.cost - second.cost);

  const parent = views.map((_, index) => index);
  const cameras = views.map((view) => new Set([view.cameraId]));
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root] ?? root;
    return root;
  };
  const merge = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    const leftCameras = cameras[leftRoot];
    const rightCameras = cameras[rightRoot];
    if (!leftCameras || !rightCameras) return;
    for (const cameraId of rightCameras) {
      if (leftCameras.has(cameraId)) return;
    }
    parent[rightRoot] = leftRoot;
    for (const cameraId of rightCameras) leftCameras.add(cameraId);
  };

  for (const pair of pairs) merge(pair.left, pair.right);

  const clusters = new Map<number, number[]>();
  for (let index = 0; index < views.length; index += 1) {
    const root = find(index);
    const cluster = clusters.get(root) ?? [];
    cluster.push(index);
    clusters.set(root, cluster);
  }
  return [...clusters.values()];
}

/**
 * Mean two-view reprojection error over the shared visible keypoints. The scan
 * stops once enough evidence is collected and gives up as soon as too few
 * keypoints remain, because this runs for every cross-camera person pair.
 */
function pairCost(
  left: PersonView,
  right: PersonView,
  options: FusionGeometryOptions,
): number | undefined {
  let total = 0;
  let shared = 0;
  for (const [index, keypointId] of COCO_17_KEYPOINT_IDS.entries()) {
    if (shared >= MAX_PAIR_KEYPOINTS) break;
    const remaining = COCO_17_KEYPOINT_IDS.length - index;
    if (shared + remaining < options.minSharedKeypoints) return undefined;
    const first = left.observations.get(keypointId);
    const second = right.observations.get(keypointId);
    if (!first || !second) continue;
    const point = triangulate([first, second]);
    if (!point || !inFrontOfAll(point, [first, second])) continue;
    const error = meanReprojectionError(point, [first, second]);
    if (error === undefined) continue;
    total += error;
    shared += 1;
  }
  if (shared < options.minSharedKeypoints) return undefined;
  const cost = total / shared;
  return cost <= options.maxReprojectionErrorPx ? cost : undefined;
}

function fuseCluster(
  views: readonly PersonView[],
  cameraIds: readonly string[],
  options: FusionGeometryOptions,
): FusedPerson {
  const members: FusedPersonMember[] = views
    .map((view) => ({ cameraId: view.cameraId, trackingId: view.trackingId }))
    .sort((left, right) => left.cameraId.localeCompare(right.cameraId));
  const keypoints = COCO_17_KEYPOINT_IDS.map((keypointId) => {
    const observations = views
      .map((view) => view.observations.get(keypointId))
      .filter(
        (observation): observation is KeypointObservation =>
          observation !== undefined,
      );
    const fused = fuseKeypoint(observations, options);
    return {
      id: keypointId,
      point: fused?.point,
      score: fused?.score ?? 0,
      meanReprojectionErrorPx: fused?.error ?? 0,
    };
  });
  const fusedKeypoints = keypoints.filter((keypoint) => keypoint.point);
  const meanError =
    fusedKeypoints.length === 0
      ? 0
      : fusedKeypoints.reduce(
          (total, keypoint) => total + keypoint.meanReprojectionErrorPx,
          0,
        ) / fusedKeypoints.length;
  const score =
    keypoints.reduce((total, keypoint) => total + keypoint.score, 0) /
    COCO_17_KEYPOINT_IDS.length;
  return {
    members,
    cameraIds: [...cameraIds],
    score: clampScore(score),
    meanReprojectionErrorPx: meanError,
    keypoints,
  };
}

/**
 * Triangulates one keypoint from every confident view. When the full set does
 * not agree, the largest two-view consensus set wins, so a minority of wrong
 * detections is discarded instead of dragging the point away from the truth.
 */
function fuseKeypoint(
  observations: readonly KeypointObservation[],
  options: FusionGeometryOptions,
): FusedKeypoint | undefined {
  if (observations.length < 2) return undefined;
  const agreed = evaluateViews(observations, options);
  if (agreed) return agreed;
  if (observations.length === 2) return undefined;

  let best: { result: FusedKeypoint; inliers: number } | undefined;
  for (let left = 0; left < observations.length; left += 1) {
    for (let right = left + 1; right < observations.length; right += 1) {
      const first = observations[left];
      const second = observations[right];
      if (!first || !second) continue;
      const seed = triangulate([first, second]);
      if (!seed || !withinBounds(seed)) continue;
      const inliers = observations.filter((observation) => {
        if (depthOf(observation.model, seed) <= 0) return false;
        const error = meanReprojectionError(seed, [observation]);
        return error !== undefined && error <= options.maxReprojectionErrorPx;
      });
      if (inliers.length < 2) continue;
      const result = evaluateViews(inliers, options);
      if (!result) continue;
      if (
        !best ||
        inliers.length > best.inliers ||
        (inliers.length === best.inliers && result.error < best.result.error)
      ) {
        best = { result, inliers: inliers.length };
      }
    }
  }
  return best?.result;
}

/** Triangulates one view set and rejects it unless every view agrees. */
function evaluateViews(
  views: readonly KeypointObservation[],
  options: FusionGeometryOptions,
): FusedKeypoint | undefined {
  const point = triangulate(views);
  if (!point || !withinBounds(point)) return undefined;
  if (!inFrontOfAll(point, views)) return undefined;
  const error = meanReprojectionError(point, views);
  if (error === undefined || error > options.maxReprojectionErrorPx) {
    return undefined;
  }
  const score =
    views.reduce((total, observation) => total + observation.score, 0) /
    views.length;
  return { point, score: clampScore(score), error };
}

function inFrontOfAll(
  point: Vector3,
  observations: readonly KeypointObservation[],
): boolean {
  return observations.every(
    (observation) => depthOf(observation.model, point) > 0,
  );
}

function withinBounds(point: Vector3): boolean {
  return (
    Math.abs(point.x) <= COORDINATE_LIMIT &&
    Math.abs(point.y) <= COORDINATE_LIMIT &&
    Math.abs(point.z) <= COORDINATE_LIMIT
  );
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

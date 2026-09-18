/**
 * `fusion-v0`: the first implementation that estimates, rather than standing figures in a row
 * (#34, stage 3).
 *
 * Two layers, both carried over from `kubohiroya/turbowarp-realtime-motion-capture`'s `src/fusion`,
 * where they were written for the fusion app's own in-page path:
 *
 * - L0, time alignment: each camera's frames go into a timestamp-ordered ring, and every camera is
 *   resampled at one shared instant a little behind the newest frame. Cameras deliver at their own
 *   moments, and triangulating frames from different moments bends a moving limb.
 * - L1, association and triangulation: the tracked people of that instant are matched across cameras
 *   by their two-view reprojection error, and every COCO-17 joint of a multi-camera cluster is
 *   triangulated with the detector's confidence as its weight.
 *
 * What it does not do yet is as important as what it does, and the output says so joint by joint:
 * there is no identity over time (a person's ID is derived from the trackers that saw them in that
 * one instant, stage 4), no skeleton constraint (stage 5), and no completion or smoothing (stage 6).
 * Every joint is therefore `measured` or `missing`; nothing is `constrained` or `predicted`.
 */

import {
  COCO_17_KEYPOINT_IDS,
  LIMITS,
  POSE_FRAME_3D_SCHEMA,
  POSE_FRAME_3D_VERSION,
  type Joint3D,
  type PoseFrame2D,
  type PoseFrame3DPerson,
  type PoseFrame3DV2,
  type ServiceConfiguration,
} from '../contracts.ts';
import {
  fuseSynchronizedSample,
  DEFAULT_FUSION_GEOMETRY_OPTIONS,
  type FusionGeometryOptions,
} from './fuse.ts';
import { createCameraModel, depthOf } from './geometry.ts';
import {
  MultiCameraJitterBuffer,
  DEFAULT_JITTER_BUFFER_OPTIONS,
  type JitterBufferOptions,
} from './jitter-buffer.ts';
import { PersonIdentities } from './identity.ts';
import type { CameraModel, FusedPerson } from './types.ts';

export interface FusionOptions {
  readonly buffer: JitterBufferOptions;
  readonly geometry: FusionGeometryOptions;
  /**
   * How far behind the newest frame the shared instant sits.
   *
   * A frame that arrives after its instant has passed is of no use, so the wait buys alignment at the
   * cost of latency. One frame period at 30 fps is the starting value; the venue recordings decide it.
   */
  readonly outputDelayUs: number;
}

export const DEFAULT_FUSION_OPTIONS: FusionOptions = Object.freeze({
  buffer: DEFAULT_JITTER_BUFFER_OPTIONS,
  geometry: DEFAULT_FUSION_GEOMETRY_OPTIONS,
  outputDelayUs: 33_000,
});

export interface FusionStatus {
  readonly cameras: number;
  readonly bufferedFrames: number;
  readonly acceptedFrames: number;
  readonly droppedFrames: number;
  readonly lastOutputTimestampUs: number;
  readonly lastPersons: number;
}

export class FusionEstimator {
  private readonly options: FusionOptions;
  private readonly models = new Map<string, CameraModel>();
  private buffer: MultiCameraJitterBuffer;
  private referenceId = '';
  private sequence = 0;
  private lastOutputTimestampUs = 0;
  private lastPersons = 0;
  private readonly identities = new PersonIdentities();

  public constructor(options: FusionOptions = DEFAULT_FUSION_OPTIONS) {
    this.options = options;
    this.buffer = new MultiCameraJitterBuffer(options.buffer);
  }

  /** Builds a projection model per camera. A camera that cannot be modelled is refused here. */
  public configure(configuration: ServiceConfiguration): void {
    this.models.clear();
    for (const camera of configuration.cameras) {
      this.models.set(camera.cameraId, createCameraModel(camera));
    }
    this.referenceId = configuration.referenceId;
    this.buffer = new MultiCameraJitterBuffer(this.options.buffer);
    this.sequence = 0;
    this.lastOutputTimestampUs = 0;
    this.lastPersons = 0;
    this.identities.reset();
  }

  public accept(frame: PoseFrame2D): void {
    this.buffer.ingest(frame);
  }

  /**
   * The 3D frame for the instant asked for, or for one just behind the newest camera frame.
   *
   * Returns nothing rather than a guess when no instant has two cameras that agree on somebody: an
   * empty answer is a fact the consumer can act on, and a lone camera's person is not a 3D person.
   */
  public estimate(timestampUs: number | null): PoseFrame3DV2 | null {
    if (this.models.size === 0) return null;
    const newest = this.buffer.newestTimestampUs();
    if (newest === undefined) return null;
    const outputTimestampUs =
      timestampUs ?? newest - this.options.outputDelayUs;
    const sample = this.buffer.sampleAt(outputTimestampUs);
    if (sample.cameras.length < this.options.geometry.minCamerasPerPerson)
      return null;
    const persons = fuseSynchronizedSample(
      sample,
      this.models,
      this.options.geometry,
    ).slice(0, LIMITS.maxPersons);
    this.lastOutputTimestampUs = outputTimestampUs;
    this.lastPersons = persons.length;
    if (persons.length === 0) return null;
    const personIds = this.identities.assign(persons, outputTimestampUs);
    return {
      schema: POSE_FRAME_3D_SCHEMA,
      version: POSE_FRAME_3D_VERSION,
      sequence: this.sequence++,
      timestampUs: outputTimestampUs,
      referenceId: this.referenceId,
      implementation: 'fusion-v0',
      persons: persons.map((person, index) =>
        this.toPerson(person, personIds[index] as string),
      ),
    };
  }

  public status(): FusionStatus {
    return {
      cameras: this.models.size,
      bufferedFrames: this.buffer.bufferedFrameCount(),
      acceptedFrames: this.buffer.acceptedFrameCount(),
      droppedFrames: this.buffer.droppedFrameCount(),
      lastOutputTimestampUs: this.lastOutputTimestampUs,
      lastPersons: this.lastPersons,
    };
  }

  private toPerson(person: FusedPerson, personId: string): PoseFrame3DPerson {
    const joints: Joint3D[] = COCO_17_KEYPOINT_IDS.map((id) => {
      const keypoint = person.keypoints.find(
        (candidate) => candidate.id === id,
      );
      if (!keypoint?.point) {
        return {
          id,
          x: 0,
          y: 0,
          z: 0,
          sigma: 0,
          state: 'missing',
          cameraIds: [],
        };
      }
      return {
        id,
        x: keypoint.point.x,
        y: keypoint.point.y,
        z: keypoint.point.z,
        sigma: this.sigmaOf(
          keypoint.meanReprojectionErrorPx,
          keypoint.point,
          person.cameraIds,
        ),
        state: 'measured',
        cameraIds: [...person.cameraIds],
      };
    });
    return {
      // Identity follows the torso from instant to instant (stage 4); see PersonIdentities.
      personId,
      confidence: person.score,
      identitySource: 'geometry',
      meanReprojectionErrorPx: person.meanReprojectionErrorPx,
      joints,
      views: person.members.map((member) => ({
        cameraId: member.cameraId,
        trackingId: member.trackingId,
      })),
    };
  }

  /**
   * How far the point could be out, from how far its reprojection was.
   *
   * One pixel of error at distance d with focal length f is about d/f metres across the line of
   * sight, and depth error along it is larger the narrower the angle between the cameras. This takes
   * the across-sight figure of the nearest camera, which is the smaller of the two, and is therefore
   * a floor rather than a bound — enough to compare joints within a frame, not to trust as a
   * confidence interval. A real covariance comes with the constrained solve in stage 5.
   */
  private sigmaOf(
    errorPx: number,
    point: { x: number; y: number; z: number },
    cameraIds: readonly string[],
  ): number {
    let sigma = 0;
    for (const cameraId of cameraIds) {
      const model = this.models.get(cameraId);
      if (!model) continue;
      const depth = depthOf(model, point);
      if (!(depth > 0)) continue;
      const candidate = (Math.max(errorPx, 0.5) * depth) / model.fx;
      if (sigma === 0 || candidate < sigma) sigma = candidate;
    }
    return round4(sigma);
  }
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

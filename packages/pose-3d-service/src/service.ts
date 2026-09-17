import {
  COCO_17_KEYPOINT_IDS,
  LIMITS,
  POSE_FRAME_3D_SCHEMA,
  POSE_FRAME_3D_VERSION,
  SERVICE_INTERFACE,
  SERVICE_INTERFACE_VERSION,
  response,
  serializedBytes,
  validateConfiguration,
  validatePoseFrame2D,
  type Joint3D,
  type PoseFrame2D,
  type PoseFrame3DPerson,
  type PoseFrame3DV2,
  type ServiceConfiguration,
  type ServiceResponse
} from './contracts.js';

/**
 * The service side of interface v1: takes requests, answers them, and owns every piece of state.
 *
 * Stage 1 of #34 ships only stub implementations. They exist so the fusion app's transport,
 * validation, timeout handling and display can be built and tested against the real contract before
 * any 3D estimation exists:
 *
 * - `stub-normal` answers with a well-formed frame whose persons stand in a fixed row, one per person
 *   seen by at least two cameras. It marks every joint with the implementation that made it, so the
 *   result cannot pass for a measurement.
 * - `stub-timeout` accepts everything and never answers a 3D request.
 * - `stub-invalid` answers 3D requests with a document that breaks the contract.
 */
export class Pose3dService {
  private configuration: ServiceConfiguration | undefined;
  private readonly latest = new Map<string, PoseFrame2D>();
  private sequence = 0;

  /** Returns null when the request is deliberately left unanswered. */
  public handle(message: unknown): ServiceResponse | null {
    const id = readId(message);
    if (serializedBytes(message) > LIMITS.maxMessageBytes) {
      return response(id, 'error', {code: 'payload-too-large', message: 'The request exceeds the message size limit.'});
    }
    if (!isRecord(message) || message['interface'] !== SERVICE_INTERFACE) {
      return response(id, 'error', {code: 'unsupported-interface', message: 'The request does not name this interface.'});
    }
    if (message['version'] !== SERVICE_INTERFACE_VERSION) {
      return response(id, 'error', {
        code: 'unsupported-version',
        message: `Interface version ${String(message['version'])} is not supported.`
      });
    }
    switch (message['type']) {
      case 'configure':
        return this.configure(id, message['payload']);
      case 'frame2d':
        return this.acceptFrame(id, message['payload']);
      case 'requestPose3d':
        return this.pose3d(id);
      default:
        return response(id, 'error', {code: 'invalid-payload', message: `Unknown request type ${String(message['type'])}.`});
    }
  }

  private configure(id: number, payload: unknown): ServiceResponse {
    const checked = validateConfiguration(payload);
    if (!checked.ok) return response(id, 'error', {code: checked.code, message: checked.message});
    this.configuration = checked.value;
    this.latest.clear();
    this.sequence = 0;
    return response(id, 'configured', {cameraIds: checked.value.cameras.map((camera) => camera.cameraId)});
  }

  private acceptFrame(id: number, payload: unknown): ServiceResponse {
    const configuration = this.configuration;
    if (!configuration) return response(id, 'error', {code: 'not-configured', message: 'Configure the service first.'});
    if (!isRecord(payload) || typeof payload['cameraId'] !== 'string') {
      return response(id, 'error', {code: 'invalid-payload', message: 'A frame message needs a cameraId.'});
    }
    const camera = configuration.cameras.find((candidate) => candidate.cameraId === payload['cameraId']);
    if (!camera) {
      return response(id, 'error', {code: 'unknown-camera', message: `Camera ${payload['cameraId']} is not configured.`});
    }
    const frame = validatePoseFrame2D(payload['frame']);
    if (!frame.ok) return response(id, 'error', {code: frame.code, message: frame.message});
    // The profile a frame was estimated under has to be the one its camera was placed with, or its
    // pixels mean something else.
    if (frame.value.calibrationId !== camera.model.intrinsicProfileId) {
      return response(id, 'error', {
        code: 'calibration-mismatch',
        message: `Frame calibration ${frame.value.calibrationId} is not ${camera.model.intrinsicProfileId}.`
      });
    }
    this.latest.set(camera.cameraId, frame.value);
    return response(id, 'accepted', {cameraId: camera.cameraId, sequence: frame.value.sequence});
  }

  private pose3d(id: number): ServiceResponse | null {
    const configuration = this.configuration;
    if (!configuration) return response(id, 'error', {code: 'not-configured', message: 'Configure the service first.'});
    if (configuration.implementation === 'stub-timeout') return null;
    if (this.latest.size === 0) return response(id, 'pose3d', null);
    const frames = [...this.latest.values()];
    const timestampUs = Math.max(...frames.map((frame) => frame.captureTimestampUs));
    const frame: PoseFrame3DV2 = {
      schema: POSE_FRAME_3D_SCHEMA,
      version: POSE_FRAME_3D_VERSION,
      sequence: this.sequence++,
      timestampUs,
      referenceId: configuration.referenceId,
      implementation: configuration.implementation,
      persons: stubPersons(frames)
    };
    if (configuration.implementation === 'stub-invalid') {
      return response(id, 'pose3d', {...frame, persons: frame.persons.map((person) => ({...person, joints: person.joints.slice(0, 3)}))});
    }
    return response(id, 'pose3d', frame);
  }
}

/**
 * One standing figure per person index seen by at least two cameras, spaced along x.
 *
 * Deliberately not derived from the 2D keypoints: a stub that looked like it followed the performers
 * would invite reading it as a result.
 */
function stubPersons(frames: readonly PoseFrame2D[]): PoseFrame3DPerson[] {
  // The second-largest per-camera count: the most persons that at least two cameras report.
  const counts = frames.map((frame) => frame.persons.length).sort((left, right) => right - left);
  const count = Math.min(LIMITS.maxPersons, counts[1] ?? 0);
  const cameraIds = frames.map((frame) => frame.peerId).sort();
  return Array.from({length: count}, (_, index) => ({
    personId: `stub-${index + 1}`,
    confidence: 0.5,
    identitySource: 'stub' as const,
    meanReprojectionErrorPx: null,
    joints: COCO_17_KEYPOINT_IDS.map((id, joint): Joint3D => ({
      id,
      x: index * 1.0,
      y: 1.7 - joint * 0.1,
      z: 0,
      sigma: 0.05,
      state: 'measured',
      cameraIds
    }))
  }));
}

function readId(message: unknown): number {
  return isRecord(message) && Number.isSafeInteger(message['id']) ? (message['id'] as number) : -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

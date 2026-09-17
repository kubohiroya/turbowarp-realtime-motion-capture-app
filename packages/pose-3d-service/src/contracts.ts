/**
 * Interface v1 of the 3D pose service (#34), and the documents it carries.
 *
 * The service owns time alignment, person association, triangulation, identity over time, skeletal
 * constraints and completion. The fusion app owns transport, validation and display. Everything that
 * crosses between them is defined here, validated on both sides, and versioned, so a service built
 * later — or a second implementation — can be checked against the same contract.
 */

export const SERVICE_INTERFACE = 'twrmc/pose-3d-service';
export const SERVICE_INTERFACE_VERSION = 1;

export const POSE_FRAME_2D_SCHEMA = 'twrmc/pose-frame-2d';
export const POSE_FRAME_3D_SCHEMA = 'twrmc/pose-frame-3d';
/**
 * Version 2 adds what version 1 cannot say: whether each joint was measured, constrained by the
 * skeleton, or predicted, and how uncertain it is. Version 1 remains the shape the avatar blocks of
 * `turbowarp-realtime-motion-capture` read, and {@link toPoseFrame3DV1} produces it.
 */
export const POSE_FRAME_3D_VERSION = 2;

export const COCO_17_KEYPOINT_IDS = [
  'nose',
  'left_eye',
  'right_eye',
  'left_ear',
  'right_ear',
  'left_shoulder',
  'right_shoulder',
  'left_elbow',
  'right_elbow',
  'left_wrist',
  'right_wrist',
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
  'left_ankle',
  'right_ankle',
] as const;

export type Coco17KeypointId = (typeof COCO_17_KEYPOINT_IDS)[number];

/** Fixed by interface v1. A service or client that needs more negotiates a new version. */
export const LIMITS = Object.freeze({
  maxPersons: 6,
  maxCameras: 8,
  /** Serialized size of any one message. A six-person 2D frame is about 6 KB. */
  maxMessageBytes: 65_536,
  /** A configure that has not been answered by then has failed. */
  configureTimeoutMs: 2_000,
  /** A 3D request that has not been answered by then is skipped, not waited for. */
  requestTimeoutMs: 100,
  /** A 2D frame received longer ago than this is stale and is not forwarded. */
  maxFrameAgeMs: 500,
});

export type JointState = 'measured' | 'constrained' | 'predicted' | 'missing';
export const JOINT_STATES: readonly JointState[] = [
  'measured',
  'constrained',
  'predicted',
  'missing',
];

export type ServiceErrorCode =
  | 'unsupported-interface'
  | 'unsupported-version'
  | 'invalid-payload'
  | 'payload-too-large'
  | 'not-configured'
  | 'unknown-camera'
  | 'calibration-mismatch'
  | 'stale-frame'
  | 'timeout'
  | 'invalid-response'
  | 'worker-failed';

export type ImplementationId = 'stub-normal' | 'stub-timeout' | 'stub-invalid';
export const IMPLEMENTATIONS: readonly ImplementationId[] = [
  'stub-normal',
  'stub-timeout',
  'stub-invalid',
];

// Documents ------------------------------------------------------------------

export interface Keypoint2D {
  readonly id: Coco17KeypointId;
  readonly x: number;
  readonly y: number;
  readonly score: number;
}

export interface PoseFrame2DPerson {
  readonly trackingId: string;
  readonly score: number;
  readonly keypoints: readonly Keypoint2D[];
}

/** The fields of `twrmc/pose-frame-2d` (v1 or v2) the service reads. Markers are passed through. */
export interface PoseFrame2D {
  readonly schema: typeof POSE_FRAME_2D_SCHEMA;
  readonly version: 1 | 2;
  readonly cameraId: string;
  readonly peerId: string;
  readonly sequence: number;
  readonly captureTimestampUs: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly calibrationId: string;
  readonly persons: readonly PoseFrame2DPerson[];
}

export interface CameraModel {
  readonly intrinsics: {
    readonly fx: number;
    readonly fy: number;
    readonly cx: number;
    readonly cy: number;
    readonly skew: number;
  };
  readonly distortion: {
    readonly model: string;
    readonly coefficients: readonly number[];
  };
  readonly intrinsicProfileId: string;
  readonly imageWidth: number;
  readonly imageHeight: number;
}

export interface ServiceCamera {
  /** The peer name the fusion app paired the camera app under, e.g. `camera-1`. */
  readonly cameraId: string;
  readonly model: CameraModel;
  /** Row-major 4x4, reference to camera, from `twtss/placement-result`. */
  readonly cameraFromReference: readonly number[];
  /** `twtss/time-correspondence` as measured for this camera, or null when none was. */
  readonly timeCorrespondence: unknown;
}

export interface ServiceConfiguration {
  readonly implementation: ImplementationId;
  readonly referenceId: string;
  readonly cameras: readonly ServiceCamera[];
}

export interface Joint3D {
  readonly id: Coco17KeypointId;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** One standard deviation, meters. */
  readonly sigma: number;
  readonly state: JointState;
  readonly cameraIds: readonly string[];
}

export interface PoseFrame3DPerson {
  readonly personId: string;
  readonly confidence: number;
  readonly identitySource: 'geometry' | 'glow-stick' | 'tracking-id' | 'stub';
  readonly meanReprojectionErrorPx: number | null;
  readonly joints: readonly Joint3D[];
}

export interface PoseFrame3DV2 {
  readonly schema: typeof POSE_FRAME_3D_SCHEMA;
  readonly version: typeof POSE_FRAME_3D_VERSION;
  readonly sequence: number;
  readonly timestampUs: number;
  readonly referenceId: string;
  /** Which implementation produced this, so a stub can never pass for a measurement. */
  readonly implementation: ImplementationId;
  readonly persons: readonly PoseFrame3DPerson[];
}

// Messages -------------------------------------------------------------------

interface Envelope<Type extends string, Payload> {
  readonly interface: typeof SERVICE_INTERFACE;
  readonly version: typeof SERVICE_INTERFACE_VERSION;
  readonly id: number;
  readonly type: Type;
  readonly payload: Payload;
}

export type ServiceRequest =
  | Envelope<'configure', ServiceConfiguration>
  | Envelope<
      'frame2d',
      { readonly cameraId: string; readonly frame: PoseFrame2D }
    >
  | Envelope<'requestPose3d', { readonly timestampUs: number | null }>;

export type ServiceResponse =
  | Envelope<'configured', { readonly cameraIds: readonly string[] }>
  | Envelope<
      'accepted',
      { readonly cameraId: string; readonly sequence: number }
    >
  | Envelope<'pose3d', PoseFrame3DV2 | null>
  | Envelope<
      'error',
      { readonly code: ServiceErrorCode; readonly message: string }
    >;

export function request<Type extends ServiceRequest['type']>(
  id: number,
  type: Type,
  payload: Extract<ServiceRequest, { type: Type }>['payload'],
): ServiceRequest {
  return {
    interface: SERVICE_INTERFACE,
    version: SERVICE_INTERFACE_VERSION,
    id,
    type,
    payload,
  } as ServiceRequest;
}

export function response<Type extends ServiceResponse['type']>(
  id: number,
  type: Type,
  payload: Extract<ServiceResponse, { type: Type }>['payload'],
): ServiceResponse {
  return {
    interface: SERVICE_INTERFACE,
    version: SERVICE_INTERFACE_VERSION,
    id,
    type,
    payload,
  } as ServiceResponse;
}

// Validation -----------------------------------------------------------------

export type Validation<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: ServiceErrorCode;
      readonly message: string;
    };

const fail = <T>(code: ServiceErrorCode, message: string): Validation<T> => ({
  ok: false,
  code,
  message,
});

type Unknown = Record<string, unknown>;

const isObject = (value: unknown): value is Unknown =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value);
const isScore = (value: unknown): value is number =>
  isFiniteNumber(value) && value >= 0 && value <= 1;
const isTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Measures a message the way it will travel. Anything unserializable is too large to send. */
export function serializedBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function validatePoseFrame2D(value: unknown): Validation<PoseFrame2D> {
  if (!isObject(value))
    return fail('invalid-payload', 'A pose frame must be an object.');
  if (value['schema'] !== POSE_FRAME_2D_SCHEMA) {
    return fail(
      'invalid-payload',
      `A 2D pose frame must have schema ${POSE_FRAME_2D_SCHEMA}.`,
    );
  }
  if (value['version'] !== 1 && value['version'] !== 2) {
    return fail(
      'unsupported-version',
      `2D pose frame version ${String(value['version'])} is not supported.`,
    );
  }
  for (const key of ['cameraId', 'peerId', 'calibrationId'] as const) {
    if (!isIdentifier(value[key]))
      return fail('invalid-payload', `${key} must be an identifier.`);
  }
  if (
    !isTimestamp(value['sequence']) ||
    !isTimestamp(value['captureTimestampUs'])
  ) {
    return fail(
      'invalid-payload',
      'sequence and captureTimestampUs must be non-negative integers.',
    );
  }
  for (const key of ['frameWidth', 'frameHeight'] as const) {
    const size = value[key];
    if (!isFiniteNumber(size) || size < 1)
      return fail('invalid-payload', `${key} must be positive.`);
  }
  const persons = value['persons'];
  if (!Array.isArray(persons) || persons.length > LIMITS.maxPersons) {
    return fail(
      'invalid-payload',
      `persons must be an array of at most ${LIMITS.maxPersons}.`,
    );
  }
  for (const person of persons) {
    if (
      !isObject(person) ||
      typeof person['trackingId'] !== 'string' ||
      !isScore(person['score'])
    ) {
      return fail(
        'invalid-payload',
        'Each person needs a trackingId and a score.',
      );
    }
    const keypoints = person['keypoints'];
    if (
      !Array.isArray(keypoints) ||
      keypoints.length !== COCO_17_KEYPOINT_IDS.length
    ) {
      return fail(
        'invalid-payload',
        'Each person needs the 17 COCO keypoints.',
      );
    }
    for (const [index, keypoint] of keypoints.entries()) {
      if (
        !isObject(keypoint) ||
        keypoint['id'] !== COCO_17_KEYPOINT_IDS[index] ||
        !isFiniteNumber(keypoint['x']) ||
        !isFiniteNumber(keypoint['y']) ||
        !isScore(keypoint['score'])
      ) {
        return fail(
          'invalid-payload',
          `Keypoint ${index} is not a finite ${COCO_17_KEYPOINT_IDS[index]}.`,
        );
      }
    }
  }
  return { ok: true, value: value as unknown as PoseFrame2D };
}

function validateCamera(value: unknown): Validation<ServiceCamera> {
  if (!isObject(value) || !isIdentifier(value['cameraId'])) {
    return fail('invalid-payload', 'Each camera needs a cameraId.');
  }
  const model = value['model'];
  if (
    !isObject(model) ||
    !isObject(model['intrinsics']) ||
    !isObject(model['distortion'])
  ) {
    return fail(
      'invalid-payload',
      `Camera ${value['cameraId']} needs a camera model with distortion.`,
    );
  }
  const intrinsics = model['intrinsics'];
  for (const key of ['fx', 'fy', 'cx', 'cy', 'skew']) {
    if (!isFiniteNumber(intrinsics[key])) {
      return fail(
        'invalid-payload',
        `Camera ${value['cameraId']} intrinsics.${key} must be finite.`,
      );
    }
  }
  if (!isIdentifier(model['intrinsicProfileId'])) {
    return fail(
      'invalid-payload',
      `Camera ${value['cameraId']} needs intrinsicProfileId.`,
    );
  }
  const transform = value['cameraFromReference'];
  if (
    !Array.isArray(transform) ||
    transform.length !== 16 ||
    !transform.every(isFiniteNumber)
  ) {
    return fail(
      'invalid-payload',
      `Camera ${value['cameraId']} cameraFromReference must be 16 finite numbers.`,
    );
  }
  return { ok: true, value: value as unknown as ServiceCamera };
}

export function validateConfiguration(
  value: unknown,
): Validation<ServiceConfiguration> {
  if (!isObject(value))
    return fail('invalid-payload', 'A configuration must be an object.');
  if (!IMPLEMENTATIONS.includes(value['implementation'] as ImplementationId)) {
    return fail(
      'invalid-payload',
      `Unknown implementation ${String(value['implementation'])}.`,
    );
  }
  if (!isIdentifier(value['referenceId']))
    return fail('invalid-payload', 'referenceId must be an identifier.');
  const cameras = value['cameras'];
  if (
    !Array.isArray(cameras) ||
    cameras.length < 2 ||
    cameras.length > LIMITS.maxCameras
  ) {
    return fail(
      'invalid-payload',
      `A configuration needs 2 to ${LIMITS.maxCameras} cameras.`,
    );
  }
  const seen = new Set<string>();
  for (const camera of cameras) {
    const checked = validateCamera(camera);
    if (!checked.ok) return fail(checked.code, checked.message);
    if (seen.has(checked.value.cameraId)) {
      return fail(
        'invalid-payload',
        `Camera ${checked.value.cameraId} appears twice.`,
      );
    }
    seen.add(checked.value.cameraId);
  }
  return { ok: true, value: value as unknown as ServiceConfiguration };
}

export function validatePoseFrame3D(value: unknown): Validation<PoseFrame3DV2> {
  if (!isObject(value))
    return fail('invalid-response', 'A 3D pose frame must be an object.');
  if (
    value['schema'] !== POSE_FRAME_3D_SCHEMA ||
    value['version'] !== POSE_FRAME_3D_VERSION
  ) {
    return fail(
      'invalid-response',
      `A 3D pose frame must be ${POSE_FRAME_3D_SCHEMA} version ${POSE_FRAME_3D_VERSION}.`,
    );
  }
  if (!isTimestamp(value['sequence']) || !isTimestamp(value['timestampUs'])) {
    return fail(
      'invalid-response',
      'sequence and timestampUs must be non-negative integers.',
    );
  }
  if (!isIdentifier(value['referenceId']))
    return fail('invalid-response', 'referenceId must be an identifier.');
  if (!IMPLEMENTATIONS.includes(value['implementation'] as ImplementationId)) {
    return fail(
      'invalid-response',
      'implementation must name a known implementation.',
    );
  }
  const persons = value['persons'];
  if (!Array.isArray(persons) || persons.length > LIMITS.maxPersons) {
    return fail(
      'invalid-response',
      `persons must be an array of at most ${LIMITS.maxPersons}.`,
    );
  }
  const personIds = new Set<string>();
  for (const person of persons) {
    if (
      !isObject(person) ||
      !isIdentifier(person['personId']) ||
      !isScore(person['confidence'])
    ) {
      return fail(
        'invalid-response',
        'Each person needs a personId and a confidence.',
      );
    }
    if (personIds.has(person['personId'])) {
      return fail(
        'invalid-response',
        `Person ${person['personId']} appears twice.`,
      );
    }
    personIds.add(person['personId']);
    const error = person['meanReprojectionErrorPx'];
    if (error !== null && !(isFiniteNumber(error) && error >= 0)) {
      return fail(
        'invalid-response',
        'meanReprojectionErrorPx must be null or non-negative.',
      );
    }
    const joints = person['joints'];
    if (
      !Array.isArray(joints) ||
      joints.length !== COCO_17_KEYPOINT_IDS.length
    ) {
      return fail('invalid-response', 'Each person needs the 17 COCO joints.');
    }
    for (const [index, joint] of joints.entries()) {
      if (
        !isObject(joint) ||
        joint['id'] !== COCO_17_KEYPOINT_IDS[index] ||
        !JOINT_STATES.includes(joint['state'] as JointState) ||
        !Array.isArray(joint['cameraIds'])
      ) {
        return fail('invalid-response', `Joint ${index} is malformed.`);
      }
      const missing = joint['state'] === 'missing';
      for (const key of ['x', 'y', 'z', 'sigma'] as const) {
        const coordinate = joint[key];
        // A missing joint has no position, and it must not carry one that looks like a reading.
        if (missing ? coordinate !== 0 : !isFiniteNumber(coordinate)) {
          return fail(
            'invalid-response',
            `Joint ${String(joint['id'])} ${key} is invalid for state ${String(joint['state'])}.`,
          );
        }
      }
      if (!missing && (joint['sigma'] as number) < 0) {
        return fail(
          'invalid-response',
          `Joint ${String(joint['id'])} sigma must not be negative.`,
        );
      }
      if (
        joint['state'] === 'measured' &&
        (joint['cameraIds'] as unknown[]).length < 2
      ) {
        return fail(
          'invalid-response',
          `Joint ${String(joint['id'])} cannot be measured by fewer than two cameras.`,
        );
      }
    }
  }
  return { ok: true, value: value as unknown as PoseFrame3DV2 };
}

export function validateResponse(value: unknown): Validation<ServiceResponse> {
  if (!isObject(value) || value['interface'] !== SERVICE_INTERFACE) {
    return fail(
      'unsupported-interface',
      'The response does not name the pose 3D service interface.',
    );
  }
  if (value['version'] !== SERVICE_INTERFACE_VERSION) {
    return fail(
      'unsupported-version',
      `Interface version ${String(value['version'])} is not supported.`,
    );
  }
  if (!Number.isSafeInteger(value['id']))
    return fail('invalid-response', 'The response has no id.');
  if (serializedBytes(value) > LIMITS.maxMessageBytes) {
    return fail(
      'payload-too-large',
      'The response exceeds the message size limit.',
    );
  }
  switch (value['type']) {
    case 'configured':
    case 'accepted':
      return isObject(value['payload'])
        ? { ok: true, value: value as unknown as ServiceResponse }
        : fail('invalid-response', 'The response payload must be an object.');
    case 'pose3d': {
      if (value['payload'] === null)
        return { ok: true, value: value as unknown as ServiceResponse };
      const pose = validatePoseFrame3D(value['payload']);
      return pose.ok
        ? { ok: true, value: value as unknown as ServiceResponse }
        : pose;
    }
    case 'error': {
      const payload = value['payload'];
      return isObject(payload) && typeof payload['code'] === 'string'
        ? { ok: true, value: value as unknown as ServiceResponse }
        : fail('invalid-response', 'An error response needs a code.');
    }
    default:
      return fail(
        'invalid-response',
        `Unknown response type ${String(value['type'])}.`,
      );
  }
}

/**
 * The version 1 view the avatar blocks read.
 *
 * Only a person with at least two measuring cameras fits version 1, which requires them. A joint that
 * was not measured or constrained keeps its place with score 0, so a consumer that reads version 1
 * cannot take a prediction for a measurement.
 */
export function toPoseFrame3DV1(frame: PoseFrame3DV2): unknown {
  const persons = frame.persons.flatMap((person) => {
    const cameraIds = [
      ...new Set(person.joints.flatMap((joint) => joint.cameraIds)),
    ].sort();
    if (cameraIds.length < 2) return [];
    return [
      {
        personId: person.personId,
        score: person.confidence,
        cameraIds,
        meanReprojectionErrorPx: person.meanReprojectionErrorPx ?? 0,
        keypoints: person.joints.map((joint) => ({
          id: joint.id,
          x: joint.x,
          y: joint.y,
          z: joint.z,
          score:
            joint.state === 'measured' || joint.state === 'constrained'
              ? person.confidence
              : 0,
        })),
      },
    ];
  });
  return {
    schema: POSE_FRAME_3D_SCHEMA,
    version: 1,
    sequence: frame.sequence,
    timestampUs: frame.timestampUs,
    persons,
  };
}

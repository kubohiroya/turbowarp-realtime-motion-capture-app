import {Type, type Static, type TSchema} from '@sinclair/typebox';

const identifier = Type.String({minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$'});
const timestampUs = Type.Integer({minimum: 0, maximum: Number.MAX_SAFE_INTEGER});
const score = Type.Number({minimum: 0, maximum: 1});
const boundedNumber = Type.Number({minimum: -1_000_000, maximum: 1_000_000});
const utcDateTime = Type.String({pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$'});

export const coco17KeypointIds = [
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
  'right_ankle'
] as const;

const object = <T extends Record<string, TSchema>>(properties: T, options: {$id?: string} = {}) =>
  Type.Object(properties, {additionalProperties: false, ...options});

const keypoints2d = Type.Tuple(
  coco17KeypointIds.map((id) =>
    object({id: Type.Literal(id), x: boundedNumber, y: boundedNumber, score})
  )
);
const keypoints3d = Type.Tuple(
  coco17KeypointIds.map((id) =>
    object({id: Type.Literal(id), x: boundedNumber, y: boundedNumber, z: boundedNumber, score})
  )
);

export const SessionPolicySchema = object({
  schema: Type.Literal('twmp/session-policy'),
  version: Type.Literal(1),
  sessionId: identifier,
  revision: Type.Integer({minimum: 1, maximum: Number.MAX_SAFE_INTEGER}),
  issuedAt: utcDateTime,
  expiresAt: utcDateTime,
  fusionPeerId: identifier,
  cameraPeers: Type.Array(
    object({
      cameraId: identifier,
      peerId: identifier,
      displayName: Type.String({minLength: 1, maxLength: 80}),
      calibrationId: identifier
    }),
    {minItems: 1, maxItems: 16}
  ),
  maximumPerformers: Type.Integer({minimum: 1, maximum: 6}),
  poseModel: object({
    model: Type.Literal('movenet-multipose-lightning'),
    maxPoses: Type.Integer({minimum: 1, maximum: 6}),
    minPoseScore: score,
    minKeypointScore: score
  }),
  qrCourierPairing: Type.Boolean(),
  poseChannelHighWaterBytes: Type.Integer({minimum: 1024, maximum: 16_777_216})
}, {$id: 'https://kubohiroya.github.io/multiview-pose/schema/session-policy-v1.json'});

export const CameraCalibrationSchema = object({
  schema: Type.Literal('twmp/camera-calibration'),
  version: Type.Literal(1),
  calibrationId: identifier,
  cameraId: identifier,
  imageWidth: Type.Integer({minimum: 1, maximum: 16_384}),
  imageHeight: Type.Integer({minimum: 1, maximum: 16_384}),
  intrinsicMatrix: Type.Tuple(Array.from({length: 9}, () => boundedNumber)),
  distortionCoefficients: Type.Array(boundedNumber, {minItems: 0, maxItems: 14}),
  worldFromCameraMatrix: Type.Tuple(Array.from({length: 16}, () => boundedNumber)),
  worldUnit: Type.Literal('meter'),
  calibratedAt: utcDateTime
}, {$id: 'https://kubohiroya.github.io/multiview-pose/schema/camera-calibration-v1.json'});

export const PoseFrame2DSchema = object({
  schema: Type.Literal('twmp/pose-frame-2d'),
  version: Type.Literal(1),
  cameraId: identifier,
  peerId: identifier,
  sequence: timestampUs,
  captureTimestampUs: timestampUs,
  frameWidth: Type.Integer({minimum: 1, maximum: 16_384}),
  frameHeight: Type.Integer({minimum: 1, maximum: 16_384}),
  calibrationId: identifier,
  persons: Type.Array(object({trackingId: identifier, score, keypoints: keypoints2d}), {maxItems: 6})
}, {$id: 'https://kubohiroya.github.io/multiview-pose/schema/pose-frame-2d-v1.json'});

export const PoseFrame3DSchema = object({
  schema: Type.Literal('twmp/pose-frame-3d'),
  version: Type.Literal(1),
  sequence: timestampUs,
  timestampUs,
  persons: Type.Array(
    object({
      personId: identifier,
      score,
      cameraIds: Type.Array(identifier, {minItems: 2, maxItems: 16, uniqueItems: true}),
      meanReprojectionErrorPx: Type.Number({minimum: 0, maximum: 100_000}),
      keypoints: keypoints3d
    }),
    {maxItems: 6}
  )
}, {$id: 'https://kubohiroya.github.io/multiview-pose/schema/pose-frame-3d-v1.json'});

export const PerformanceDslSchema = object({
  schema: Type.Literal('twmp/performance-dsl'),
  version: Type.Literal(1),
  performers: Type.Array(
    object({
      performerId: identifier,
      displayName: Type.String({minLength: 1, maxLength: 80}),
      glowStickColor: Type.String({pattern: '^#[0-9A-Fa-f]{6}$'}),
      recognitionStartEffect: identifier,
      recognitionEndEffect: identifier,
      avatarAsset: identifier
    }),
    {minItems: 1, maxItems: 6}
  )
}, {$id: 'https://kubohiroya.github.io/multiview-pose/schema/performance-dsl-v1.json'});

export const protocolSchemas = {
  'camera-calibration-v1.json': CameraCalibrationSchema,
  'performance-dsl-v1.json': PerformanceDslSchema,
  'pose-frame-2d-v1.json': PoseFrame2DSchema,
  'pose-frame-3d-v1.json': PoseFrame3DSchema,
  'session-policy-v1.json': SessionPolicySchema
} as const;

export type SessionPolicy = Static<typeof SessionPolicySchema>;
export type CameraCalibration = Static<typeof CameraCalibrationSchema>;
export type PoseFrame2D = Static<typeof PoseFrame2DSchema>;
export type PoseFrame3D = Static<typeof PoseFrame3DSchema>;
export type PerformanceDsl = Static<typeof PerformanceDslSchema>;

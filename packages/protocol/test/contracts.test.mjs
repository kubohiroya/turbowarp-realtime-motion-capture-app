import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  CameraCalibrationSchema,
  ClockProbeSchema,
  PerformanceDslSchema,
  PoseFrame2DSchema,
  PoseFrame3DSchema,
  SessionPolicySchema,
  coco17KeypointIds,
  protocolSchemas,
  validateProtocol,
  validateSessionPolicy
} from '../dist/src/index.js';

const keypoints2d = coco17KeypointIds.map((id, index) => ({id, x: index * 10, y: index * 5, score: 0.9}));
const keypoints3d = coco17KeypointIds.map((id, index) => ({
  id,
  x: index / 10,
  y: index / 20,
  z: index / 30,
  score: 0.8
}));

const validValues = [
  [SessionPolicySchema, {
    schema: 'twmp/session-policy', version: 1, sessionId: 'show-2026', revision: 1,
    issuedAt: '2026-09-13T12:00:00Z', expiresAt: '2026-09-13T18:00:00Z', fusionPeerId: 'fusion-1',
    cameraPeers: [{cameraId: 'camera-1', peerId: 'source-1', displayName: 'Stage left', calibrationId: 'calibration-1'}],
    maximumPerformers: 6,
    poseModel: {model: 'movenet-multipose-lightning', maxPoses: 6, minPoseScore: 0.2, minKeypointScore: 0.2},
    qrCourierPairing: true, poseChannelHighWaterBytes: 262144
  }],
  [CameraCalibrationSchema, {
    schema: 'twmp/camera-calibration', version: 1, calibrationId: 'calibration-1', cameraId: 'camera-1',
    imageWidth: 1920, imageHeight: 1080, intrinsicMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    distortionCoefficients: [], worldFromCameraMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    worldUnit: 'meter', calibratedAt: '2026-09-13T12:00:00Z'
  }],
  [PoseFrame2DSchema, {
    schema: 'twmp/pose-frame-2d', version: 1, cameraId: 'camera-1', peerId: 'source-1', sequence: 42,
    captureTimestampUs: 123456789, clockId: 'clock-1', frameWidth: 1920, frameHeight: 1080,
    calibrationId: 'calibration-1', persons: [{trackingId: 'person-1', score: 0.9, keypoints: keypoints2d}]
  }],
  [PoseFrame3DSchema, {
    schema: 'twmp/pose-frame-3d', version: 1, sequence: 42, timestampUs: 123456789,
    persons: [{personId: 'performer-1', score: 0.8, cameraIds: ['camera-1', 'camera-2'],
      meanReprojectionErrorPx: 1.25, keypoints: keypoints3d}]
  }],
  [ClockProbeSchema, {
    schema: 'twmp/clock-probe', version: 1, kind: 'pong', sequence: 9,
    t0Us: 1000, t1Us: 1100, t2Us: 1150
  }],
  [PerformanceDslSchema, {
    schema: 'twmp/performance-dsl', version: 1,
    performers: [{performerId: 'actor-1', displayName: 'Actor 1', glowStickColor: '#00FFAA',
      recognitionStartEffect: 'fade-in', recognitionEndEffect: 'fade-out', avatarAsset: 'avatar-1'}]
  }]
];

test('all v1 contracts validate and survive a JSON round trip', () => {
  for (const [schema, value] of validValues) {
    const roundTripped = JSON.parse(JSON.stringify(value));
    assert.deepEqual(validateProtocol(schema, roundTripped), {ok: true, value: roundTripped});
  }
});

test('session policy rejects invalid or expired validity windows', () => {
  const session = validValues[0][1];
  assert.equal(validateSessionPolicy(session, Date.parse('2026-09-13T13:00:00Z')).ok, true);
  assert.equal(validateSessionPolicy(
    {...session, expiresAt: session.issuedAt},
    Date.parse('2026-09-13T11:00:00Z')
  ).ok, false);
  assert.equal(validateSessionPolicy(session, Date.parse('2026-09-13T19:00:00Z')).ok, false);
});

test('unknown versions, missing values, oversized arrays, and pairing credentials are rejected', () => {
  const session = validValues[0][1];
  assert.equal(validateProtocol(SessionPolicySchema, {...session, version: 2}).ok, false);
  const {fusionPeerId: _removed, ...missingRequired} = session;
  assert.equal(validateProtocol(SessionPolicySchema, missingRequired).ok, false);
  assert.equal(validateProtocol(SessionPolicySchema, {...session, offer: 'credential'}).ok, false);

  const dsl = validValues[5][1];
  assert.equal(validateProtocol(PerformanceDslSchema, {
    ...dsl,
    performers: Array.from({length: 7}, (_, index) => ({...dsl.performers[0], performerId: `actor-${index}`}))
  }).ok, false);

  const pose = validValues[2][1];
  assert.equal(validateProtocol(PoseFrame2DSchema, {
    ...pose,
    persons: Array.from({length: 7}, (_, index) => ({...pose.persons[0], trackingId: `person-${index}`}))
  }).ok, false);
});

test('COCO-17 order and cardinality are part of the pose contract', () => {
  const pose2d = validValues[2][1];
  assert.equal(validateProtocol(PoseFrame2DSchema, {
    ...pose2d,
    persons: [{...pose2d.persons[0], keypoints: keypoints2d.slice(0, 16)}]
  }).ok, false);
  const swapped = [...keypoints2d];
  [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  assert.equal(validateProtocol(PoseFrame2DSchema, {
    ...pose2d,
    persons: [{...pose2d.persons[0], keypoints: swapped}]
  }).ok, false);
});

test('generated JSON Schemas match the in-memory schema definitions', async () => {
  for (const [filename, schema] of Object.entries(protocolSchemas)) {
    const generated = JSON.parse(await readFile(new URL(`../schemas/${filename}`, import.meta.url), 'utf8'));
    assert.deepEqual(generated, JSON.parse(JSON.stringify(schema)));
  }
});

test('committed valid and invalid fixtures remain classified', async () => {
  const readFixture = async (path) => JSON.parse(await readFile(new URL(`../fixtures/${path}`, import.meta.url), 'utf8'));
  assert.equal(validateProtocol(PerformanceDslSchema, await readFixture('valid/performance-dsl.json')).ok, true);
  assert.equal(validateProtocol(PerformanceDslSchema, await readFixture('invalid/performance-dsl-v2.json')).ok, false);
  assert.equal(
    validateProtocol(SessionPolicySchema, await readFixture('invalid/session-policy-with-credential.json')).ok,
    false
  );
});

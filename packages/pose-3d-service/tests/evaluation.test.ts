import {describe, expect, it} from 'vitest';

import {
  COCO_17_KEYPOINT_IDS,
  response,
  validatePoseFrame2D,
  type PoseFrame3DV2,
  type ServiceConfiguration
} from '../src/contracts.ts';
import {evaluate, formatMetrics} from '../src/metrics.ts';
import {replaySession, type ServiceHandler} from '../src/replay.ts';
import {parseSession, serializeSession, SessionRecorder, type Session} from '../src/session.ts';
import {generateScene} from '../src/synthetic.ts';
import {frame as poseFrame, configuration} from './fixtures.ts';

const scene = (overrides = {}) => generateScene({seconds: 2, cameras: 3, persons: 2, ...overrides});

/**
 * A service that answers with the scene's own truth, as a perfect implementation would.
 *
 * It measures the metrics rather than an estimator: a figure that cannot show zero error on exact
 * input cannot be trusted to show the error of an estimator either.
 */
function oracle(session: Session, options: {shiftMeters?: number} = {}): ServiceHandler {
  const truth = session.truth ?? [];
  let latestTimestampUs = 0;
  let sequence = 0;
  return {
    handle(message: unknown) {
      const envelope = message as {id: number; type: string; payload: unknown};
      if (envelope.type === 'configure') {
        return response(envelope.id, 'configured', {
          cameraIds: (envelope.payload as ServiceConfiguration).cameras.map((camera) => camera.cameraId)
        });
      }
      if (envelope.type === 'frame2d') {
        const payload = envelope.payload as {cameraId: string; frame: {captureTimestampUs: number; sequence: number}};
        latestTimestampUs = Math.max(latestTimestampUs, payload.frame.captureTimestampUs);
        return response(envelope.id, 'accepted', {cameraId: payload.cameraId, sequence: payload.frame.sequence});
      }
      const truthFrame = truth.find((candidate) => candidate.timestampUs === latestTimestampUs);
      if (!truthFrame) return response(envelope.id, 'pose3d', null);
      const shift = options.shiftMeters ?? 0;
      const frame: PoseFrame3DV2 = {
        schema: 'twrmc/pose-frame-3d',
        version: 2,
        sequence: sequence++,
        timestampUs: truthFrame.timestampUs,
        referenceId: 'synthetic-room',
        implementation: 'stub-normal',
        persons: truthFrame.persons.map((person) => ({
          personId: person.personId,
          confidence: 0.9,
          identitySource: 'geometry' as const,
          meanReprojectionErrorPx: 0.4,
          // A missing joint carries zeros: the contract refuses a position where there is no reading.
          joints: person.joints.map((joint) =>
            joint.cameraIds.length >= 2
              ? {id: joint.id, x: joint.x + shift, y: joint.y, z: joint.z, sigma: 0.01, state: 'measured' as const, cameraIds: joint.cameraIds}
              : {id: joint.id, x: 0, y: 0, z: 0, sigma: 0, state: 'missing' as const, cameraIds: joint.cameraIds}
          )
        }))
      };
      return response(envelope.id, 'pose3d', frame);
    }
  };
}

describe('synthetic scenes', () => {
  it('produces valid 2D frames whose cameras and calibrations match the configuration', () => {
    const {session} = scene();
    const cameraIds = session.configuration.cameras.map((camera) => camera.cameraId);
    expect(cameraIds).toEqual(['camera-1', 'camera-2', 'camera-3']);
    const frames = session.events.filter((event) => event.type === 'frame2d');
    expect(frames.length).toBe(60 * 3);
    for (const event of frames) {
      if (event.type !== 'frame2d') continue;
      const checked = validatePoseFrame2D(event.frame);
      expect(checked.ok, checked.ok ? '' : checked.message).toBe(true);
      const camera = session.configuration.cameras.find((candidate) => candidate.cameraId === event.cameraId);
      expect(event.frame.calibrationId).toBe(camera?.model.intrinsicProfileId);
    }
  });

  it('records which cameras saw each truth joint, and most are seen by two or more', () => {
    const {session} = scene();
    const joints = (session.truth ?? []).flatMap((frame) => frame.persons.flatMap((person) => person.joints));
    expect(joints.length).toBeGreaterThan(1000);
    const triangulable = joints.filter((joint) => joint.cameraIds.length >= 2).length;
    expect(triangulable / joints.length).toBeGreaterThan(0.9);
    for (const joint of joints) {
      for (const cameraId of joint.cameraIds) expect(['camera-1', 'camera-2', 'camera-3']).toContain(cameraId);
    }
  });

  it('is the same scene for the same seed and a different one for another', () => {
    expect(serializeSession(scene().session)).toBe(serializeSession(scene().session));
    expect(serializeSession(scene({seed: 2}).session)).not.toBe(serializeSession(scene().session));
  });

  it('loses people for spells and gives them new tracking IDs, which the truth does not', () => {
    const {session} = scene({occlusionRate: 2, identitySwitchRate: 2, seed: 7});
    const counts = session.events.flatMap((event) => (event.type === 'frame2d' ? [event.frame.persons.length] : []));
    expect(Math.min(...counts)).toBeLessThan(2);
    const trackingIds = new Set(
      session.events.flatMap((event) => (event.type === 'frame2d' ? event.frame.persons.map((person) => person.trackingId) : []))
    );
    expect(trackingIds.size).toBeGreaterThan(2);
    const truthIds = new Set((session.truth ?? []).flatMap((frame) => frame.persons.map((person) => person.personId)));
    expect([...truthIds]).toEqual(['person-1', 'person-2']);
  });
});

describe('replaying a session', () => {
  it('feeds every event to the service and collects the answers', () => {
    const {session} = scene();
    const replay = replaySession(session, {nowMs: counter()});
    expect(replay.framesSent).toBe(180);
    expect(replay.framesAccepted).toBe(180);
    expect(replay.requests).toBe(60);
    expect(replay.answers).toHaveLength(60);
    expect(replay.errors).toEqual([]);
    expect(replay.handleMs.length).toBe(241);
  });

  it('replaces the implementation without touching the session', () => {
    const {session} = scene();
    const replay = replaySession(session, {implementation: 'stub-timeout', nowMs: counter()});
    expect(replay.unanswered).toBe(60);
    expect(replay.answers).toEqual([]);
    expect(session.configuration.implementation).toBe('stub-normal');
  });

  it('reports refusals from the service rather than throwing', () => {
    const session: Session = {
      ...scene().session,
      events: [{type: 'frame2d', atUs: 1, cameraId: 'camera-1', frame: poseFrame('peer', 'wrong-calibration', 1)}]
    };
    const replay = replaySession(session, {nowMs: counter()});
    expect(replay.framesAccepted).toBe(0);
    expect(replay.errors[0]?.code).toBe('calibration-mismatch');
  });

  it('stops when the configuration is refused', () => {
    const broken: Session = {...scene().session, configuration: {...configuration(), cameras: []}};
    const replay = replaySession(broken, {nowMs: counter()});
    expect(replay.errors).toHaveLength(1);
    expect(replay.requests).toBe(0);
  });
});

describe('metrics', () => {
  it('shows no error for a service that answers with the truth', () => {
    const {session} = scene();
    const metrics = evaluate(session, replaySession(session, {service: oracle(session), nowMs: counter()}));
    expect(metrics.truth?.matchedFrames).toBe(60);
    expect(metrics.truth?.jointErrorMeters.max).toBe(0);
    expect(metrics.truth?.jointRecall).toBe(1);
    expect(metrics.truth?.identitySwitches).toBe(0);
    expect(metrics.truth?.personCountError.max).toBe(0);
    expect(metrics.handleMs.count).toBe(241);
  });

  it('measures how far a wrong answer is, in meters', () => {
    const {session} = scene();
    const metrics = evaluate(session, replaySession(session, {service: oracle(session, {shiftMeters: 0.25}), nowMs: counter()}));
    expect(metrics.truth?.jointErrorMeters.p50).toBeCloseTo(0.25, 5);
    // The stub stands its figures in a fixed row, which is metres from anybody.
    const stub = evaluate(session, replaySession(session, {nowMs: counter()}));
    expect(stub.truth?.jointErrorMeters.p50).toBeGreaterThan(1);
  });

  it('counts an identity switch when the same person is reported under another ID', () => {
    const {session} = scene();
    let flipped = false;
    const truthful = oracle(session);
    const swapping: ServiceHandler = {
      handle(message: unknown) {
        const answer = truthful.handle(message) as {type: string; payload: PoseFrame3DV2 | null};
        if (answer.type !== 'pose3d' || !answer.payload) return answer;
        flipped = !flipped;
        if (!flipped) return answer;
        return {
          ...answer,
          payload: {
            ...answer.payload,
            persons: answer.payload.persons.map((person) => ({...person, personId: `${person.personId}-again`}))
          }
        };
      }
    };
    const metrics = evaluate(session, replaySession(session, {service: swapping, nowMs: counter()}));
    expect(metrics.truth?.identitySwitches).toBeGreaterThan(50);
  });

  it('reports what it can for a session with no truth, and says so by leaving truth out', () => {
    const {session} = scene();
    const {truth: _truth, ...withoutTruth} = session;
    const metrics = evaluate(withoutTruth, replaySession(withoutTruth, {nowMs: counter()}));
    expect(metrics.truth).toBeUndefined();
    expect(metrics.answered).toBe(60);
    expect(formatMetrics(metrics)).toContain('implementation: stub-normal');
    expect(formatMetrics(metrics)).not.toContain('joint error');
  });
});

describe('sessions', () => {
  it('reads back what it wrote', () => {
    const {session} = scene();
    const parsed = parseSession(serializeSession(session));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.session.events).toHaveLength(session.events.length);
    expect(parsed.session.truth).toHaveLength(60);
  });

  it('refuses what it cannot replay', () => {
    const reasons = [
      parseSession('not json'),
      parseSession('[]'),
      parseSession(JSON.stringify({schema: 'other', version: 1})),
      parseSession(JSON.stringify({schema: 'twrmc/pose-3d-session', version: 2})),
      parseSession(JSON.stringify({schema: 'twrmc/pose-3d-session', version: 1, producer: 'x', configuration: {}, events: [{type: 'unknown', atUs: 0}]}))
    ];
    for (const reason of reasons) expect(reason.ok).toBe(false);
  });

  it('records what the service was given, keeping the newest events when it fills up', () => {
    const recorder = new SessionRecorder({producer: 'local-app', limit: 3});
    recorder.frame(1, 'cam-1', poseFrame('local', 'cal-1', 1));
    expect(recorder.session()).toBeUndefined();

    recorder.configured(configuration());
    for (let sequence = 0; sequence < 5; sequence += 1) {
      recorder.frame(sequence, 'cam-1', poseFrame('local', 'cal-1', sequence));
      recorder.request(sequence);
    }
    const session = recorder.session();
    expect(session?.events).toHaveLength(3);
    expect(session?.producer).toContain('events dropped');
    expect(recorder.droppedCount()).toBe(7);
    const last = session?.events.at(-1);
    expect(last).toMatchObject({type: 'requestPose3d', atUs: 4});

    recorder.clear();
    expect(recorder.session()).toBeUndefined();
    expect(recorder.eventCount()).toBe(0);
  });
});

/** Milliseconds that advance by one per read, so a duration is the number of reads. */
function counter(): () => number {
  let value = 0;
  return () => value++;
}

/** Guards the fixture the oracle leans on: the scene has to use the COCO-17 joints. */
it('uses the COCO-17 joints', () => {
  const {session} = scene();
  const joints = session.truth?.[0]?.persons[0]?.joints.map((joint) => joint.id);
  expect(joints).toEqual([...COCO_17_KEYPOINT_IDS]);
});

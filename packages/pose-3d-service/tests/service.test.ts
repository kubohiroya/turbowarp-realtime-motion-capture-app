import {describe, expect, it} from 'vitest';

import {Pose3dService} from '../src/service.ts';
import {configuration, frame} from './fixtures.ts';

const envelope = (id: number, type: string, payload: unknown) => ({interface: 'twrmc/pose-3d-service', version: 1, id, type, payload});

describe('Pose3dService (stub implementations)', () => {
  it('refuses frames before it is configured', () => {
    const service = new Pose3dService();
    expect(service.handle(envelope(1, 'frame2d', {cameraId: 'camera-1', frame: frame('camera-1', 'cal-1', 0)}))).toMatchObject({type: 'error', payload: {code: 'not-configured'}});
  });

  it('refuses an unknown camera and a frame of another calibration', () => {
    const service = new Pose3dService();
    service.handle(envelope(1, 'configure', configuration()));
    expect(service.handle(envelope(2, 'frame2d', {cameraId: 'camera-9', frame: frame('camera-9', 'cal-1', 0)}))).toMatchObject({payload: {code: 'unknown-camera'}});
    expect(service.handle(envelope(3, 'frame2d', {cameraId: 'camera-1', frame: frame('camera-1', 'cal-2', 0)}))).toMatchObject({payload: {code: 'calibration-mismatch'}});
  });

  it('answers stub-normal with the persons at least two cameras report, marked as the stub', () => {
    const service = new Pose3dService();
    service.handle(envelope(1, 'configure', configuration()));
    service.handle(envelope(2, 'frame2d', {cameraId: 'camera-1', frame: frame('camera-1', 'cal-1', 5, 3)}));
    service.handle(envelope(3, 'frame2d', {cameraId: 'camera-2', frame: frame('camera-2', 'cal-2', 4, 2)}));
    const answer = service.handle(envelope(4, 'requestPose3d', {timestampUs: null}));
    expect(answer).toMatchObject({type: 'pose3d', payload: {implementation: 'stub-normal', timestampUs: frame('camera-1', 'cal-1', 5).captureTimestampUs}});
    if (answer?.type !== 'pose3d' || !answer.payload) throw new Error('no frame');
    expect(answer.payload.persons.map((person) => person.personId)).toEqual(['stub-1', 'stub-2']);
    expect(answer.payload.persons[0]?.identitySource).toBe('stub');
  });

  it('names the configured cameras, not the peers, when several cameras share one peer', () => {
    // The local app estimates every camera in one page, so each frame's peer is the same.
    const service = new Pose3dService();
    service.handle(envelope(1, 'configure', configuration()));
    service.handle(envelope(2, 'frame2d', {cameraId: 'camera-2', frame: frame('local', 'cal-2', 1)}));
    service.handle(envelope(3, 'frame2d', {cameraId: 'camera-1', frame: frame('local', 'cal-1', 1)}));
    const answer = service.handle(envelope(4, 'requestPose3d', {timestampUs: null}));
    if (answer?.type !== 'pose3d' || !answer.payload) throw new Error('no frame');
    expect(answer.payload.persons[0]?.joints[0]?.cameraIds).toEqual(['camera-1', 'camera-2']);
  });

  it('never answers a 3D request as stub-timeout', () => {
    const service = new Pose3dService();
    service.handle(envelope(1, 'configure', configuration('stub-timeout')));
    expect(service.handle(envelope(2, 'requestPose3d', {timestampUs: null}))).toBeNull();
  });

  it('answers stub-invalid with a frame that breaks the contract', () => {
    const service = new Pose3dService();
    service.handle(envelope(1, 'configure', configuration('stub-invalid')));
    service.handle(envelope(2, 'frame2d', {cameraId: 'camera-1', frame: frame('camera-1', 'cal-1', 0)}));
    service.handle(envelope(3, 'frame2d', {cameraId: 'camera-2', frame: frame('camera-2', 'cal-2', 0)}));
    const answer = service.handle(envelope(4, 'requestPose3d', {timestampUs: null}));
    expect(answer?.type).toBe('pose3d');
    if (answer?.type !== 'pose3d' || !answer.payload) throw new Error('no frame');
    expect(answer.payload.persons[0]?.joints).toHaveLength(3);
  });

  it('refuses another interface version before touching its state', () => {
    const service = new Pose3dService();
    expect(service.handle({...envelope(1, 'configure', configuration()), version: 2})).toMatchObject({payload: {code: 'unsupported-version'}});
    expect(service.handle(envelope(2, 'requestPose3d', {timestampUs: null}))).toMatchObject({payload: {code: 'not-configured'}});
  });
});

import {describe, expect, it} from 'vitest';

import type {ServicePort} from '../src/client.ts';
import {Pose3dService} from '../src/service.ts';
import {installScratchStub} from './scratch-stub.ts';
import {frame, identity, model} from './fixtures.ts';

installScratchStub();
const {Pose3dServiceExtension} = await import('../src/extension.js');

function port(): ServicePort {
  const service = new Pose3dService();
  let listener: (message: unknown) => void = () => undefined;
  return {
    post: (message) => queueMicrotask(() => {
      const reply = service.handle(JSON.parse(JSON.stringify(message)));
      if (reply !== null) listener(reply);
    }),
    onMessage: (next) => {
      listener = next;
    },
    onFailure: () => undefined,
    close: () => undefined
  };
}

const placement = JSON.stringify({
  cameras: [
    {cameraId: 'camera-1', cameraFromReference: identity},
    {cameraId: 'camera-2', cameraFromReference: identity}
  ]
});

describe('Pose3dServiceExtension', () => {
  it('assembles a configuration camera by camera and reports the stub frame in both versions', async () => {
    const extension = new Pose3dServiceExtension(port);
    extension.beginConfiguration({IMPLEMENTATION: 'stub-normal', REFERENCE_ID: 'venue-projection'});
    extension.addCamera({CAMERA_ID: 'camera-1', MODEL_JSON: JSON.stringify(model('cal-1')), PLACEMENT_JSON: placement, TIME_JSON: ''});
    extension.addCamera({CAMERA_ID: 'camera-2', MODEL_JSON: JSON.stringify(model('cal-2')), PLACEMENT_JSON: placement, TIME_JSON: '{"uncertaintyUs":4000}'});
    await extension.applyConfiguration();
    expect(extension.serviceState()).toBe('ready');

    extension.sendPoseFrame({FRAME_JSON: JSON.stringify(frame('camera-1', 'cal-1', 1)), CAMERA_ID: 'camera-1', AGE_MS: 5});
    extension.sendPoseFrame({FRAME_JSON: JSON.stringify(frame('camera-2', 'cal-2', 1)), CAMERA_ID: 'camera-2', AGE_MS: 5});
    await new Promise((resolve) => setTimeout(resolve, 0));
    await extension.requestPose3d();

    expect(JSON.parse(extension.latestPose3dJson())).toMatchObject({version: 2, implementation: 'stub-normal'});
    expect(JSON.parse(extension.latestPose3dV1Json())).toMatchObject({version: 1});
    expect(JSON.parse(extension.serviceStatusJson())).toMatchObject({state: 'ready', framesSent: 2, persons: 2});
    expect(extension.serviceError()).toBe('');
  });

  it('reports a camera missing from the placement as a configuration error', async () => {
    const extension = new Pose3dServiceExtension(port);
    extension.beginConfiguration({IMPLEMENTATION: 'stub-normal', REFERENCE_ID: 'venue-projection'});
    extension.addCamera({CAMERA_ID: 'camera-1', MODEL_JSON: JSON.stringify(model('cal-1')), PLACEMENT_JSON: placement, TIME_JSON: ''});
    extension.addCamera({CAMERA_ID: 'camera-9', MODEL_JSON: JSON.stringify(model('cal-9')), PLACEMENT_JSON: placement, TIME_JSON: ''});
    await extension.applyConfiguration();
    expect(extension.serviceState()).toBe('error');
    expect(extension.serviceError()).toMatch(/^invalid-payload: Camera camera-9 cameraFromReference/);
  });

  it('clears everything when stopped', async () => {
    const extension = new Pose3dServiceExtension(port);
    extension.stopService();
    expect(extension.serviceState()).toBe('idle');
    expect(extension.latestPose3dJson()).toBe('');
  });
});

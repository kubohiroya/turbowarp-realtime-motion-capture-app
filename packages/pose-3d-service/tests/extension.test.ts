import { describe, expect, it } from 'vitest';

import type { ServicePort } from '../src/client.ts';
import { Pose3dService } from '../src/service.ts';
import { installScratchStub } from './scratch-stub.ts';
import { frame, identity, model } from './fixtures.ts';

installScratchStub();
const { Pose3dServiceExtension } = await import('../src/extension.js');

function port(): ServicePort {
  const service = new Pose3dService();
  let listener: (message: unknown) => void = () => undefined;
  return {
    post: (message) =>
      queueMicrotask(() => {
        const reply = service.handle(JSON.parse(JSON.stringify(message)));
        if (reply !== null) listener(reply);
      }),
    onMessage: (next) => {
      listener = next;
    },
    onFailure: () => undefined,
    close: () => undefined,
  };
}

const placement = JSON.stringify({
  cameras: [
    { cameraId: 'camera-1', cameraFromReference: identity },
    { cameraId: 'camera-2', cameraFromReference: identity },
  ],
});

describe('Pose3dServiceExtension', () => {
  it('assembles a configuration camera by camera and reports the stub frame in both versions', async () => {
    const extension = new Pose3dServiceExtension(port);
    extension.beginConfiguration({
      IMPLEMENTATION: 'stub-normal',
      REFERENCE_ID: 'venue-projection',
    });
    extension.addCamera({
      CAMERA_ID: 'camera-1',
      MODEL_JSON: JSON.stringify(model('cal-1')),
      PLACEMENT_JSON: placement,
      TIME_JSON: '',
    });
    extension.addCamera({
      CAMERA_ID: 'camera-2',
      MODEL_JSON: JSON.stringify(model('cal-2')),
      PLACEMENT_JSON: placement,
      TIME_JSON: '{"uncertaintyUs":4000}',
    });
    await extension.applyConfiguration();
    expect(extension.serviceState()).toBe('ready');

    extension.sendPoseFrame({
      FRAME_JSON: JSON.stringify(frame('camera-1', 'cal-1', 1)),
      CAMERA_ID: 'camera-1',
      AGE_MS: 5,
    });
    extension.sendPoseFrame({
      FRAME_JSON: JSON.stringify(frame('camera-2', 'cal-2', 1)),
      CAMERA_ID: 'camera-2',
      AGE_MS: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await extension.requestPose3d();

    expect(JSON.parse(extension.latestPose3dJson())).toMatchObject({
      version: 2,
      implementation: 'stub-normal',
    });
    expect(JSON.parse(extension.latestPose3dV1Json())).toMatchObject({
      version: 1,
    });
    expect(JSON.parse(extension.serviceStatusJson())).toMatchObject({
      state: 'ready',
      framesSent: 2,
      persons: 2,
    });
    expect(extension.serviceError()).toBe('');

    extension.updateAvatarPoses({ SLOTS: 6, HOLD_MS: 1000 });
    const avatar3d = JSON.parse(extension.avatarPose3dJson()) as {
      version: number;
      persons: Array<{ personId: string }>;
    };
    expect(avatar3d.version).toBe(1);
    expect(avatar3d.persons.map((person) => person.personId)).toEqual([
      'slot-1',
      'slot-2',
    ]);
    expect(JSON.parse(extension.avatarPose2dJson())).toMatchObject({
      schema: 'twrmc/pose-frame-2d',
      version: 1,
    });
    expect(JSON.parse(extension.avatarSlotsJson())).toHaveLength(2);
  });

  it('reports a camera missing from the placement as a configuration error', async () => {
    const extension = new Pose3dServiceExtension(port);
    extension.beginConfiguration({
      IMPLEMENTATION: 'stub-normal',
      REFERENCE_ID: 'venue-projection',
    });
    extension.addCamera({
      CAMERA_ID: 'camera-1',
      MODEL_JSON: JSON.stringify(model('cal-1')),
      PLACEMENT_JSON: placement,
      TIME_JSON: '',
    });
    extension.addCamera({
      CAMERA_ID: 'camera-9',
      MODEL_JSON: JSON.stringify(model('cal-9')),
      PLACEMENT_JSON: placement,
      TIME_JSON: '',
    });
    await extension.applyConfiguration();
    expect(extension.serviceState()).toBe('error');
    expect(extension.serviceError()).toMatch(
      /^invalid-payload: Camera camera-9 cameraFromReference/,
    );
  });

  it('extrapolates the fused frame when a prediction lead is set', async () => {
    const extension = new Pose3dServiceExtension(port);
    extension.setPredictionLead({ LEAD_MS: 30 });
    extension.beginConfiguration({
      IMPLEMENTATION: 'fusion-v0',
      REFERENCE_ID: 'venue-projection',
    });
    for (const cameraId of ['camera-1', 'camera-2']) {
      extension.addCamera({
        CAMERA_ID: cameraId,
        MODEL_JSON: JSON.stringify(
          model(cameraId === 'camera-1' ? 'cal-1' : 'cal-2'),
        ),
        PLACEMENT_JSON: placement,
        TIME_JSON: '',
      });
    }
    await extension.applyConfiguration();
    expect(extension.serviceState()).toBe('ready');
    // No frame has arrived yet, so there is nothing to predict from: the request still answers.
    await extension.requestPose3d();
    expect(extension.serviceState()).toBe('ready');
  });

  it('reports the avatar stage, and why axes or corners cannot be used', () => {
    const extension = new Pose3dServiceExtension(port);
    expect(
      JSON.parse(
        extension.avatarStageJson({
          CORNERS: '0,0;2,0;2,1.5;0,1.5',
          DISTANCE_M: 4,
        }),
      ),
    ).toMatchObject({ wallX: 1, wallWidth: 2, cameraZ: 4 });
    expect(extension.avatarStageError()).toBe('');
    extension.setAvatarAxes({ UP: '-y', AUDIENCE: '-y' });
    expect(extension.avatarStageError()).toMatch(/perpendicular/u);
    expect(extension.avatarStageJson({ CORNERS: 'none', DISTANCE_M: 4 })).toBe(
      '',
    );
    expect(extension.avatarStageError()).toMatch(/tlX,tlY/u);
  });

  it('clears everything when stopped', async () => {
    const extension = new Pose3dServiceExtension(port);
    extension.stopService();
    expect(extension.serviceState()).toBe('idle');
    expect(extension.latestPose3dJson()).toBe('');
    extension.updateAvatarPoses({ SLOTS: 6, HOLD_MS: 1000 });
    expect(extension.avatarPose3dJson()).toBe('');
    expect(extension.avatarPose2dJson()).toBe('');
    expect(extension.avatarSlotsJson()).toBe('[]');
  });
});

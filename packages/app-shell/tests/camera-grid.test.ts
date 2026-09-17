import {describe, expect, it} from 'vitest';

import {CameraGrid, constraintsFor, type CameraSourcePort} from '../src/camera-grid.js';
import {createSettingsStore, type StorageLike} from '../src/settings.js';

interface FakeTrack {
  label: string;
  readyState: 'live' | 'ended';
  getSettings(): MediaTrackSettings;
}

/** A Camera Source stand-in: one video element per camera ID, frames delivered on demand. */
function fakeSource(options: {refuse?: string} = {}) {
  const acquired: Array<{cameraId: string; video?: MediaTrackConstraints}> = [];
  const released: string[] = [];
  const frameCallbacks = new Map<string, () => void>();
  const tracks = new Map<string, FakeTrack>();
  const source: CameraSourcePort = {
    async acquireCamera(request) {
      acquired.push({cameraId: request.cameraId, ...(request.video ? {video: request.video} : {})});
      if (options.refuse === request.cameraId) {
        throw Object.assign(new Error('Requested device not found'), {name: 'NotFoundError'});
      }
      const ideal = (value: unknown) => ((value as {ideal?: number} | undefined)?.ideal ?? 0);
      const track: FakeTrack = {
        label: `USB Camera (${request.cameraId})`,
        readyState: 'live',
        getSettings: () => ({width: ideal(request.video?.width), height: ideal(request.video?.height), frameRate: 30, deviceId: `device-${request.cameraId}`})
      };
      tracks.set(request.cameraId, track);
      const element = {
        srcObject: {getVideoTracks: () => [track]},
        requestVideoFrameCallback: (callback: () => void) => {
          frameCallbacks.set(request.cameraId, callback);
          return 1;
        },
        cancelVideoFrameCallback: () => frameCallbacks.delete(request.cameraId)
      } as unknown as HTMLVideoElement;
      return {
        getFrameSource: () => ({element, width: 1280, height: 720}),
        release: async () => {
          released.push(request.cameraId);
        }
      };
    }
  };
  return {source, acquired, released, frameCallbacks, tracks};
}

function grid(source: CameraSourcePort | null, clock = {now: 0}) {
  return new CameraGrid({document: null, resolveMount: () => null, cameraSource: () => source, nowMs: () => clock.now});
}

const request = (cameraId: string, deviceId: string, width = 1280, height = 720, frameRate = 30) => ({cameraId, deviceId, width, height, frameRate});

describe('CameraGrid', () => {
  it('asks Camera Source for the size and frame rate as ideal values on the chosen device', async () => {
    const {source, acquired} = fakeSource();
    await grid(source).start(request('cam-1', 'usb-a', 1920, 1080, 60));
    expect(acquired[0]).toEqual({
      cameraId: 'cam-1',
      video: {deviceId: {exact: 'usb-a'}, width: {ideal: 1920}, height: {ideal: 1080}, frameRate: {ideal: 60}}
    });
  });

  it('reports the request, the track settings and the frame rate actually delivered', async () => {
    const clock = {now: 0};
    const {source, frameCallbacks} = fakeSource();
    const cameras = grid(source, clock);
    await cameras.start(request('cam-1', 'usb-a'));
    for (let frame = 1; frame <= 24; frame += 1) {
      clock.now = (frame * 1000) / 24;
      frameCallbacks.get('cam-1')?.();
    }
    expect(cameras.report('cam-1')).toMatchObject({
      state: 'running',
      requested: {width: 1280, height: 720, frameRate: 30},
      settings: {width: 1280, height: 720, frameRate: 30},
      measuredFps: 24,
      label: 'USB Camera (cam-1)'
    });
  });

  it('refuses a device another camera ID already uses', async () => {
    const {source, acquired} = fakeSource();
    const cameras = grid(source);
    await cameras.start(request('cam-1', 'usb-a'));
    expect(await cameras.start(request('cam-2', 'usb-a'))).toBe('error');
    expect(cameras.report('cam-2')?.error).toMatch(/^device-in-use: cam-1/);
    expect(acquired).toHaveLength(1);
  });

  it('restarts a camera ID with a new request and releases the old lease first', async () => {
    const {source, released, acquired} = fakeSource();
    const cameras = grid(source);
    await cameras.start(request('cam-1', 'usb-a', 640, 480));
    await cameras.start(request('cam-1', 'usb-a', 1280, 720));
    expect(released).toEqual(['cam-1']);
    expect(acquired.map((entry) => (entry.video?.width as {ideal: number}).ideal)).toEqual([640, 1280]);
  });

  it('keeps the browser error when a camera cannot start', async () => {
    const {source} = fakeSource({refuse: 'cam-2'});
    const cameras = grid(source);
    await cameras.start(request('cam-2', 'usb-b'));
    expect(cameras.report('cam-2')).toMatchObject({state: 'error', error: 'NotFoundError: Requested device not found'});
  });

  it('reads an unplugged camera as ended', async () => {
    const {source, tracks} = fakeSource();
    const cameras = grid(source);
    await cameras.start(request('cam-1', 'usb-a'));
    const track = tracks.get('cam-1');
    if (track) track.readyState = 'ended';
    expect(cameras.report('cam-1')).toMatchObject({state: 'ended', measuredFps: 0});
  });

  it('reports cameras in ID order and forgets stopped ones', async () => {
    const {source, frameCallbacks} = fakeSource();
    const cameras = grid(source);
    await cameras.start(request('cam-2', 'usb-b'));
    await cameras.start(request('cam-1', 'usb-a'));
    expect(cameras.reports().map((report) => report.cameraId)).toEqual(['cam-1', 'cam-2']);
    await cameras.stopAll();
    expect(cameras.reports()).toEqual([]);
    expect(frameCallbacks.size).toBe(0);
  });

  it('fails clearly without Camera Source', async () => {
    const cameras = grid(null);
    expect(await cameras.start(request('cam-1', ''))).toBe('error');
    expect(cameras.report('cam-1')?.error).toMatch(/^camera-source-missing/);
  });

  it('leaves out constraints that were not asked for', () => {
    expect(constraintsFor(request('cam-1', '', 0, 0, 0))).toEqual({});
  });
});

describe('createSettingsStore', () => {
  it('keeps settings under the application prefix and reads a missing one as empty', () => {
    const map = new Map<string, string>();
    const storage: StorageLike = {getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value)};
    const settings = createSettingsStore('twrmc.local', () => storage);
    settings.set('cameras', '{"cam-1":"usb-a"}');
    expect(map.get('twrmc.local:cameras')).toBe('{"cam-1":"usb-a"}');
    expect(settings.get('cameras')).toBe('{"cam-1":"usb-a"}');
    expect(settings.get('other')).toBe('');
  });

  it('degrades to nothing remembered when storage refuses', () => {
    const refusing: StorageLike = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      }
    };
    const settings = createSettingsStore('twrmc.local', () => refusing);
    expect(() => settings.set('cameras', '{}')).not.toThrow();
    expect(settings.get('cameras')).toBe('');
  });
});

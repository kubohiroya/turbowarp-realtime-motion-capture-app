import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {LENS_CALIBRATION_FILE_ACCEPT} from '../src/lens-calibration.js';

/**
 * The lens calibration file, read the way camera app reads it.
 *
 * `fixtures/lens-calibration-profile.yaml` is the file turbowarp-camera-calibration-app exports (its
 * contract fixture at 657f1ff): a ROS camera_info YAML document. It is fed to the Camera Source bundle
 * camera app embeds -- the published artifact, not a copy of its rules -- in the order camera app's
 * "load a lens calibration file" script calls it: register the text as `pose`, stop on an error, and
 * use the profile only when the running camera is `compatible` with it.
 */
const exported = readFileSync(new URL('./fixtures/lens-calibration-profile.yaml', import.meta.url), 'utf8');

const require = createRequire(import.meta.url);
const bundle = readFileSync(require.resolve('@kubohiroya/turbowarp-camera-source/camera-source.js'), 'utf8');

interface CameraSourceBlocks {
  startSharedCamera(args: {CAMERA_ID: string}): Promise<void>;
  registerCameraProfileAs(args: {PROFILE_JSON: string; CAMERA_ID: string}): void;
  forgetCameraProfile(args: {CAMERA_ID: string}): void;
  cameraProfileError(): string;
  cameraProfileErrorDetail(): string;
  cameraProfileCompatibility(args: {CAMERA_ID: string}): string;
  cameraProfileJson(args: {CAMERA_ID: string}): string;
}

function loadCameraSource(): CameraSourceBlocks {
  let registered: unknown;
  const scratch = {
    vm: {runtime: {on: vi.fn(), off: vi.fn()}},
    extensions: {unsandboxed: true, register: (extension: unknown) => (registered = extension)},
    BlockType: {COMMAND: 'command', REPORTER: 'reporter', BOOLEAN: 'boolean', HAT: 'hat'},
    ArgumentType: {STRING: 'string', NUMBER: 'number', BOOLEAN: 'boolean'},
    Cast: {toString: (value: unknown) => String(value ?? '')},
    translate: (message: string) => message
  };
  new Function('Scratch', bundle)(scratch);
  return registered as CameraSourceBlocks;
}

/** A camera delivering frames of the given size, reporting the controls the calibration recorded. */
function runningCamera(width: number, height: number, settings: Record<string, unknown>): void {
  const track = {
    readyState: 'live',
    getSettings: () => ({deviceId: 'cam-1', ...settings}),
    stop: vi.fn(),
    addEventListener: vi.fn()
  };
  const stream = {active: true, getVideoTracks: () => [track], getTracks: () => [track]};
  const video = {videoWidth: width, videoHeight: height, play: vi.fn(async () => undefined)};
  vi.stubGlobal('navigator', {
    mediaDevices: {getUserMedia: vi.fn(async () => stream), enumerateDevices: vi.fn(async () => [])}
  });
  vi.stubGlobal('document', {createElement: vi.fn(() => video)});
}

/** What camera app's script decides, step for step. */
async function loadLensCalibrationFile(camera: CameraSourceBlocks, text: string): Promise<string> {
  camera.registerCameraProfileAs({PROFILE_JSON: text, CAMERA_ID: 'pose'});
  if (camera.cameraProfileError() !== '') return 'invalid';
  if (camera.cameraProfileCompatibility({CAMERA_ID: 'pose'}) === 'compatible') return 'used';
  camera.forgetCameraProfile({CAMERA_ID: 'pose'});
  return 'withdrawn';
}

const calibratedSettings = {frameRate: 30, resizeMode: 'none', zoom: 1, focusMode: 'continuous'};

beforeEach(() => {
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('indexedDB', undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the lens calibration file', () => {
  it('can be picked under every name it travels with', () => {
    // TurboWarp saves the calibration app's list export as .txt; ROS tools want .yaml.
    for (const extension of ['.txt', '.yaml', '.yml', '.json']) {
      expect(LENS_CALIBRATION_FILE_ACCEPT.split(',')).toContain(extension);
    }
  });

  it('is used on the camera it was calibrated on', async () => {
    runningCamera(1280, 720, calibratedSettings);
    const camera = loadCameraSource();
    await camera.startSharedCamera({CAMERA_ID: 'pose'});
    expect(await loadLensCalibrationFile(camera, exported)).toBe('used');
    expect(JSON.parse(camera.cameraProfileJson({CAMERA_ID: 'pose'})).cameraId).toBe('pose');
  });

  it('is withdrawn from a camera at another resolution, rather than used', async () => {
    runningCamera(640, 480, calibratedSettings);
    const camera = loadCameraSource();
    await camera.startSharedCamera({CAMERA_ID: 'pose'});
    expect(await loadLensCalibrationFile(camera, exported)).toBe('withdrawn');
    expect(camera.cameraProfileJson({CAMERA_ID: 'pose'})).toBe('');
  });

  it('is withdrawn from a camera zoomed differently', async () => {
    runningCamera(1280, 720, {...calibratedSettings, zoom: 2});
    const camera = loadCameraSource();
    await camera.startSharedCamera({CAMERA_ID: 'pose'});
    expect(await loadLensCalibrationFile(camera, exported)).toBe('withdrawn');
  });

  it('is refused, with the member named, when the text is not a calibration', async () => {
    runningCamera(1280, 720, calibratedSettings);
    const camera = loadCameraSource();
    await camera.startSharedCamera({CAMERA_ID: 'pose'});
    const broken = exported.replace('rows: 3\n  cols: 3\n  data: [912.4371', 'rows: 3\n  cols: 3\n  data: [0');
    expect(await loadLensCalibrationFile(camera, broken)).toBe('invalid');
    expect(camera.cameraProfileErrorDetail()).toMatch(/intrinsics\.fx|camera_matrix/);
  });
});

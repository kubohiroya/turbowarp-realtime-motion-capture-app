import {describe, expect, it, vi} from 'vitest';

import {
  chooseTextFileWithDialog,
  lensCalibrationRequestParameters,
  lensCalibrationRoute,
  LensCalibrationLauncher,
  type LensCalibrationHost
} from '../src/lens-calibration.js';
import {fakeDocument, fakeElement, findByText} from './fake-dom.js';

function host(overrides: Partial<LensCalibrationHost> = {}): LensCalibrationHost {
  return {
    resolveUrl: () => 'http://127.0.0.1:49711/lens-calibration?token=t',
    isServed: async () => true,
    openWindow: () => ({closed: false}),
    chooseTextFile: async () => null,
    ...overrides
  };
}

describe('LensCalibrationLauncher', () => {
  it('keeps the route the venue host serves', () => {
    // packages/local-host/src/host.ts serves the calibration app at the same literal.
    expect(lensCalibrationRoute).toBe('/lens-calibration');
  });

  it('opens the calibration app and reads closed once the operator closes the window', async () => {
    const window = {closed: false};
    const launcher = new LensCalibrationLauncher(host({openWindow: () => window}));

    await expect(launcher.open()).resolves.toBe('open');
    expect(launcher.isOpen()).toBe(true);

    window.closed = true;
    expect(launcher.state()).toBe('closed');
    expect(launcher.isOpen()).toBe(false);
  });

  it('brings an open window forward instead of opening a second one', async () => {
    const focus = vi.fn();
    const openWindow = vi.fn(() => ({closed: false, focus}));
    const launcher = new LensCalibrationLauncher(host({openWindow}));

    await launcher.open();
    await launcher.open();

    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('names the camera and its size for one of several cameras', async () => {
    const resolveUrl = vi.fn(() => 'http://127.0.0.1:49713/lens-calibration?token=t');
    const launcher = new LensCalibrationLauncher(host({resolveUrl}));
    const request = {deviceId: 'device-b', width: 1280, height: 720, frameRate: 30};

    await expect(launcher.open(request)).resolves.toBe('open');

    expect(resolveUrl).toHaveBeenCalledWith(request);
    expect(lensCalibrationRequestParameters(request)).toEqual([
      ['cameraDeviceId', 'device-b'],
      ['cameraWidth', '1280'],
      ['cameraHeight', '720'],
      ['cameraFrameRate', '30']
    ]);
    expect(lensCalibrationRequestParameters({...request, frameRate: Number.NaN})).toHaveLength(3);
  });

  it('leaves a window open for another camera alone and reports busy', async () => {
    const window = {closed: false, focus: vi.fn()};
    const openWindow = vi.fn(() => window);
    const launcher = new LensCalibrationLauncher(host({openWindow}));
    const cameraA = {deviceId: 'device-a', width: 1280, height: 720, frameRate: 30};

    await launcher.open(cameraA);
    await expect(launcher.open({...cameraA, deviceId: 'device-b'})).resolves.toBe('busy');
    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(launcher.isOpen()).toBe(true);

    // The same camera again brings it forward.
    await expect(launcher.open(cameraA)).resolves.toBe('open');
    expect(window.focus).toHaveBeenCalledTimes(1);

    window.closed = true;
    expect(launcher.state()).toBe('closed');
    await expect(launcher.open({...cameraA, deviceId: 'device-b'})).resolves.toBe('open');
    expect(openWindow).toHaveBeenCalledTimes(2);
  });

  it('is unavailable on a page with no origin to serve the calibration app from', async () => {
    const openWindow = vi.fn(() => ({closed: false}));
    const launcher = new LensCalibrationLauncher(host({resolveUrl: () => null, openWindow}));

    await expect(launcher.open()).resolves.toBe('unavailable');
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('is unavailable when the host carries no calibration app, or cannot be asked', async () => {
    const missing = new LensCalibrationLauncher(host({isServed: async () => false}));
    const failing = new LensCalibrationLauncher(
      host({isServed: () => Promise.reject(new Error('offline'))})
    );

    await expect(missing.open()).resolves.toBe('unavailable');
    await expect(failing.open()).resolves.toBe('unavailable');
  });

  it('reports a window the browser refused as blocked', async () => {
    const launcher = new LensCalibrationLauncher(host({openWindow: () => null}));

    await expect(launcher.open()).resolves.toBe('blocked');
    expect(launcher.state()).toBe('blocked');
  });

  it('keeps the chosen file text and clears it when a later choice is abandoned', async () => {
    const choices = ['{"schema":"twcs/camera-intrinsics"}', null];
    const launcher = new LensCalibrationLauncher(
      host({chooseTextFile: async () => choices.shift() ?? null})
    );

    await launcher.chooseFile();
    expect(launcher.chosenFileText()).toBe('{"schema":"twcs/camera-intrinsics"}');

    await launcher.chooseFile();
    expect(launcher.chosenFileText()).toBe('');
  });
});

describe('chooseTextFileWithDialog', () => {
  it('resolves null and removes the dialog when the operator cancels', async () => {
    const mount = fakeElement('body');
    const choice = chooseTextFileWithDialog({
      document: fakeDocument(),
      mount: mount as unknown as HTMLElement,
      locale: 'ja'
    });

    expect(mount.children).toHaveLength(1);
    findByText(mount, 'やめる')[0]?.click();

    await expect(choice).resolves.toBeNull();
    expect(mount.children).toHaveLength(0);
  });

  it('opens the file picker from the dialog button', () => {
    const mount = fakeElement('body');
    void chooseTextFileWithDialog({
      document: fakeDocument(),
      mount: mount as unknown as HTMLElement,
      locale: 'en'
    });
    const input = findInput(mount);
    const picked = vi.fn();
    input?.addEventListener('click', picked);

    findByText(mount, 'Choose file')[0]?.click();

    expect(picked).toHaveBeenCalledTimes(1);
  });
});

function findInput(element: ReturnType<typeof fakeElement>): ReturnType<typeof fakeElement> | null {
  if (element.tagName === 'input') return element;
  for (const child of element.children) {
    const found = findInput(child);
    if (found !== null) return found;
  }
  return null;
}

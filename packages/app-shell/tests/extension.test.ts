import {beforeAll, describe, expect, it, vi} from 'vitest';

import {installScratchStub} from './scratch-stub.js';

installScratchStub();

const {cameraAppConfig} = await import('../src/apps/camera.js');
const {fusionAppConfig} = await import('../src/apps/fusion.js');
const {LensCalibrationLauncher} = await import('../src/lens-calibration.js');
const {MultiviewPoseAppShellExtension} = await import('../src/extension.js');
const {createMultiviewPoseShell} = await import('../src/shell.js');
const {resolveFeatureFlags} = await import('../src/feature-flags.js');
const {fakeDocument, fakeElement} = await import('./fake-dom.js');

interface ShellCall {
  readonly name: string;
  readonly args: readonly unknown[];
}

function createExtension() {
  const calls: ShellCall[] = [];
  const mount = fakeElement('div');
  const shell = createMultiviewPoseShell(cameraAppConfig, {
    document: fakeDocument(),
    resolveMount: () => mount as unknown as HTMLElement,
    resolveLocale: () => 'ja'
  });
  const recording = new Proxy(shell, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push({name: String(property), args});
        return (value as (...input: unknown[]) => unknown).apply(target, args);
      };
    }
  });
  const flags = {flags: resolveFeatureFlags(cameraAppConfig.featureFlags), state: 'applied'} as const;
  const launcher = new LensCalibrationLauncher({
    resolveUrl: () => null,
    isServed: async () => false,
    openWindow: () => null,
    chooseTextFile: async () => null
  });
  return {
    calls,
    extension: new MultiviewPoseAppShellExtension(cameraAppConfig, recording, flags, {
      lensCalibration: launcher
    })
  };
}

describe('getInfo', () => {
  let info: Record<string, unknown>;

  beforeAll(() => {
    info = createExtension().extension.getInfo();
  });

  it('registers under the configured extension identity', () => {
    expect(info['id']).toBe(cameraAppConfig.id);
    expect(info['name']).toBe(cameraAppConfig.name);
  });

  it('leaves the title, menu, and DSL surface to turbowarp-title-menu', () => {
    const blocks = info['blocks'] as Array<Record<string, unknown>>;
    const opcodes = blocks.map((block) => block['opcode']);
    expect(blocks).toHaveLength(20);
    for (const absent of ['whenAppMenuActionSelected', 'setAppStatus', 'setAppMenuActionEnabled']) {
      expect(opcodes).not.toContain(absent);
    }
    expect(Object.keys(info['menus'] as Record<string, unknown>)).toEqual(['featureFlags']);
  });

  it('offers the lens calibration blocks only to an application given a launcher', () => {
    const fusionShell = createMultiviewPoseShell(fusionAppConfig, {
      document: fakeDocument(),
      resolveMount: () => fakeElement('div') as unknown as HTMLElement
    });
    const fusion = new MultiviewPoseAppShellExtension(fusionAppConfig, fusionShell, {
      flags: resolveFeatureFlags(fusionAppConfig.featureFlags),
      state: 'applied'
    });
    const fusionOpcodes = (fusion.getInfo()['blocks'] as Array<Record<string, unknown>>).map(
      (block) => block['opcode']
    );
    expect(fusionOpcodes).toHaveLength(15);
    expect(fusionOpcodes).not.toContain('openLensCalibrationApp');

    const cameraOpcodes = (info['blocks'] as Array<Record<string, unknown>>).map(
      (block) => block['opcode']
    );
    expect(cameraOpcodes).toEqual(
      expect.arrayContaining([
        'openLensCalibrationApp',
        'lensCalibrationAppState',
        'lensCalibrationAppOpen',
        'chooseLensCalibrationFile',
        'chosenLensCalibrationFile'
      ])
    );
  });

  it('exposes every contract feature flag in the feature dropdown', () => {
    const menus = info['menus'] as Record<string, {items: string[]}>;
    expect(menus['featureFlags']?.items).toContain('poseFusion3D');
  });
});

describe('shell blocks', () => {
  it('clamps a loading percentage into the 0..1 progress range', () => {
    const {calls, extension} = createExtension();
    extension.showAppLoadingProgress({LABEL: 'Calibrating', PERCENT: 140});
    extension.showAppLoadingProgress({LABEL: 'Calibrating', PERCENT: -20});
    expect(calls.map((call) => call.args[1])).toEqual([1, 0]);
  });

  it('sends an indeterminate loading state as a null progress', () => {
    const {calls, extension} = createExtension();
    extension.showAppLoading({LABEL: 'Starting'});
    expect(calls[0]).toEqual({name: 'showLoading', args: ['Starting', null]});
  });

  it('renders only a JSON object as error details', () => {
    const {calls, extension} = createExtension();
    extension.showAppError({MESSAGE: 'stopped', DETAILS: '{"code":"E1"}'});
    extension.showAppError({MESSAGE: 'stopped', DETAILS: '[1,2]'});
    extension.showAppError({MESSAGE: 'stopped', DETAILS: 'not json'});
    expect(calls.map((call) => call.args[1])).toEqual([{code: 'E1'}, {}, {}]);
  });

  it('keeps a notice off the failure path', () => {
    const {calls, extension} = createExtension();
    extension.showAppNotice({MESSAGE: 'two cameras are connected'});
    expect(calls[0]?.name).toBe('showNotice');
  });

});

describe('diagnostic reporters', () => {
  it('reports the flag application state so a misordered bundle is visible', () => {
    const {extension} = createExtension();
    expect(extension.appFeatureFlagState()).toBe('applied');
  });

  it('reports only the flags this application requested', () => {
    const {extension} = createExtension();
    expect(extension.appFeatureEnabled({FEATURE: 'cameraCalibrationV1'})).toBe(true);
    expect(extension.appFeatureEnabled({FEATURE: 'poseFusion3D'})).toBe(false);
    expect(extension.appFeatureEnabled({FEATURE: 'nonsense'})).toBe(false);
  });

  it('reports the resolved locale and the shell state', () => {
    const {extension} = createExtension();
    expect(extension.appLocale()).toBe('ja');
    expect(extension.appShellState()).toBe('unmounted');
  });

  it('reports WebGPU only when the browser can provide an adapter', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const requestAdapter = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('adapter unavailable'));
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {gpu: {requestAdapter}}
    });
    try {
      const extension = createExtension().extension;
      await expect(extension.webGpuAvailable()).resolves.toBe(true);
      await expect(extension.webGpuAvailable()).resolves.toBe(false);
      await expect(extension.webGpuAvailable()).resolves.toBe(false);

      Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {}});
      await expect(extension.webGpuAvailable()).resolves.toBe(false);
    } finally {
      if (original === undefined) delete (globalThis as {navigator?: unknown}).navigator;
      else Object.defineProperty(globalThis, 'navigator', original);
    }
  });
});

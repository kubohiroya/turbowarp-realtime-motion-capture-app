import {beforeAll, describe, expect, it} from 'vitest';

import {installScratchStub} from './scratch-stub.js';

installScratchStub();

const {cameraAppConfig} = await import('../src/apps/camera.js');
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
  return {calls, extension: new MultiviewPoseAppShellExtension(cameraAppConfig, recording, flags)};
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
    expect(blocks).toHaveLength(10);
    for (const absent of ['whenAppMenuActionSelected', 'setAppStatus', 'setAppMenuActionEnabled']) {
      expect(opcodes).not.toContain(absent);
    }
    expect(Object.keys(info['menus'] as Record<string, unknown>)).toEqual(['featureFlags']);
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
});

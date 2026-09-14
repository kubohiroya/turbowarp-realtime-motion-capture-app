import {describe, expect, it} from 'vitest';

import {cameraAppConfig} from '../src/apps/camera.js';
import {createMultiviewPoseShell, type ShellHost} from '../src/shell.js';

import {fakeDocument, fakeElement, type FakeElement} from './fake-dom.js';

function collect(element: FakeElement): FakeElement[] {
  return [element, ...element.children.flatMap((child) => collect(child))];
}

function createHost(overrides: Partial<ShellHost> = {}) {
  const mount = fakeElement('div');
  const host: ShellHost = {
    document: fakeDocument(),
    resolveMount: () => mount as unknown as HTMLElement,
    resolveLocale: () => 'ja',
    ...overrides
  };
  return {host, mount};
}

describe('createMultiviewPoseShell', () => {
  it('defers mounting until a block actually uses the shell', () => {
    const {host, mount} = createHost();
    const shell = createMultiviewPoseShell(cameraAppConfig, host);

    expect(shell.state()).toBe('unmounted');
    expect(mount.children).toHaveLength(0);

    shell.showLoading('Starting', null);
    expect(shell.state()).toBe('ready');
    expect(mount.children.length).toBeGreaterThan(0);
  });

  it('stays unmounted while the renderer has no stage container', () => {
    const {host} = createHost({resolveMount: () => null});
    const shell = createMultiviewPoseShell(cameraAppConfig, host);

    shell.showLoading('Starting', null);
    expect(shell.state()).toBe('unmounted');
  });

  it('degrades to unavailable instead of throwing into an SB3 script', () => {
    const brokenDocument = {
      createElement() {
        throw new Error('no DOM');
      }
    } as unknown as Document;
    const {host} = createHost({document: brokenDocument});
    const shell = createMultiviewPoseShell(cameraAppConfig, host);

    expect(() => shell.showError('stopped', {})).not.toThrow();
    expect(shell.state()).toBe('unavailable');
  });

  it('resolves the locale through the injected host', () => {
    const {host} = createHost();
    expect(createMultiviewPoseShell(cameraAppConfig, host).locale).toBe('ja');
  });

  it('mounts the overlays when a notice is shown', () => {
    const {host, mount} = createHost();
    const shell = createMultiviewPoseShell(cameraAppConfig, host);

    shell.showNotice('two cameras are connected');

    expect(shell.state()).toBe('ready');
    expect(mount.children.length).toBeGreaterThan(0);
  });

  it('separates a notice from a failure, so a heading never claims the wrong thing', () => {
    const {host, mount} = createHost();
    const shell = createMultiviewPoseShell(cameraAppConfig, host);

    shell.showNotice('two cameras are connected');
    const headings = () =>
      collect(mount)
        .filter((element) => element.tagName === 'h1' && element.parentNode?.style['display'] !== 'none')
        .map((element) => element.textContent);

    // A notice must not appear under the heading that says the application stopped.
    shell.showError('the camera is not connected', {});
    expect(headings()).toContain(cameraAppConfig.errorLocales.ja.title);
  });

  it('removes every mounted overlay on dispose', () => {
    const {host, mount} = createHost();
    const shell = createMultiviewPoseShell(cameraAppConfig, host);
    shell.showLoading('Starting', null);
    shell.dispose();

    expect(mount.children).toHaveLength(0);
    expect(shell.state()).toBe('unmounted');
  });

  it('does not mount again after dispose', () => {
    const {host, mount} = createHost();
    const shell = createMultiviewPoseShell(cameraAppConfig, host);
    shell.dispose();
    shell.showLoading('Starting', null);
    expect(mount.children).toHaveLength(0);
  });

  it('hides overlays that were never mounted without creating DOM', () => {
    const {host, mount} = createHost();
    const shell = createMultiviewPoseShell(cameraAppConfig, host);
    shell.hideLoading();
    shell.hideMessage();
    expect(mount.children).toHaveLength(0);
  });
});

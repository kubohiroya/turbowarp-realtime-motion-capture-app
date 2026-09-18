import {
  createAppShellLoadingPresenter,
  createRuntimeMessageIndicator,
  resolveAppShellLocale,
} from '@kubohiroya/turbowarp-app-shell';

import type { AppShellAppConfig, ShellLocale } from './app-config.js';

export type ShellState = 'unmounted' | 'ready' | 'unavailable';

/** Everything the shell needs from the host page and the TurboWarp runtime. */
export interface ShellHost {
  readonly document: Document | null;
  /** The element the stage canvas lives in, or `null` while the renderer is absent. */
  resolveMount(): HTMLElement | null;
  resolveLocale?(): string;
}

export interface MultiviewPoseShell {
  readonly locale: ShellLocale;
  state(): ShellState;
  showLoading(label: string, progress: number | null): void;
  hideLoading(): void;
  showNotice(message: string): void;
  showError(message: string, details: Record<string, unknown>): void;
  hideMessage(): void;
  dispose(): void;
}

type LoadingPresenter = ReturnType<typeof createAppShellLoadingPresenter>;
type MessageIndicator = ReturnType<typeof createRuntimeMessageIndicator>;

interface MountedParts {
  readonly loading: LoadingPresenter;
  /**
   * Two indicators, because one heading cannot serve both.
   *
   * A notice that reports a camera count under a heading reading "the application stopped" tells the
   * operator something false, and an operator who learns to ignore that heading will ignore it when
   * it is true.
   */
  readonly notice: MessageIndicator;
  readonly error: MessageIndicator;
}

function normalizeLocale(value: string | undefined): ShellLocale {
  return value === 'ja' ? 'ja' : 'en';
}

/**
 * Creates the loading and runtime message overlays for one TurboWarp app.
 *
 * Mounting is deferred until the first block call: at extension registration the renderer usually
 * has no canvas yet, and an app that never touches the shell should not create DOM at all. Every
 * failure degrades to `unavailable` rather than throwing into an SB3 script, because a stage overlay
 * must never be the reason a performance stops.
 */
export function createMultiviewPoseShell(
  config: AppShellAppConfig,
  host: ShellHost,
): MultiviewPoseShell {
  const locale = normalizeLocale(
    host.resolveLocale?.() ??
      (host.document === null ? 'en' : resolveAppShellLocale()),
  );
  let parts: MountedParts | null = null;
  let state: ShellState = 'unmounted';
  let disposed = false;

  function mount(): MountedParts | null {
    if (disposed || state === 'unavailable') return null;
    if (parts !== null) return parts;
    const document = host.document;
    const target = host.resolveMount();
    if (document === null || target === null) return null;
    try {
      const loading = createAppShellLoadingPresenter({
        document,
        mount: target,
      });
      const notice = createRuntimeMessageIndicator({
        document,
        mount: target,
        initialLocale: locale,
        tone: 'info',
        locales: config.noticeLocales,
      });
      // A notice covers the whole stage like a dialog but asks nothing of the operator, and the
      // replay keeps one up while it plays; clicks go through it to the menu underneath.
      notice.element.style.pointerEvents = 'none';
      const error = createRuntimeMessageIndicator({
        document,
        mount: target,
        initialLocale: locale,
        tone: 'error',
        locales: config.errorLocales,
      });
      parts = { loading, notice, error };
      state = 'ready';
      return parts;
    } catch {
      state = 'unavailable';
      return null;
    }
  }

  return {
    locale,
    state: () => state,
    showLoading(label, progress) {
      mount()?.loading.show(
        progress === null ? { label } : { label, progress },
      );
    },
    hideLoading() {
      parts?.loading.hide();
    },
    showNotice(message) {
      const mounted = mount();
      mounted?.error.hide();
      mounted?.notice.show({ message });
    },
    showError(message, details) {
      const mounted = mount();
      mounted?.notice.hide();
      mounted?.error.show(
        Object.keys(details).length === 0 ? { message } : { message, details },
      );
    },
    hideMessage() {
      parts?.notice.hide();
      parts?.error.hide();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      parts?.loading.dispose();
      parts?.notice.dispose();
      parts?.error.dispose();
      parts = null;
      state = 'unmounted';
    },
  };
}

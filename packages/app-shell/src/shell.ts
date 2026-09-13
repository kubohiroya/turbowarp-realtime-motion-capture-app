import {
  createAppShellLoadingPresenter,
  createRuntimeMessageIndicator,
  resolveAppShellLocale
} from '@kubohiroya/turbowarp-app-shell';

import type {AppShellAppConfig, ShellLocale} from './app-config.js';

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
  showMessage(message: string, details: Record<string, unknown>): void;
  hideMessage(): void;
  dispose(): void;
}

type LoadingPresenter = ReturnType<typeof createAppShellLoadingPresenter>;
type MessageIndicator = ReturnType<typeof createRuntimeMessageIndicator>;

interface MountedParts {
  readonly loading: LoadingPresenter;
  readonly message: MessageIndicator;
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
  host: ShellHost
): MultiviewPoseShell {
  const locale = normalizeLocale(
    host.resolveLocale?.() ?? (host.document === null ? 'en' : resolveAppShellLocale())
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
      const loading = createAppShellLoadingPresenter({document, mount: target});
      const message = createRuntimeMessageIndicator({
        document,
        mount: target,
        initialLocale: locale,
        locales: config.messageLocales
      });
      parts = {loading, message};
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
      mount()?.loading.show(progress === null ? {label} : {label, progress});
    },
    hideLoading() {
      parts?.loading.hide();
    },
    showMessage(message, details) {
      mount()?.message.show(Object.keys(details).length === 0 ? {message} : {message, details});
    },
    hideMessage() {
      parts?.message.hide();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      parts?.loading.dispose();
      parts?.message.dispose();
      parts = null;
      state = 'unmounted';
    }
  };
}

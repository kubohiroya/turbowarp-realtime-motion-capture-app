import {
  chooseTextFileWithDialog,
  lensCalibrationRequestParameters,
  lensCalibrationRoute,
  type LensCalibrationHost,
} from './lens-calibration.js';
import type { ShellLocale } from './app-config.js';
import type { ShellHost } from './shell.js';

/**
 * Binds the shell to the live TurboWarp runtime.
 *
 * The mount is resolved on every call because the renderer canvas is attached after the extension
 * registers, and a packaged host can move the stage container between scenes.
 */
export function createScratchShellHost(): ShellHost {
  const ownerDocument = typeof document === 'undefined' ? null : document;
  return {
    document: ownerDocument,
    resolveMount() {
      const parent = Scratch.vm?.runtime?.renderer?.canvas?.parentElement;
      if (parent !== undefined && parent !== null) return parent;
      return ownerDocument?.body ?? null;
    },
  };
}

/**
 * Binds the lens calibration launcher to the page.
 *
 * The calibration app is looked for only on an http(s) origin, and the page's query string travels
 * with the URL because the venue host authenticates every route with the token it carries.
 */
export function createBrowserLensCalibrationHost(
  locale: ShellLocale,
): LensCalibrationHost {
  return {
    resolveUrl(request) {
      if (typeof location === 'undefined') return null;
      if (location.protocol !== 'http:' && location.protocol !== 'https:')
        return null;
      const url = new URL(
        `${lensCalibrationRoute}${location.search}`,
        location.href,
      );
      if (request !== undefined) {
        for (const [name, value] of lensCalibrationRequestParameters(request))
          url.searchParams.set(name, value);
      }
      return url.href;
    },
    async isServed(url) {
      const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      return response.ok;
    },
    openWindow(url, name) {
      if (typeof window === 'undefined') return null;
      return window.open(url, name);
    },
    chooseTextFile() {
      if (typeof document === 'undefined') return Promise.resolve(null);
      return chooseTextFileWithDialog({
        document,
        mount: document.body,
        locale,
      });
    },
  };
}

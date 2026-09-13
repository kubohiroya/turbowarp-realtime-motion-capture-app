import type {ShellHost} from './shell.js';

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
    }
  };
}

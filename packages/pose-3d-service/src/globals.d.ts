interface TurboWarpExtension {
  getInfo(): Record<string, unknown>;
}

interface TurboWarpRendererCanvas {
  parentElement?: HTMLElement | null;
}

interface TurboWarpRenderer {
  canvas?: TurboWarpRendererCanvas | null;
}

interface TurboWarpRuntime {
  renderer?: TurboWarpRenderer | null;
  startHats?(opcode: string, matchFields?: Record<string, unknown>): unknown;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  off?(event: string, listener: (...args: unknown[]) => void): void;
  [key: string]: unknown;
}

interface ScratchTranslate {
  (text: string): string;
  (
    message: {default: string; description?: string},
    placeholders?: Record<string, string | number>
  ): string;
}

interface ScratchApi {
  extensions: {
    unsandboxed: boolean;
    register(extension: TurboWarpExtension): void;
  };
  BlockType: Record<'COMMAND' | 'REPORTER' | 'BOOLEAN' | 'HAT', string>;
  ArgumentType: Record<'STRING' | 'NUMBER' | 'BOOLEAN', string>;
  Cast: {
    toString(value: unknown): string;
    toNumber(value: unknown): number;
    toBoolean(value: unknown): boolean;
  };
  vm?: {runtime?: TurboWarpRuntime};
  translate: ScratchTranslate;
}

declare const Scratch: ScratchApi;

declare module '*?worker&inline' {
  const WorkerConstructor: new () => Worker;
  export default WorkerConstructor;
}

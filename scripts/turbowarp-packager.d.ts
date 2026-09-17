/**
 * The parts of `@turbowarp/packager` this repository uses.
 *
 * The package ships no types and its Node API is documented as unstable between minor releases, so
 * this declares only what the player build touches. A wider surface would give false confidence
 * that more of the API is pinned than actually is.
 */
declare module '@turbowarp/packager' {
  interface PackagerAnalysis {
    readonly extensions: readonly string[];
    readonly usesMusic: boolean;
    readonly usesSteamworks: boolean;
  }

  interface LoadedProject {
    readonly title: string;
    readonly type: string;
    readonly analysis: PackagerAnalysis;
  }

  interface PackagerOptions {
    target: string;
    autoplay: boolean;
    /** Embedded extensions to keep. Anything absent here is removed without a warning. */
    extensions: string[];
    custom: { js: string; css: string };
    [key: string]: unknown;
  }

  interface PackagerResult {
    readonly filename: string;
    readonly type: string;
    readonly data: Uint8Array;
  }

  class Packager {
    project: LoadedProject;
    options: PackagerOptions;
    package(): Promise<PackagerResult>;
  }

  function loadProject(
    data: Uint8Array,
    progress?: (type: string, a: number, b: number) => void,
  ): Promise<LoadedProject>;

  const packagerDefault: {
    Packager: typeof Packager;
    loadProject: typeof loadProject;
  };

  export default packagerDefault;
  export { Packager, loadProject };
  export type {
    LoadedProject,
    PackagerAnalysis,
    PackagerOptions,
    PackagerResult,
  };
}

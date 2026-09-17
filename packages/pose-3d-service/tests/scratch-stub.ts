/** Installs the minimal `Scratch` surface the extension class touches. */
export function installScratchStub(): void {
  (globalThis as Record<string, unknown>)['Scratch'] = {
    extensions: {unsandboxed: true, register() {}},
    BlockType: {COMMAND: 'command', REPORTER: 'reporter', BOOLEAN: 'Boolean', HAT: 'hat'},
    ArgumentType: {STRING: 'string', NUMBER: 'number', BOOLEAN: 'Boolean'},
    Cast: {
      toString: (value: unknown) => (value === undefined || value === null ? '' : String(value)),
      toNumber: (value: unknown) => {
        const parsed = Number(value);
        return Number.isNaN(parsed) ? 0 : parsed;
      },
      toBoolean: (value: unknown) => value === true || value === 'true'
    },
    translate: (value: unknown) => (typeof value === 'string' ? value : ''),
    vm: {runtime: {}}
  };
}

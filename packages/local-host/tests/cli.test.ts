import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  describeFailure,
  resolveLocale,
  resolveLockDirectory,
  runLocalHostCli,
  type CliOutcome,
} from '../src/cli.ts';

let running: CliOutcome[] = [];
let sockets: Server[] = [];

function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function occupy(port: number): Promise<Server> {
  const server = createServer();
  sockets.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function run(
  overrides: Partial<Parameters<typeof runLocalHostCli>[0]> = {},
) {
  const lines: string[] = [];
  const errors: string[] = [];
  const opened: string[] = [];
  const port = overrides.port ?? (await freePort());
  const outcome = await runLocalHostCli({
    app: 'camera-app',
    title: 'Multiview Pose Camera App',
    port,
    player: '<!doctype html><title>player</title>',
    argv: [],
    env: { XDG_RUNTIME_DIR: tmpdir(), LANG: 'en_US.UTF-8' },
    write: (line) => lines.push(line),
    writeError: (line) => errors.push(line),
    openBrowser: async (url) => {
      opened.push(url);
    },
    onSignal: () => {},
    ...overrides,
  });
  running.push(outcome);
  return { outcome, lines, errors, opened, port };
}

afterEach(async () => {
  await Promise.all(
    running.map((outcome) => outcome.host?.stop() ?? Promise.resolve()),
  );
  running = [];
  await Promise.all(
    sockets.map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  sockets = [];
});

describe('resolveLockDirectory', () => {
  it('uses the per-user runtime directory when the system provides one', () => {
    expect(resolveLockDirectory({ XDG_RUNTIME_DIR: '/run/user/1000' })).toBe(
      '/run/user/1000/multiview-pose',
    );
  });

  it('falls back to the temp directory', () => {
    expect(resolveLockDirectory({})).toBe(join(tmpdir(), 'multiview-pose'));
    expect(resolveLockDirectory({ XDG_RUNTIME_DIR: '' })).toBe(
      join(tmpdir(), 'multiview-pose'),
    );
  });
});

describe('resolveLocale', () => {
  it('reads the interface language from the environment', () => {
    expect(resolveLocale({ LANG: 'ja_JP.UTF-8' })).toBe('ja');
    expect(resolveLocale({ LC_ALL: 'ja_JP.UTF-8', LANG: 'en_US.UTF-8' })).toBe(
      'ja',
    );
    expect(resolveLocale({ LANG: 'en_US.UTF-8' })).toBe('en');
    expect(resolveLocale({})).toBe('en');
  });

  it('does not mistake another language that starts with j', () => {
    expect(resolveLocale({ LANG: 'jam_JM' })).toBe('en');
  });
});

describe('running', () => {
  it('serves and opens the browser at the authenticated player URL', async () => {
    const { outcome, lines, opened, port } = await run();

    expect(outcome.code).toBe(0);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain(`127.0.0.1:${port}/app?token=`);
    expect(lines.join('\n')).toContain(`127.0.0.1:${port}`);
  });

  it('tells the operator that saved settings belong to this address', async () => {
    const { lines } = await run();
    expect(lines.join('\n')).toMatch(/belong to this address/);
  });

  it('reports in Japanese when the environment asks for it', async () => {
    const { lines } = await run({
      env: { XDG_RUNTIME_DIR: tmpdir(), LANG: 'ja_JP.UTF-8' },
    });
    expect(lines.join('\n')).toContain('起動しました');
  });

  it('keeps serving after a browser failure rather than exiting', async () => {
    const { outcome, errors } = await run({
      openBrowser: async () => {
        throw new Error('no browser');
      },
    });

    expect(outcome.code).toBe(0);
    expect(outcome.host).toBeDefined();
    expect(errors.join('\n')).toMatch(/Open this address by hand/);
  });
});

describe('--preflight', () => {
  it('runs the same startup and then stops without opening a browser', async () => {
    const { outcome, lines, opened, port } = await run({
      argv: ['--preflight'],
    });

    expect(outcome.code).toBe(0);
    expect(outcome.host).toBeUndefined();
    expect(opened).toEqual([]);
    expect(lines.join('\n')).toContain('Preflight passed');

    // The port is free again, so preflight did not leave the host running.
    const after = await run({ port });
    expect(after.outcome.code).toBe(0);
  });

  it('fails when the port is not available', async () => {
    const port = await freePort();
    await occupy(port);

    const { outcome, errors } = await run({ argv: ['--preflight'], port });

    expect(outcome.code).toBe(1);
    expect(errors.join('\n')).toMatch(/held by another program/);
  });
});

describe('failures', () => {
  it('names the application that is already running', async () => {
    const first = await run();
    const second = await run({ port: first.port });

    expect(second.outcome.code).toBe(1);
    expect(second.errors.join('\n')).toMatch(/already running/);
    expect(second.errors.join('\n')).toMatch(/Return to the window/);
  });

  it('does not blame an application for a port an unrelated program holds', async () => {
    const port = await freePort();
    await occupy(port);

    const { outcome, errors } = await run({ port });

    expect(outcome.code).toBe(1);
    expect(errors.join('\n')).toMatch(/another program/);
    expect(errors.join('\n')).not.toMatch(/camera-app|fusion-app/);
  });
});

describe('describeFailure', () => {
  const holder = {
    app: 'fusion-app',
    port: 49712,
    origin: 'http://127.0.0.1:49712',
    pid: 4242,
    startedAt: '2026-01-01T09:00:00.000Z',
  };

  it('tells the operator to fix the build when two applications share a port', () => {
    const text = describeFailure(
      { reason: 'port-held-by-application', holder },
      'en',
    );
    expect(text).toContain('fusion-app');
    expect(text).toContain('4242');
    expect(text).toMatch(/same port/);
  });

  it('explains why it will not move to another port', () => {
    const text = describeFailure(
      { reason: 'port-unavailable', port: 49711 },
      'en',
    );
    expect(text).toMatch(/will not move to a different port/);
    expect(text).toMatch(/calibration/);
  });

  it('translates every failure', () => {
    const failures = [
      { reason: 'already-running', holder },
      { reason: 'port-held-by-application', holder },
      { reason: 'port-unavailable', port: 49711 },
      { reason: 'player-missing', path: '/tmp/absent.html' },
    ] as const;

    for (const failure of failures) {
      const japanese = describeFailure(failure, 'ja');
      expect(japanese.length).toBeGreaterThan(0);
      expect(japanese).not.toBe(describeFailure(failure, 'en'));
    }
  });
});

describe('--no-open', () => {
  it('serves without opening a browser and prints the address to use', async () => {
    const { outcome, lines, opened, port } = await run({ argv: ['--no-open'] });

    expect(outcome.code).toBe(0);
    expect(outcome.host).toBeDefined();
    expect(opened).toEqual([]);
    expect(
      lines.some((line) => line.includes(`127.0.0.1:${port}/app?token=`)),
    ).toBe(true);
  });
});

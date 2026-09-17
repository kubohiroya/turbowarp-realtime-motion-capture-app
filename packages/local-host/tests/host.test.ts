import {createServer, type Server} from 'node:net';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  lensCalibrationPath,
  playerPath,
  startLocalHost,
  type StartedLocalHost
} from '../src/host.ts';

const playerHtml = '<!doctype html><title>player</title><body>packaged player';

let directory: string;
let lockDirectory: string;
let running: StartedLocalHost[] = [];
let sockets: Server[] = [];

async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      const {port} = address;
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

async function start(overrides: Partial<Parameters<typeof startLocalHost>[0]> = {}) {
  const port = overrides.port ?? (await freePort());
  const result = await startLocalHost({
    app: 'camera-app',
    title: 'Camera App',
    port,
    lockDirectory,
    player: {html: playerHtml},
    ...overrides
  });
  if (result.started) running.push(result.host);
  return result;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'multiview-pose-host-'));
  lockDirectory = join(directory, 'run');
});

afterEach(async () => {
  await Promise.all(running.map((host) => host.stop()));
  running = [];
  await Promise.all(
    sockets.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  sockets = [];
});

describe('startLocalHost', () => {
  it('serves the packaged player on the fixed port', async () => {
    const result = await start();
    expect(result.started).toBe(true);
    if (!result.started) return;

    expect(result.host.url).toBe(`${result.host.origin}${playerPath}?token=${new URL(result.host.url).searchParams.get('token') ?? ''}`);
    const response = await fetch(result.host.url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    await expect(response.text()).resolves.toBe(playerHtml);
  });

  it('keeps the requested port, because the port is the origin', async () => {
    const port = await freePort();
    const result = await start({port});

    expect(result.started && result.host.port).toBe(port);
    expect(result.started && new URL(result.host.origin).port).toBe(String(port));
  });

  it('refuses a request without the token', async () => {
    const result = await start();
    if (!result.started) throw new Error('did not start');

    const response = await fetch(`${result.host.origin}${playerPath}`);
    expect(response.status).toBe(401);
  });

  it('sends the host root to the player', async () => {
    const result = await start();
    if (!result.started) throw new Error('did not start');

    const token = new URL(result.host.url).searchParams.get('token') ?? '';
    const root = await (await fetch(`${result.host.origin}/?token=${token}`)).text();
    expect(root).toContain(playerPath);
    expect(root).toContain('location.replace');
  });

  it('reads the player from disk when given a path', async () => {
    const path = join(directory, 'player.html');
    await writeFile(path, playerHtml);
    const result = await start({player: {path}});
    if (!result.started) throw new Error('did not start');

    await expect((await fetch(result.host.url)).text()).resolves.toBe(playerHtml);
  });

  it('reports a missing player before taking the lock', async () => {
    const result = await start({player: {path: join(directory, 'absent.html')}});

    expect(result).toMatchObject({started: false, reason: 'player-missing'});
    await expect(
      import('node:fs/promises').then(({readdir}) => readdir(lockDirectory).catch(() => []))
    ).resolves.toEqual([]);
  });

  it('serves the lens calibration app on the same origin when the build carries one', async () => {
    const calibrationHtml = '<!doctype html><title>lens calibration</title>';
    const result = await start({lensCalibrationPlayer: {html: calibrationHtml}});
    if (!result.started) throw new Error('did not start');

    const token = new URL(result.host.url).searchParams.get('token') ?? '';
    const response = await fetch(`${result.host.origin}${lensCalibrationPath}?token=${token}`);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(calibrationHtml);
    const head = await fetch(`${result.host.origin}${lensCalibrationPath}?token=${token}`, {
      method: 'HEAD'
    });
    expect(head.status).toBe(200);
  });

  it('has no lens calibration route when the build carries none', async () => {
    const result = await start();
    if (!result.started) throw new Error('did not start');

    const token = new URL(result.host.url).searchParams.get('token') ?? '';
    const response = await fetch(`${result.host.origin}${lensCalibrationPath}?token=${token}`, {
      method: 'HEAD'
    });
    expect(response.ok).toBe(false);
  });

  it('refuses to start when a lens calibration app was asked for and cannot be read', async () => {
    const path = join(directory, 'absent-calibration.html');
    const result = await start({lensCalibrationPlayer: {path}});

    expect(result).toEqual({started: false, reason: 'player-missing', path});
  });

  it('records the run lock while it serves', async () => {
    const result = await start();
    if (!result.started) throw new Error('did not start');

    expect(result.host.lock).toMatchObject({app: 'camera-app', port: result.host.port});
  });
});

describe('failures the operator has to act on', () => {
  it('names the application already running', async () => {
    const first = await start();
    if (!first.started) throw new Error('did not start');

    const second = await start({port: first.host.port});

    expect(second).toMatchObject({started: false, reason: 'already-running'});
    expect(second.started === false && second.reason === 'already-running' && second.holder.app).toBe(
      'camera-app'
    );
  });

  it('names the other application holding the port', async () => {
    const fusion = await start({app: 'fusion-app', title: 'Fusion App'});
    if (!fusion.started) throw new Error('did not start');

    const camera = await start({port: fusion.host.port});

    expect(camera).toMatchObject({started: false, reason: 'port-held-by-application'});
    expect(
      camera.started === false && camera.reason === 'port-held-by-application' && camera.holder.app
    ).toBe('fusion-app');
  });

  it('does not blame an application when an unrelated program holds the port', async () => {
    const port = await freePort();
    await occupy(port);

    const result = await start({port});

    expect(result).toEqual({started: false, reason: 'port-unavailable', port});
  });

  it('releases the lock when the port cannot be taken, so a retry is not blocked', async () => {
    const port = await freePort();
    const server = await occupy(port);
    expect(await start({port})).toMatchObject({started: false, reason: 'port-unavailable'});

    await new Promise<void>((resolve) => server.close(() => resolve()));
    sockets = [];

    expect(await start({port})).toMatchObject({started: true});
  });
});

describe('performance DSL', () => {
  async function startWithDsl(contents: string) {
    const path = join(directory, 'show.yaml');
    await writeFile(path, contents);
    const result = await start({dsl: {projectRoot: directory, path}});
    if (!result.started) throw new Error('did not start');
    return {host: result.host, path};
  }

  it('publishes the DSL that is already on disk at startup', async () => {
    const {host} = await startWithDsl('performers: 1');

    expect(host.dsl()).toMatchObject({name: 'show.yaml', source: 'performers: 1'});
  });

  it('opens the event stream immediately, before anything changes', async () => {
    const {host} = await startWithDsl('performers: 1');
    const token = new URL(host.url).searchParams.get('token') ?? '';

    const stream = await Promise.race([
      fetch(`${host.origin}/events?token=${token}`),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000))
    ]);

    expect(stream).not.toBeNull();
    if (stream === null) return;
    const reader = stream.body?.getReader();
    const decoder = new TextDecoder();
    let received = '';
    const deadline = Date.now() + 4000;
    while (reader !== undefined && !received.includes('performers') && Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        new Promise<{done: true; value?: undefined}>((resolve) =>
          setTimeout(() => resolve({done: true}), 1000)
        )
      ]);
      if (next.done) break;
      received += decoder.decode(next.value ?? new Uint8Array());
    }
    await reader?.cancel().catch(() => undefined);

    expect(received).toContain('dsl');
    expect(received).toContain('performers');
  });

  it('tells a connecting page that no DSL has been loaded yet', async () => {
    const result = await start();
    if (!result.started) throw new Error('did not start');
    const token = new URL(result.host.url).searchParams.get('token') ?? '';

    const stream = await fetch(`${result.host.origin}/events?token=${token}`);
    const reader = stream.body?.getReader();
    const decoder = new TextDecoder();
    let received = '';
    const deadline = Date.now() + 4000;
    while (reader !== undefined && !received.includes('none') && Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        new Promise<{done: true; value?: undefined}>((resolve) =>
          setTimeout(() => resolve({done: true}), 1000)
        )
      ]);
      if (next.done) break;
      received += decoder.decode(next.value ?? new Uint8Array());
    }
    await reader?.cancel().catch(() => undefined);

    expect(received).toContain('"state":"none"');
  });

  it('republishes when the file changes on disk', async () => {
    const {host, path} = await startWithDsl('performers: 1');

    const republished = () => host.dsl()?.source === 'performers: 2';

    // The host has only just opened its fs.watch, and the OS can drop a write
    // made while it is still registering the watch (FSEvents on macOS). Such a
    // write is never reported, so rewrite the change until the watcher publishes
    // it. publishNow is never called here: only the watcher can republish.
    const deadline = Date.now() + 4000;
    while (!republished() && Date.now() < deadline) {
      await writeFile(path, 'performers: 2');
      const attemptDeadline = Math.min(Date.now() + 500, deadline);
      while (!republished() && Date.now() < attemptDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    expect(host.dsl()).toMatchObject({source: 'performers: 2'});
  });
});

describe('stop', () => {
  it('frees the port and the lock', async () => {
    const result = await start();
    if (!result.started) throw new Error('did not start');
    const {port} = result.host;

    await result.host.stop();
    running = [];

    const restarted = await start({port});
    expect(restarted.started).toBe(true);
  });

  it('stops serving the player', async () => {
    const result = await start();
    if (!result.started) throw new Error('did not start');
    const {url} = result.host;

    await result.host.stop();
    running = [];

    await expect(fetch(url)).rejects.toThrow();
  });
});

import { createServer, type Server } from 'node:net';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startLocalHost, type StartedLocalHost } from '../src/host.ts';
import { isRecordingName, recordingsPath } from '../src/recordings.ts';

const playerHtml = '<!doctype html><title>player</title>';

let directory: string;
let recordingsDirectory: string;
let running: StartedLocalHost[] = [];

async function freePort(): Promise<number> {
  const server: Server = createServer();
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

async function start(
  overrides: Partial<Parameters<typeof startLocalHost>[0]> & {
    withoutStore?: boolean;
  } = {},
) {
  const { withoutStore, ...rest } = overrides;
  const result = await startLocalHost({
    app: 'local-app',
    title: 'Local App',
    port: await freePort(),
    lockDirectory: join(directory, 'run'),
    player: { html: playerHtml },
    ...(withoutStore === true ? {} : { recordingsDirectory }),
    ...rest,
  });
  if (!result.started) throw new Error(`host did not start: ${result.reason}`);
  running.push(result.host);
  return result.host;
}

/** The token travels in the query, as it does for every other route. */
function route(host: StartedLocalHost, query = ''): string {
  const token = new URL(host.url).searchParams.get('token') ?? '';
  return `${host.origin}${recordingsPath}?token=${token}${query}`;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'multiview-pose-recordings-'));
  recordingsDirectory = join(directory, 'recordings');
});

afterEach(async () => {
  await Promise.all(running.map((host) => host.stop()));
  running = [];
});

describe('recording names', () => {
  it('accepts a plain name and refuses anything that could leave the directory', () => {
    expect(isRecordingName('walk-1.json')).toBe(true);
    expect(isRecordingName('walk_1.2026-09-18.json')).toBe(true);
    for (const name of [
      '../escape.json',
      'sub/walk.json',
      '.hidden.json',
      'walk.txt',
      'walk.json/',
      `${'a'.repeat(80)}.json`,
    ]) {
      expect(isRecordingName(name), name).toBe(false);
    }
  });
});

describe('the recordings route', () => {
  it('writes, lists, reads back and removes a recording', async () => {
    const host = await start();
    const session = JSON.stringify({
      schema: 'twrmc/pose-3d-session',
      version: 1,
      events: [],
    });

    const written = await fetch(route(host, '&name=walk-1.json'), {
      method: 'PUT',
      body: session,
    });
    expect(written.status).toBe(200);
    expect(
      await readFile(join(recordingsDirectory, 'walk-1.json'), 'utf8'),
    ).toBe(session);

    const listed = await fetch(route(host));
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      recordings: Array<{ name: string; bytes: number; modifiedAt: string }>;
    };
    expect(body.recordings.map((entry) => entry.name)).toEqual(['walk-1.json']);
    expect(body.recordings[0]?.bytes).toBe(session.length);
    expect(Number.isNaN(Date.parse(body.recordings[0]?.modifiedAt ?? ''))).toBe(
      false,
    );

    const read = await fetch(route(host, '&name=walk-1.json'));
    expect(await read.text()).toBe(session);

    expect(
      (await fetch(route(host, '&name=walk-1.json'), { method: 'DELETE' }))
        .status,
    ).toBe(200);
    expect(
      ((await (await fetch(route(host))).json()) as { recordings: unknown[] })
        .recordings,
    ).toEqual([]);
  });

  it('shares one directory between applications, whatever port each serves on', async () => {
    const camera = await start({
      app: 'camera-app',
      title: 'Camera App',
      port: await freePort(),
    });
    const fusion = await start({
      app: 'fusion-app',
      title: 'Fusion App',
      port: await freePort(),
    });
    const session = JSON.stringify({
      schema: 'twrmc/pose-3d-session',
      version: 1,
      events: [1],
    });

    await fetch(route(camera, '&name=from-camera.json'), {
      method: 'PUT',
      body: session,
    });

    const read = await fetch(route(fusion, '&name=from-camera.json'));
    expect(await read.text()).toBe(session);
  });

  it('refuses a name that is not a recording, a body that is not JSON, and an unknown method', async () => {
    const host = await start();
    expect((await fetch(route(host, '&name=../escape.json'))).status).toBe(400);
    expect(
      (
        await fetch(route(host, '&name=walk.json'), {
          method: 'PUT',
          body: 'not json',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(route(host, '&name=walk.json'), {
          method: 'PATCH',
          body: '{}',
        })
      ).status,
    ).toBe(405);
    expect((await fetch(route(host, '&name=missing.json'))).status).toBe(404);
  });

  it('lists nothing before anything has been recorded, and skips files that are not recordings', async () => {
    const host = await start();
    expect(
      ((await (await fetch(route(host))).json()) as { recordings: unknown[] })
        .recordings,
    ).toEqual([]);

    await fetch(route(host, '&name=walk.json'), { method: 'PUT', body: '{}' });
    await writeFile(join(recordingsDirectory, 'notes.txt'), 'not a recording');
    const body = (await (await fetch(route(host))).json()) as {
      recordings: Array<{ name: string }>;
    };
    expect(body.recordings.map((entry) => entry.name)).toEqual(['walk.json']);
  });

  it('has no route at all when the host was given no directory', async () => {
    const host = await start({ withoutStore: true });
    expect((await fetch(route(host))).status).toBe(404);
  });

  it('still refuses a request without the token', async () => {
    const host = await start();
    expect((await fetch(`${host.origin}${recordingsPath}`)).status).toBe(401);
  });
});

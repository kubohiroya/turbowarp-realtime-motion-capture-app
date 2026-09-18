import { createServer, type Server } from 'node:net';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
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

const header = JSON.stringify({
  type: 'header',
  schema: 'twrmc/pose-3d-session',
  version: 2,
  producer: 'test',
  configuration: {
    implementation: 'fusion-v0',
    referenceId: 'venue',
    cameras: [],
  },
});

const frameLine = (atUs: number) =>
  JSON.stringify({ type: 'frame2d', atUs, cameraId: 'camera-1', frame: {} });

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
    expect(isRecordingName('walk-1.jsonl')).toBe(true);
    expect(isRecordingName('walk-1.jsonl.gz')).toBe(true);
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

describe('a recording written while it is taken', () => {
  it('opens with its header, grows a line at a time, and is compressed under its final name', async () => {
    const host = await start();
    const working = '&name=taking.jsonl';

    expect(
      (
        await fetch(route(host, `${working}&mode=start`), {
          method: 'POST',
          body: `${header}\n`,
        })
      ).status,
    ).toBe(200);
    for (let index = 0; index < 3; index += 1) {
      const response = await fetch(route(host, `${working}&mode=append`), {
        method: 'POST',
        body: `${frameLine(index)}\n`,
      });
      expect(response.status).toBe(200);
    }

    // The part that was taken is on disk before it is finished: an interrupted take is not lost.
    const partial = await readFile(
      join(recordingsDirectory, 'taking.jsonl'),
      'utf8',
    );
    expect(partial.split('\n').filter((line) => line !== '')).toHaveLength(4);

    const finished = await fetch(
      route(host, `${working}&mode=finish&to=walk-1.jsonl.gz`),
      { method: 'POST' },
    );
    expect(finished.status).toBe(200);
    expect(
      await stat(join(recordingsDirectory, 'taking.jsonl')).catch(() => null),
    ).toBeNull();
    expect(
      gunzipSync(
        await readFile(join(recordingsDirectory, 'walk-1.jsonl.gz')),
      ).toString('utf8'),
    ).toBe(partial);

    // The reader is handed the lines: what is on disk being compressed is the transport's business.
    const read = await fetch(route(host, '&name=walk-1.jsonl.gz'));
    expect(read.status).toBe(200);
    expect(await read.text()).toBe(partial);

    const listed = (await (await fetch(route(host))).json()) as {
      recordings: Array<{ name: string }>;
    };
    expect(listed.recordings.map((entry) => entry.name)).toEqual([
      'walk-1.jsonl.gz',
    ]);
  });

  it('refuses lines that are not session lines, a compressed target it cannot append to, and a bad finish', async () => {
    const host = await start();
    expect(
      (
        await fetch(route(host, '&name=taking.jsonl&mode=start'), {
          method: 'POST',
          body: 'not json\n',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(route(host, '&name=taking.jsonl&mode=start'), {
          method: 'POST',
          body: `${JSON.stringify({ atUs: 1 })}\n`,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(route(host, '&name=taking.jsonl.gz&mode=append'), {
          method: 'POST',
          body: `${frameLine(1)}\n`,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(route(host, '&name=taking.jsonl&mode=sideways'), {
          method: 'POST',
          body: '',
        })
      ).status,
    ).toBe(400);

    await fetch(route(host, '&name=taking.jsonl&mode=start'), {
      method: 'POST',
      body: `${header}\n`,
    });
    expect(
      (
        await fetch(
          route(host, '&name=taking.jsonl&mode=finish&to=walk.json'),
          {
            method: 'POST',
          },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(
          route(host, '&name=missing.jsonl&mode=finish&to=walk.jsonl.gz'),
          { method: 'POST' },
        )
      ).status,
    ).toBe(404);
  });

  it('stops a take that would run past the size limit, keeping what it already holds', async () => {
    const host = await start();
    await fetch(route(host, '&name=taking.jsonl&mode=start'), {
      method: 'POST',
      body: `${header}\n`,
    });
    const huge = JSON.stringify({
      type: 'frame2d',
      atUs: 1,
      cameraId: 'camera-1',
      frame: { padding: 'x'.repeat(70 * 1024 * 1024) },
    });
    const refused = await fetch(route(host, '&name=taking.jsonl&mode=append'), {
      method: 'POST',
      body: `${huge}\n`,
    });
    expect(refused.status).toBe(413);
    expect(
      await readFile(join(recordingsDirectory, 'taking.jsonl'), 'utf8'),
    ).toBe(`${header}\n`);
  });

  it('writes a whole uncompressed recording at once, and refuses one written to a compressed name', async () => {
    const host = await start();
    const text = `${header}\n${frameLine(1)}\n`;
    expect(
      (
        await fetch(route(host, '&name=whole.jsonl'), {
          method: 'PUT',
          body: text,
        })
      ).status,
    ).toBe(200);
    expect(await (await fetch(route(host, '&name=whole.jsonl'))).text()).toBe(
      text,
    );
    expect(
      (
        await fetch(route(host, '&name=whole.jsonl.gz'), {
          method: 'PUT',
          body: text,
        })
      ).status,
    ).toBe(400);
  });
});

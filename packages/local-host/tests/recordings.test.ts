import { createServer, type Server } from 'node:net';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startLocalHost, type StartedLocalHost } from '../src/host.ts';
import {
  createRecordingsRoute,
  isRecordingName,
  MAXIMUM_RECORDING_BYTES,
  recordingsPath,
} from '../src/recordings.ts';

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
  const post = (host: StartedLocalHost, query: string, body = '') =>
    fetch(route(host, query), { method: 'POST', body });

  it('is compressed as it runs, readable while it runs, and finished by a rename', async () => {
    const host = await start();
    const taking = '&name=taking.jsonl.gz';

    expect(
      (await post(host, `${taking}&mode=start`, `${header}\n`)).status,
    ).toBe(200);
    for (let index = 0; index < 3; index += 1) {
      expect(
        (await post(host, `${taking}&mode=append`, `${frameLine(index)}\n`))
          .status,
      ).toBe(200);
    }

    // On disk it is already gzip, not lines waiting to be compressed.
    const onDisk = await readFile(join(recordingsDirectory, 'taking.jsonl.gz'));
    expect([onDisk[0], onDisk[1]]).toEqual([0x1f, 0x8b]);

    // And it reads back while the take is still running: every batch was flushed into the file.
    const expected = [header, frameLine(0), frameLine(1), frameLine(2)]
      .map((line) => `${line}\n`)
      .join('');
    const running = await fetch(route(host, taking));
    expect(running.status).toBe(200);
    expect(await running.text()).toBe(expected);

    const finished = await post(
      host,
      `${taking}&mode=finish&to=walk-1.jsonl.gz`,
    );
    expect(finished.status).toBe(200);
    expect(
      await stat(join(recordingsDirectory, 'taking.jsonl.gz')).catch(
        () => null,
      ),
    ).toBeNull();
    // A finished take ends with the trailer, so any gzip reader takes it as it is.
    expect(
      gunzipSync(
        await readFile(join(recordingsDirectory, 'walk-1.jsonl.gz')),
      ).toString('utf8'),
    ).toBe(expected);
    expect(
      await (await fetch(route(host, '&name=walk-1.jsonl.gz'))).text(),
    ).toBe(expected);

    const listed = (await (await fetch(route(host))).json()) as {
      recordings: Array<{ name: string }>;
    };
    expect(listed.recordings.map((entry) => entry.name)).toEqual([
      'walk-1.jsonl.gz',
    ]);
  });

  it('reads a take that was cut short as far as it got', async () => {
    const host = await start();
    await post(host, '&name=taking.jsonl.gz&mode=start', `${header}\n`);
    await post(
      host,
      '&name=taking.jsonl.gz&mode=append',
      `${frameLine(1)}\n${frameLine(2)}\n`,
    );
    // What a crash leaves: the flushed stream with no trailer, and perhaps a few bytes of the next.
    const bytes = await readFile(join(recordingsDirectory, 'taking.jsonl.gz'));
    expect(() => gunzipSync(bytes)).toThrow();
    await writeFile(join(recordingsDirectory, 'cut.jsonl.gz'), bytes);

    const read = await fetch(route(host, '&name=cut.jsonl.gz'));
    expect(read.status).toBe(200);
    expect(await read.text()).toBe(
      `${header}\n${frameLine(1)}\n${frameLine(2)}\n`,
    );
  });

  it('closes the takes it is writing when the host stops, so nothing is left in the compressor', async () => {
    const host = await start();
    await post(host, '&name=taking.jsonl.gz&mode=start', `${header}\n`);
    await post(host, '&name=taking.jsonl.gz&mode=append', `${frameLine(1)}\n`);
    await host.stop();
    running = running.filter((candidate) => candidate !== host);
    expect(
      gunzipSync(
        await readFile(join(recordingsDirectory, 'taking.jsonl.gz')),
      ).toString('utf8'),
    ).toBe(`${header}\n${frameLine(1)}\n`);
  });

  it('refuses lines that are not session lines, a take that is not compressed, and a bad finish', async () => {
    const host = await start();
    expect(
      (await post(host, '&name=taking.jsonl.gz&mode=start', 'not json\n'))
        .status,
    ).toBe(400);
    expect(
      (
        await post(
          host,
          '&name=taking.jsonl.gz&mode=start',
          `${JSON.stringify({ atUs: 1 })}\n`,
        )
      ).status,
    ).toBe(400);
    expect(
      (await post(host, '&name=taking.jsonl&mode=start', `${header}\n`)).status,
    ).toBe(400);
    expect(
      (await post(host, '&name=taking.jsonl.gz&mode=sideways', '')).status,
    ).toBe(400);
    expect(
      (
        await post(
          host,
          '&name=never-started.jsonl.gz&mode=append',
          `${frameLine(1)}\n`,
        )
      ).status,
    ).toBe(404);

    await post(host, '&name=taking.jsonl.gz&mode=start', `${header}\n`);
    expect(
      (await post(host, '&name=taking.jsonl.gz&mode=finish&to=walk.json'))
        .status,
    ).toBe(400);
    expect(
      (await post(host, '&name=missing.jsonl.gz&mode=finish&to=walk.jsonl.gz'))
        .status,
    ).toBe(404);
  });

  it('stops a take once the disk holds the limit, keeping what it already holds', async () => {
    // The route rather than the host, so the limit can be small. It counts the compressed bytes the
    // take has written, because that is what the disk holds.
    const recordings = createRecordingsRoute({
      directory: recordingsDirectory,
      maximumBytes: 400,
    });
    const send = (query: string, body: string) =>
      recordings(
        new Request(`http://host/recordings?name=taking.jsonl.gz&${query}`, {
          method: 'POST',
          body,
        }),
      );
    expect((await send('mode=start', `${header}\n`)).status).toBe(200);
    let refused: Response | undefined;
    for (let index = 0; index < 200 && refused === undefined; index += 1) {
      const response = await send('mode=append', `${frameLine(index)}\n`);
      if (response.status === 413) refused = response;
      else expect(response.status).toBe(200);
    }
    expect(refused).toBeDefined();
    expect(await refused?.json()).toMatchObject({
      error: 'too-large',
      maximumBytes: 400,
    });
    // The limit ends the take; it does not undo it.
    const read = await recordings(
      new Request('http://host/recordings?name=taking.jsonl.gz'),
    );
    expect((await read.text()).startsWith(`${header}\n${frameLine(0)}\n`)).toBe(
      true,
    );
    await recordings.close();
  });

  it('counts the limit as the disk holds it, at 512 MB', () => {
    expect(MAXIMUM_RECORDING_BYTES).toBe(512 * 1024 * 1024);
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

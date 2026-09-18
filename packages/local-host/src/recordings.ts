/**
 * Pose recordings on the venue PC's disk, served to the applications that read and write them.
 *
 * Recordings are files rather than browser storage, for two reasons. Browser storage is scoped to an
 * origin, and each application has its own port, so a recording made in the camera app would be
 * invisible to the fusion app that wants to replay it. And a recording is evidence: it should
 * survive the browser being cleared, and be copyable, mailable and diffable like any other file.
 *
 * Every application's host reads the same directory, so one recording serves all three. The route
 * accepts names rather than paths, and nothing in a name can leave the directory.
 *
 * A recording is written while it is being taken, one line at a time (`twrmc/pose-3d-session` v2 is
 * JSONL), into a compression stream that stays open for the length of the take. That is what makes a
 * long take possible: the page holds a few lines rather than the whole session, the disk holds the
 * compressed size rather than the raw one, and an interrupted recording leaves the part that was
 * taken rather than nothing at all. Each batch of lines is flushed into the stream, so what has been
 * taken is on disk and can be read back a moment later — including while the take is still running.
 *
 * Finishing a take closes the stream and renames the file, which is why it costs nothing: there is no
 * pass over the recording to compress it, because it was compressed as it was taken.
 */

import { createWriteStream, type WriteStream } from 'node:fs';
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { join } from 'node:path';
import { constants, createGzip, gunzipSync, type Gzip } from 'node:zlib';

/** Path the recordings are served from, next to the application on the same origin. */
export const recordingsPath = '/recordings';

/**
 * How large one recording may grow on disk.
 *
 * Counted as the compressed bytes the take has written, because that is what the venue's disk holds
 * and what an operator would have to clear. A take that runs away is stopped while it is being
 * written rather than when it is saved. It refuses a mistake, not a session: measured at 3.5 kB a
 * frame and about three and a half times compression (`pnpm run measure:recording`), this is a few
 * hours of four cameras at twelve frames a second.
 */
export const MAXIMUM_RECORDING_BYTES = 512 * 1024 * 1024;

export interface RecordingEntry {
  readonly name: string;
  readonly bytes: number;
  /** Last written, as an ISO 8601 timestamp. */
  readonly modifiedAt: string;
}

/**
 * Names are the whole address of a recording: letters, digits, dot, dash and underscore, ending in
 * `.jsonl.gz` (a recording, being taken or finished), `.jsonl` (one kept uncompressed) or `.json`
 * (the single-document v1 recordings taken before this). No separators, no leading dot, so no name
 * can point outside the directory or at a hidden file, whatever the caller sends.
 */
export function isRecordingName(name: string): boolean {
  return (
    /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}\.(?:json|jsonl|jsonl\.gz)$/u.test(
      name,
    ) && !name.includes('..')
  );
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/** Every line must be an object this format knows, so a broken take is refused as it is written. */
function lineFailure(body: string): string | undefined {
  for (const [index, line] of body.split('\n').entries()) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return `line ${index + 1} is not JSON`;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return `line ${index + 1} is not an object`;
    }
    if (typeof (value as Record<string, unknown>)['type'] !== 'string') {
      return `line ${index + 1} has no type`;
    }
  }
  return undefined;
}

/**
 * A take being written: the compression stream, the file under it, and what it has cost so far.
 *
 * One per recording being taken, kept between requests because the compressor's dictionary is what
 * makes the stream small. A take left open by a page that went away is closed when the host stops, or
 * when it has been idle long enough that it cannot be the one in hand.
 */
interface OpenTake {
  readonly gzip: Gzip;
  readonly out: WriteStream;
  bytes: number;
  lastUsedMs: number;
  failure: string | undefined;
}

/** How long a take may go untouched before the host closes it. Longer than any gap between batches. */
const IDLE_TAKE_MS = 10 * 60 * 1000;

function openTake(path: string): OpenTake {
  const out = createWriteStream(path);
  const gzip = createGzip();
  const take: OpenTake = {
    gzip,
    out,
    bytes: 0,
    lastUsedMs: Date.now(),
    failure: undefined,
  };
  const remember = (error: Error) => {
    take.failure = error.message;
  };
  gzip.on('error', remember);
  out.on('error', remember);
  gzip.pipe(out);
  return take;
}

/** Adds lines to a take and flushes them, so what has been taken is on disk rather than in memory. */
async function writeInto(take: OpenTake, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    take.gzip.write(text, (error) =>
      error === null || error === undefined ? resolve() : reject(error),
    );
  });
  await new Promise<void>((resolve) => {
    take.gzip.flush(constants.Z_SYNC_FLUSH, () => resolve());
  });
  take.bytes = take.out.bytesWritten;
  take.lastUsedMs = Date.now();
}

/** Closes the stream properly, so the file ends with the trailer a reader expects. */
async function closeTake(take: OpenTake): Promise<void> {
  await new Promise<void>((resolve) => {
    take.out.once('close', () => resolve());
    take.out.once('error', () => resolve());
    take.gzip.end();
  });
}

/**
 * Reads a recording's lines, whether or not the take that wrote it was finished.
 *
 * A take still running, or one a crash cut short, has no trailer: `Z_SYNC_FLUSH` tells the
 * decompressor to hand back everything up to the last flush instead of refusing the file for ending
 * early. That is the whole point of flushing as the take runs.
 */
function linesOf(bytes: Buffer): string {
  return gunzipSync(bytes, { finishFlush: constants.Z_SYNC_FLUSH }).toString(
    'utf8',
  );
}

export interface RecordingsRoute {
  (request: Request): Promise<Response>;
  /** Closes every take still being written. Called when the host stops. */
  close(): Promise<void>;
}

export interface RecordingStoreOptions {
  readonly directory: string;
  /** Test seam. Defaults to the real file system. */
  readonly now?: () => Date;
  /** Test seam. Defaults to `MAXIMUM_RECORDING_BYTES`. */
  readonly maximumBytes?: number;
}

/**
 * The `/recordings` route.
 *
 * `GET` without a name lists what is there; `GET` with one returns its lines, unpacked here so a
 * take that is still running or was cut short reads as far as it got. `POST` takes a recording as it
 * runs: `mode=start` opens the compression stream with the header line, `mode=append` adds lines,
 * and `mode=finish` closes the stream and renames the file to its final name. `PUT` writes a whole
 * uncompressed recording at once. `DELETE` removes one. The directory is created on the first write
 * rather than at startup, so a venue that never records leaves no directory behind.
 */
export function createRecordingsRoute(
  options: RecordingStoreOptions,
): RecordingsRoute {
  const { directory } = options;
  const maximumBytes = options.maximumBytes ?? MAXIMUM_RECORDING_BYTES;
  const takes = new Map<string, OpenTake>();

  /** A page that went away leaves its take open; one idle this long is not coming back. */
  const closeIdle = async () => {
    const now = Date.now();
    for (const [name, take] of [...takes]) {
      if (now - take.lastUsedMs < IDLE_TAKE_MS) continue;
      takes.delete(name);
      await closeTake(take);
    }
  };

  const route = async (request: Request): Promise<Response> => {
    await closeIdle();
    const url = new URL(request.url);
    const name = url.searchParams.get('name');
    if (name !== null && !isRecordingName(name)) {
      return json(400, {
        error: 'invalid-name',
        message:
          'A recording name is letters, digits, dot, dash or underscore, ending in .jsonl.gz, .jsonl or .json.',
      });
    }

    if (request.method === 'GET' && name === null) {
      return json(200, { recordings: await list(directory) });
    }
    if (request.method === 'GET') {
      const bytes = await readFile(join(directory, name as string)).catch(
        () => null,
      );
      if (bytes === null) return json(404, { error: 'not-found', name });
      let text: string;
      try {
        text = (name as string).endsWith('.gz')
          ? linesOf(bytes)
          : bytes.toString('utf8');
      } catch {
        return json(422, { error: 'unreadable', name });
      }
      return new Response(text, {
        headers: {
          'Content-Type': (name as string).endsWith('.json')
            ? 'application/json; charset=utf-8'
            : 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }
    if (request.method === 'POST') {
      if (name === null) return json(400, { error: 'name-required' });
      const mode = url.searchParams.get('mode');
      if (mode === null) return json(400, { error: 'mode-required' });
      if (mode !== 'start' && mode !== 'append' && mode !== 'finish') {
        return json(400, { error: 'unknown-mode', mode });
      }
      if (!name.endsWith('.jsonl.gz')) {
        return json(400, {
          error: 'not-a-take',
          message:
            'A recording is taken into a .jsonl.gz, compressed as it runs.',
        });
      }
      const path = join(directory, name);
      if (mode === 'finish') {
        const to = url.searchParams.get('to');
        if (to === null || !isRecordingName(to) || !to.endsWith('.jsonl.gz')) {
          return json(400, { error: 'invalid-target', to });
        }
        const take = takes.get(name);
        if (take === undefined) return json(404, { error: 'not-taking', name });
        takes.delete(name);
        await closeTake(take);
        if (to !== name) await rename(path, join(directory, to));
        return json(200, {
          name: to,
          bytes: (await stat(join(directory, to))).size,
        });
      }
      const body = await request.text();
      const failure = lineFailure(body);
      if (failure !== undefined) {
        return json(400, { error: 'not-session-lines', message: failure });
      }
      if (mode === 'start') {
        const previous = takes.get(name);
        if (previous !== undefined) {
          takes.delete(name);
          await closeTake(previous);
        }
        await mkdir(directory, { recursive: true });
        await rm(path, { force: true });
        const take = openTake(path);
        takes.set(name, take);
        await writeInto(take, ending(body));
        return json(200, { name, bytes: take.bytes });
      }
      const take = takes.get(name);
      if (take === undefined) return json(404, { error: 'not-taking', name });
      if (take.failure !== undefined) {
        return json(500, { error: 'write-failed', message: take.failure });
      }
      // Judged on the disk as it stands: the lines about to be added compress to less than they
      // weigh, so a take is refused once it has reached the limit, not before.
      if (take.bytes >= maximumBytes) {
        return json(413, { error: 'too-large', maximumBytes });
      }
      await writeInto(take, ending(body));
      return json(200, { name, bytes: take.bytes });
    }
    if (request.method === 'PUT') {
      if (name === null) return json(400, { error: 'name-required' });
      if (name.endsWith('.gz')) {
        return json(400, {
          error: 'not-writable',
          message:
            'A compressed recording is produced by taking one, not by writing one.',
        });
      }
      const body = await request.text();
      if (body.length > maximumBytes) {
        return json(413, { error: 'too-large', maximumBytes });
      }
      // Refused rather than written: a file that is not a recording is not found out to be one when
      // it is replayed, which is finding out too late.
      if (name.endsWith('.json')) {
        try {
          JSON.parse(body);
        } catch {
          return json(400, { error: 'not-json' });
        }
      } else {
        const failure = lineFailure(body);
        if (failure !== undefined) {
          return json(400, { error: 'not-session-lines', message: failure });
        }
      }
      await mkdir(directory, { recursive: true });
      await rm(join(directory, name), { force: true });
      await appendFile(join(directory, name), body);
      return json(200, { name, bytes: body.length });
    }
    if (request.method === 'DELETE') {
      if (name === null) return json(400, { error: 'name-required' });
      const take = takes.get(name);
      if (take !== undefined) {
        takes.delete(name);
        await closeTake(take);
      }
      await rm(join(directory, name), { force: true });
      return json(200, { name });
    }
    return json(405, { error: 'method-not-allowed', method: request.method });
  };

  return Object.assign(route, {
    async close() {
      const open = [...takes.values()];
      takes.clear();
      await Promise.all(open.map(closeTake));
    },
  });
}

/** Lines are whole lines on disk, whatever the caller's last chunk ended with. */
function ending(body: string): string {
  if (body === '') return '';
  return body.endsWith('\n') ? body : `${body}\n`;
}

async function list(directory: string): Promise<RecordingEntry[]> {
  const names = await readdir(directory).catch(() => [] as string[]);
  const entries: RecordingEntry[] = [];
  for (const name of names.filter(isRecordingName).sort()) {
    const info = await stat(join(directory, name)).catch(() => null);
    if (!info?.isFile()) continue;
    entries.push({
      name,
      bytes: info.size,
      modifiedAt: info.mtime.toISOString(),
    });
  }
  return entries;
}

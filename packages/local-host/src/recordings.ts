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
 * JSONL), and compressed when it is finished. That is what makes a long take possible: the page holds
 * a few lines rather than the whole session, an interrupted recording leaves the part that was taken
 * rather than nothing at all, and what is kept is about a sixth of the size.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
} from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

/** Path the recordings are served from, next to the application on the same origin. */
export const recordingsPath = '/recordings';

/**
 * How large one recording may grow, before compression.
 *
 * Counted across the appends that build it, so a take that runs away is stopped while it is being
 * written rather than when it is saved. This refuses a mistake, not a session: at four cameras and
 * twelve frames a second it is about an hour.
 */
export const MAXIMUM_RECORDING_BYTES = 64 * 1024 * 1024;

export interface RecordingEntry {
  readonly name: string;
  readonly bytes: number;
  /** Last written, as an ISO 8601 timestamp. */
  readonly modifiedAt: string;
}

/**
 * Names are the whole address of a recording: letters, digits, dot, dash and underscore, ending in
 * `.jsonl.gz` (a finished recording), `.jsonl` (one still being written, or kept uncompressed) or
 * `.json` (the single-document v1 recordings taken before this). No separators, no leading dot, so
 * no name can point outside the directory or at a hidden file, whatever the caller sends.
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

export interface RecordingStoreOptions {
  readonly directory: string;
  /** Test seam. Defaults to the real file system. */
  readonly now?: () => Date;
}

/**
 * The `/recordings` route.
 *
 * `GET` without a name lists what is there; `GET` with one returns it, decompressed by the transport
 * when it is compressed on disk. `PUT` writes a whole recording at once. `POST` writes one in pieces:
 * `mode=start` opens it with its header line, `mode=append` adds lines, and `mode=finish` compresses
 * it under its final name. `DELETE` removes it. The directory is created on the first write rather
 * than at startup, so a venue that never records leaves no directory behind.
 */
export function createRecordingsRoute(options: RecordingStoreOptions) {
  const { directory } = options;
  const sizeOf = async (path: string): Promise<number> =>
    (await stat(path).catch(() => null))?.size ?? 0;

  return async (request: Request): Promise<Response> => {
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
      const path = join(directory, name as string);
      const bytes = await readFile(path).catch(() => null);
      if (bytes === null) return json(404, { error: 'not-found', name });
      const compressed = (name as string).endsWith('.gz');
      return new Response(new Uint8Array(bytes), {
        headers: {
          // Served as the transport's own encoding, so a reader gets the lines without knowing that
          // what is on disk is compressed.
          ...(compressed ? { 'Content-Encoding': 'gzip' } : {}),
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
      if (name.endsWith('.gz')) {
        return json(400, {
          error: 'not-appendable',
          message:
            'A recording is written uncompressed and compressed when it is finished.',
        });
      }
      const path = join(directory, name);
      if (mode === 'finish') {
        const to = url.searchParams.get('to');
        if (to === null || !isRecordingName(to) || !to.endsWith('.jsonl.gz')) {
          return json(400, { error: 'invalid-target', to });
        }
        if ((await stat(path).catch(() => null)) === null) {
          return json(404, { error: 'not-found', name });
        }
        await pipeline(
          createReadStream(path),
          createGzip(),
          createWriteStream(join(directory, to)),
        );
        await rm(path, { force: true });
        return json(200, {
          name: to,
          bytes: await sizeOf(join(directory, to)),
        });
      }
      const body = await request.text();
      const failure = lineFailure(body);
      if (failure !== undefined) {
        return json(400, { error: 'not-session-lines', message: failure });
      }
      const already = mode === 'start' ? 0 : await sizeOf(path);
      if (already + body.length > MAXIMUM_RECORDING_BYTES) {
        return json(413, {
          error: 'too-large',
          maximumBytes: MAXIMUM_RECORDING_BYTES,
        });
      }
      await mkdir(directory, { recursive: true });
      if (mode === 'start') await rm(path, { force: true });
      await appendFile(path, ending(body));
      return json(200, { name, bytes: await sizeOf(path) });
    }
    if (request.method === 'PUT') {
      if (name === null) return json(400, { error: 'name-required' });
      if (name.endsWith('.gz')) {
        return json(400, {
          error: 'not-writable',
          message:
            'A compressed recording is produced by finishing one, not by writing one.',
        });
      }
      const body = await request.text();
      if (body.length > MAXIMUM_RECORDING_BYTES) {
        return json(413, {
          error: 'too-large',
          maximumBytes: MAXIMUM_RECORDING_BYTES,
        });
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
      await rm(join(directory, name), { force: true });
      return json(200, { name });
    }
    return json(405, { error: 'method-not-allowed', method: request.method });
  };
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

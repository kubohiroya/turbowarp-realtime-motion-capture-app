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
 */

import {mkdir, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

/** Path the recordings are served from, next to the application on the same origin. */
export const recordingsPath = '/recordings';

/** A recording is JSON, and a long one is a few megabytes; this refuses a mistake, not a session. */
export const MAXIMUM_RECORDING_BYTES = 64 * 1024 * 1024;

export interface RecordingEntry {
  readonly name: string;
  readonly bytes: number;
  /** Last written, as an ISO 8601 timestamp. */
  readonly modifiedAt: string;
}

/**
 * Names are the whole address of a recording: letters, digits, dot, dash and underscore, ending in
 * `.json`. No separators, no leading dot, so no name can point outside the directory or at a hidden
 * file, whatever the caller sends.
 */
export function isRecordingName(name: string): boolean {
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}\.json$/u.test(name) && !name.includes('..');
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}
  });
}

export interface RecordingStoreOptions {
  readonly directory: string;
  /** Test seam. Defaults to the real file system. */
  readonly now?: () => Date;
}

/**
 * The `/recordings` route.
 *
 * `GET` without a name lists what is there; `GET` with one returns it; `PUT` writes it; `DELETE`
 * removes it. The directory is created on the first write rather than at startup, so a venue that
 * never records leaves no directory behind.
 */
export function createRecordingsRoute(options: RecordingStoreOptions) {
  const {directory} = options;
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const name = url.searchParams.get('name');
    if (name !== null && !isRecordingName(name)) {
      return json(400, {error: 'invalid-name', message: 'A recording name is letters, digits, dot, dash or underscore, ending in .json.'});
    }

    if (request.method === 'GET' && name === null) {
      return json(200, {recordings: await list(directory)});
    }
    if (request.method === 'GET') {
      const text = await readFile(join(directory, name as string), 'utf8').catch(() => null);
      if (text === null) return json(404, {error: 'not-found', name});
      return new Response(text, {
        headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}
      });
    }
    if (request.method === 'PUT' || request.method === 'POST') {
      if (name === null) return json(400, {error: 'name-required'});
      const body = await request.text();
      if (body.length > MAXIMUM_RECORDING_BYTES) {
        return json(413, {error: 'too-large', maximumBytes: MAXIMUM_RECORDING_BYTES});
      }
      // Refused rather than written: a file that is not JSON is not a recording, and finding that
      // out when it is replayed is finding out too late.
      try {
        JSON.parse(body);
      } catch {
        return json(400, {error: 'not-json'});
      }
      await mkdir(directory, {recursive: true});
      await writeFile(join(directory, name), body);
      return json(200, {name, bytes: body.length});
    }
    if (request.method === 'DELETE') {
      if (name === null) return json(400, {error: 'name-required'});
      await rm(join(directory, name), {force: true});
      return json(200, {name});
    }
    return json(405, {error: 'method-not-allowed', method: request.method});
  };
}

async function list(directory: string): Promise<RecordingEntry[]> {
  const names = await readdir(directory).catch(() => [] as string[]);
  const entries: RecordingEntry[] = [];
  for (const name of names.filter(isRecordingName).sort()) {
    const info = await stat(join(directory, name)).catch(() => null);
    if (!info?.isFile()) continue;
    entries.push({name, bytes: info.size, modifiedAt: info.mtime.toISOString()});
  }
  return entries;
}

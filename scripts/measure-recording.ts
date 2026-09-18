/**
 * How long a recording can run, measured rather than guessed (#36, DEBUG_POSE_REPLAY).
 *
 * A venue take is minutes long, and what stops it is not obvious from the code: the frames go over
 * HTTP to the venue host and into a compression stream the host keeps open for the take. This drives that
 * path with frames shaped exactly as the camera app sends them — full precision coordinates, COCO-17,
 * the pose frame's own envelope — and reports what it cost: how long an append takes, how fast the
 * file grows on disk, how long finishing and reading back take, and where the host's size limit
 * lands in minutes.
 *
 * It measures the recording path, not the cameras: nothing here runs MoveNet or opens a camera, so
 * the inference cost and the timing of real hardware are not in these figures. What is in them is
 * every line of the path a frame takes once it has been estimated.
 *
 *   node --experimental-strip-types scripts/measure-recording.ts --cameras 4 --fps 12 --minutes 10
 *
 * `--persons n`, `--digits n` (round the coordinates, which the apps do not), `--batch n`,
 * `--directory <path>` and `--keep` (leave the finished recording there, to replay it elsewhere).
 */

import { createServer } from 'node:net';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { constants, createGunzip } from 'node:zlib';

import { startLocalHost } from '../packages/local-host/src/host.ts';
import {
  parseSessionHeader,
  parseSessionLine,
} from '../packages/pose-3d-service/src/session.ts';
import { MAXIMUM_RECORDING_BYTES } from '../packages/local-host/src/recordings.ts';

const COCO_17 = [
  'nose',
  'left_eye',
  'right_eye',
  'left_ear',
  'right_ear',
  'left_shoulder',
  'right_shoulder',
  'left_elbow',
  'right_elbow',
  'left_wrist',
  'right_wrist',
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
  'left_ankle',
  'right_ankle',
] as const;

interface Options {
  readonly cameras: number;
  readonly fps: number;
  readonly minutes: number;
  readonly persons: number;
  /** Lines per request, as the app batches them. */
  readonly batch: number;
  /** Decimals kept on a coordinate. Zero keeps MoveNet's own numbers, which is what is sent today. */
  readonly digits: number;
  readonly json: boolean;
  /** Where the recording is written. A temporary directory unless one is named. */
  readonly directory: string;
  /** Keeps the finished recording, for replaying it somewhere else. */
  readonly keep: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined || !argument.startsWith('--')) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      values[argument.slice(2)] = '';
      continue;
    }
    values[argument.slice(2)] = next;
    index += 1;
  }
  const number = (name: string, fallback: number) => {
    const value = Number(values[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    cameras: Math.round(number('cameras', 4)),
    fps: number('fps', 12),
    minutes: number('minutes', 10),
    persons: Math.round(number('persons', 2)),
    batch: Math.round(number('batch', 32)),
    digits: Math.round(number('digits', 0)),
    json: values['json'] !== undefined,
    directory: values['directory'] ?? '',
    keep: values['keep'] !== undefined,
  };
}

/**
 * One camera's frame, the shape the camera app sends.
 *
 * Coordinates are left at full precision because that is what the pose extension sends: MoveNet's
 * own numbers, unrounded. Rounding them would make every figure here look better than a venue's.
 */
function poseFrame(
  cameraId: string,
  sequence: number,
  captureTimestampUs: number,
  persons: number,
  random: () => number,
  digits: number,
): Record<string, unknown> {
  const round = (value: number) =>
    digits > 0 ? Number(value.toFixed(digits)) : value;
  return {
    schema: 'twrmc/pose-frame-2d',
    version: 1,
    cameraId,
    peerId: cameraId,
    sequence,
    captureTimestampUs,
    frameWidth: 1280,
    frameHeight: 720,
    calibrationId: `cal-${cameraId}`,
    persons: Array.from({ length: persons }, (_, person) => ({
      trackingId: `movenet-${person}`,
      score: round(0.5 + random() * 0.5),
      keypoints: COCO_17.map((id, index) => ({
        id,
        x: round(200 + index * 17 + random() * 40),
        y: round(120 + index * 23 + random() * 40),
        score: round(0.4 + random() * 0.6),
      })),
    })),
  };
}

/** A seeded generator, so two runs of the same options produce the same bytes. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  return await new Promise<number>((resolve, reject) => {
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

function quantile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round(fraction * (sorted.length - 1))),
  );
  return sorted[index] ?? 0;
}

const megabytes = (bytes: number) => bytes / (1024 * 1024);
const milliseconds = (value: number) => Math.round(value * 100) / 100;

/** Heap is sampled after this much text has gone by, rather than on every chunk. */
const HEAP_SAMPLE_CHARACTERS = 1024 * 1024;

/**
 * Fetches a finished recording and reads it back line by line, as the page does (#54).
 *
 * A recording at the host's limit unpacks to more than V8 can hold as one string (512 MB on disk is
 * about 1.7 GB of lines), so the body is unpacked as it arrives and each line is read by the same
 * rules `parseSession` applies, then dropped: only the count is kept.
 *
 * Fetching, unpacking and parsing are interleaved, so the figures are split by where the time went:
 * `parseMs` is the time spent inside the line parser, and `readMs` the rest of the wall clock —
 * fetching, unpacking, decoding and splitting into lines. `heapGrowth` is the most the heap grew above
 * where it started while reading, sampled every megabyte of text; since nothing is kept, it is the
 * reader's working set, not the size of the parsed recording. Indicative only: the collector runs when
 * it likes, and a fall is reported as zero.
 */
async function readBackRecording(url: string): Promise<
  | {
      ok: true;
      events: number;
      readMs: number;
      parseMs: number;
      heapGrowth: number;
    }
  | { ok: false; reason: string }
> {
  const startedAt = performance.now();
  const heapBefore = process.memoryUsage().heapUsed;
  let heapPeak = heapBefore;
  let sinceSample = 0;
  let parseMs = 0;
  let lineNumber = 0;
  let events = 0;
  let ended = false;
  let failure: string | undefined;

  const readLine = (line: string) => {
    lineNumber += 1;
    const at = performance.now();
    if (lineNumber === 1) {
      const header = parseSessionHeader(line);
      if (!header.ok) failure = header.reason;
    } else {
      const read = parseSessionLine(line, lineNumber);
      if (read.kind === 'end') ended = true;
      else if (read.kind === 'failed') failure = read.reason;
      else if (read.kind === 'event') events += 1;
    }
    parseMs += performance.now() - at;
  };

  const response = await fetch(url);
  if (!response.ok || response.body === null)
    return { ok: false, reason: `the host answered ${response.status}` };
  // Served as stored; unpacked here, as the page does with its own decompressor.
  const text = Readable.fromWeb(
    response.body as unknown as NodeReadableStream<Uint8Array>,
  )
    .pipe(createGunzip({ finishFlush: constants.Z_SYNC_FLUSH }))
    .setEncoding('utf8');
  let carry = '';
  for await (const chunk of text as AsyncIterable<string>) {
    const lines = `${carry}${chunk}`.split('\n');
    carry = lines.pop() ?? '';
    for (const line of lines) {
      readLine(line);
      if (ended || failure !== undefined) break;
    }
    if (ended || failure !== undefined) {
      text.destroy();
      break;
    }
    sinceSample += chunk.length;
    if (sinceSample >= HEAP_SAMPLE_CHARACTERS) {
      sinceSample = 0;
      heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
    }
  }
  if (!ended && failure === undefined && carry !== '') readLine(carry);
  heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
  if (failure !== undefined) return { ok: false, reason: failure };
  if (lineNumber === 0) return { ok: false, reason: 'the recording is empty' };
  const totalMs = performance.now() - startedAt;
  return {
    ok: true,
    events,
    readMs: totalMs - parseMs,
    parseMs,
    heapGrowth: heapPeak - heapBefore,
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const options = parseOptions(argv);
  const directory = await mkdtemp(join(tmpdir(), 'measure-recording-'));
  const recordings =
    options.directory === ''
      ? join(directory, 'recordings')
      : options.directory;
  const started = await startLocalHost({
    app: 'measure-recording',
    title: 'measure',
    port: await freePort(),
    lockDirectory: join(directory, 'run'),
    player: { html: '<!doctype html><title>measure</title>' },
    recordingsDirectory: recordings,
  });
  if (!started.started) {
    console.error(`The host did not start: ${started.reason}`);
    return 1;
  }
  const host = started.host;
  const token = new URL(host.url).searchParams.get('token') ?? '';
  const route = (query: string) =>
    `${host.origin}/recordings?token=${token}${query}`;
  const working = 'measure-taking.jsonl.gz';
  const finished = 'measure-take.jsonl.gz';

  const random = seeded(1);
  const headerLine = `${JSON.stringify({
    type: 'header',
    schema: 'twrmc/pose-3d-session',
    version: 2,
    producer: 'measure-recording',
    configuration: {
      implementation: 'fusion-v0',
      referenceId: 'venue',
      cameras: [],
    },
  })}\n`;

  /** The host's answer and what it cost. A refusal is a measurement too, not a crash. */
  const post = async (
    query: string,
    body: string,
  ): Promise<{ took: number; status: number }> => {
    const at = performance.now();
    const response = await fetch(route(query), { method: 'POST', body });
    const took = performance.now() - at;
    if (!response.ok && response.status !== 413) {
      throw new Error(
        `${query}: ${response.status} ${JSON.stringify(await response.json())}`,
      );
    }
    return { took, status: response.status };
  };

  await post(`&name=${working}&mode=start`, headerLine);

  const frameCount = Math.round(
    options.cameras * options.fps * options.minutes * 60,
  );
  const periodUs = Math.round(1_000_000 / options.fps);
  const appendTimes: number[] = [];
  let lines: string[] = [];
  const wallStart = performance.now();

  let written = 0;
  let refusedAt = 0;
  let rawBytes = headerLine.length;
  for (let index = 0; index < frameCount; index += 1) {
    const camera = index % options.cameras;
    const step = Math.floor(index / options.cameras);
    const line = JSON.stringify({
      type: 'frame2d',
      atUs: 1_800_000_000_000_000 + step * periodUs,
      cameraId: `camera-${camera + 1}`,
      frame: poseFrame(
        `camera-${camera + 1}`,
        step,
        1_800_000_000_000_000 + step * periodUs,
        options.persons,
        random,
        options.digits,
      ),
    });
    lines.push(line);
    if (lines.length >= options.batch) {
      const body = `${lines.join('\n')}\n`;
      const answer = await post(`&name=${working}&mode=append`, body);
      appendTimes.push(answer.took);
      // The host refuses the batch that would pass its limit: the take stops there, as it does in
      // the app, and everything already written stays.
      if (answer.status === 413) {
        refusedAt = written;
        break;
      }
      written += lines.length;
      rawBytes += body.length;
      lines = [];
    }
  }
  if (refusedAt === 0 && lines.length > 0) {
    const body = `${lines.join('\n')}\n`;
    const answer = await post(`&name=${working}&mode=append`, body);
    appendTimes.push(answer.took);
    if (answer.status === 413) refusedAt = written;
    else {
      written += lines.length;
      rawBytes += body.length;
    }
  }
  const writeSeconds = (performance.now() - wallStart) / 1000;
  const onDisk = (await stat(join(recordings, working))).size;

  const compressMs = (
    await post(`&name=${working}&mode=finish&to=${finished}`, '')
  ).took;
  const compressed = (await stat(join(recordings, finished))).size;

  const readBack = await readBackRecording(route(`&name=${finished}`));
  if (!readBack.ok) {
    console.error(`The recording did not read back: ${readBack.reason}`);
    await host.stop();
    return 1;
  }

  const sorted = [...appendTimes].sort((left, right) => left - right);
  const perFrame = rawBytes / written;
  const perFrameOnDisk = onDisk / written;
  const framesPerSecond = options.cameras * options.fps;
  // The host counts what the disk holds, which is the compressed size.
  const limitMinutes =
    MAXIMUM_RECORDING_BYTES / perFrameOnDisk / framesPerSecond / 60;
  const report = {
    cameras: options.cameras,
    fps: options.fps,
    persons: options.persons,
    digits: options.digits,
    minutes: options.minutes,
    frames: written,
    asked: frameCount,
    stoppedByLimit: refusedAt > 0,
    eventsReadBack: readBack.events,
    bytesPerFrame: Math.round(perFrame),
    uncompressedMB: Math.round(megabytes(rawBytes) * 100) / 100,
    compressedMB: Math.round(megabytes(compressed) * 100) / 100,
    ratio: Math.round((rawBytes / compressed) * 10) / 10,
    appends: appendTimes.length,
    appendMedianMs: milliseconds(quantile(sorted, 0.5)),
    appendP95Ms: milliseconds(quantile(sorted, 0.95)),
    appendMaxMs: milliseconds(sorted[sorted.length - 1] ?? 0),
    writeSeconds: Math.round(writeSeconds * 10) / 10,
    finishMs: Math.round(compressMs),
    readMs: Math.round(readBack.readMs),
    parseMs: Math.round(readBack.parseMs),
    parsedHeapMB: Math.round(megabytes(readBack.heapGrowth) * 10) / 10,
    limitMinutes: Math.round(limitMinutes),
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      [
        `${report.cameras} cameras x ${report.fps} fps x ${report.persons} persons${report.digits > 0 ? ` rounded to ${report.digits} decimals` : ''}, ${report.minutes} minutes of movement`,
        `  frames         ${report.frames} written of ${report.asked} asked${report.stoppedByLimit ? ' (the host stopped the take at its limit)' : ''}, ${report.eventsReadBack} read back`,
        `  size           ${report.bytesPerFrame} B/frame, ${report.uncompressedMB} MB of lines, ${report.compressedMB} MB on disk (${report.ratio}x)`,
        `  append         ${report.appends} requests, median ${report.appendMedianMs} ms, p95 ${report.appendP95Ms} ms, max ${report.appendMaxMs} ms`,
        `  writing        ${report.writeSeconds} s of wall clock for ${report.minutes} minutes of movement`,
        `  finishing      ${report.finishMs} ms (the take was compressed as it ran)`,
        `  reading back   ${report.readMs} ms to fetch, ${report.parseMs} ms to parse, ${report.parsedHeapMB} MB of heap at most`,
        `  size limit     ${report.limitMinutes} minutes at this rate (${Math.round(megabytes(MAXIMUM_RECORDING_BYTES))} MB)`,
      ].join('\n'),
    );
  }

  await host.stop();
  if (options.keep)
    console.log(`  kept           ${join(recordings, finished)}`);
  else if (options.directory !== '')
    await rm(join(recordings, finished), { force: true });
  await rm(directory, { recursive: true, force: true });
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

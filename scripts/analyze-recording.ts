/**
 * What a recording taken on real hardware says about frame rate and latency.
 *
 * A measurement build records every pose frame with two times on the same page clock: when the camera
 * captured the frame (`captureTimestampUs`, from the camera's own frame callback) and when the frame
 * reached the application as a pose (`atUs`). The first spacing is the camera's and the estimator's
 * frame rate as delivered; the difference between the two is how long a frame took from the sensor to
 * a pose the application could send — MoveNet's inference, the frame wait before it, and the VM's
 * scheduling, together.
 *
 *   pnpm run analyze:recording -- ~/multiview-pose-recordings/camera-app-1.jsonl.gz --fps 30
 *
 * `--fps n` is the rate the camera was asked for, to say how much of it arrived. `--json` prints the
 * figures for pasting into an issue.
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { constants, gunzipSync } from 'node:zlib';

import { parseSession } from '../packages/pose-3d-service/src/session.ts';

interface Frame {
  readonly atUs: number;
  readonly captureUs: number;
  readonly sequence: number;
  readonly persons: number;
}

interface CameraFigures {
  readonly cameraId: string;
  readonly frames: number;
  readonly seconds: number;
  readonly fps: number;
  readonly delivered: number | null;
  readonly intervalMs: Quantiles;
  readonly gaps: number;
  readonly longestGapMs: number;
  readonly sequenceSkips: number;
  readonly duplicates: number;
  readonly latencyMs: Quantiles;
  readonly negativeLatency: number;
  readonly personsMean: number;
  readonly personsMax: number;
  readonly framesWithoutPersons: number;
}

interface Quantiles {
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

function quantiles(values: readonly number[]): Quantiles {
  if (values.length === 0) return { p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction: number) =>
    sorted[
      Math.min(sorted.length - 1, Math.round(fraction * (sorted.length - 1)))
    ] ?? 0;
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted[sorted.length - 1] ?? 0),
  };
}

function figuresFor(
  cameraId: string,
  recorded: Frame[],
  askedFps: number | null,
): CameraFigures {
  recorded.sort((left, right) => left.captureUs - right.captureUs);
  // The same frame recorded twice is one frame: counted, then left out, or it would read as a
  // zero-length interval and halve the median.
  const frames = recorded.filter(
    (frame, index) =>
      index === 0 || frame.captureUs !== recorded[index - 1]!.captureUs,
  );
  const duplicates = recorded.length - frames.length;
  const intervals: number[] = [];
  let sequenceSkips = 0;
  for (let index = 1; index < frames.length; index += 1) {
    const previous = frames[index - 1]!;
    const current = frames[index]!;
    intervals.push((current.captureUs - previous.captureUs) / 1000);
    if (current.sequence > previous.sequence + 1)
      sequenceSkips += current.sequence - previous.sequence - 1;
  }
  const interval = quantiles(intervals);
  // A gap is an interval half again as long as the usual one: a frame the camera or the estimator
  // did not deliver.
  const gapThreshold = interval.p50 * 1.5;
  const gaps = intervals.filter((value) => value > gapThreshold);
  const seconds =
    frames.length < 2
      ? 0
      : (frames[frames.length - 1]!.captureUs - frames[0]!.captureUs) /
        1_000_000;
  const fps = seconds > 0 ? (frames.length - 1) / seconds : 0;
  const latencies = frames.map(
    (frame) => (frame.atUs - frame.captureUs) / 1000,
  );
  const persons = frames.map((frame) => frame.persons);
  return {
    cameraId,
    frames: frames.length,
    seconds: Math.round(seconds * 10) / 10,
    fps: Math.round(fps * 10) / 10,
    delivered:
      askedFps === null || askedFps <= 0
        ? null
        : Math.round((fps / askedFps) * 1000) / 10,
    intervalMs: interval,
    gaps: gaps.length,
    longestGapMs: Math.round(Math.max(0, ...gaps)),
    sequenceSkips,
    duplicates,
    latencyMs: quantiles(latencies.filter((value) => value >= 0)),
    negativeLatency: latencies.filter((value) => value < 0).length,
    personsMean:
      Math.round(
        (persons.reduce((total, value) => total + value, 0) /
          Math.max(1, persons.length)) *
          100,
      ) / 100,
    personsMax: Math.max(0, ...persons),
    framesWithoutPersons: persons.filter((value) => value === 0).length,
  };
}

/**
 * How far apart in time the cameras' frames are, against the first camera: for each of its frames,
 * the nearest frame of the other camera. Only meaningful for cameras on one page clock, as the local
 * app's are; a camera app's recording holds one camera.
 */
function alignment(
  byCamera: Map<string, Frame[]>,
): Array<{ cameraId: string; offsetMs: Quantiles }> {
  const cameras = [...byCamera.keys()].sort();
  const reference = byCamera.get(cameras[0] ?? '') ?? [];
  return cameras.slice(1).map((cameraId) => {
    const other = byCamera.get(cameraId) ?? [];
    const offsets: number[] = [];
    let cursor = 0;
    for (const frame of reference) {
      while (
        cursor + 1 < other.length &&
        Math.abs(other[cursor + 1]!.captureUs - frame.captureUs) <=
          Math.abs(other[cursor]!.captureUs - frame.captureUs)
      ) {
        cursor += 1;
      }
      const nearest = other[cursor];
      if (nearest)
        offsets.push(Math.abs(nearest.captureUs - frame.captureUs) / 1000);
    }
    return { cameraId, offsetMs: quantiles(offsets) };
  });
}

function parseArguments(argv: readonly string[]) {
  const files: string[] = [];
  let fps: number | null = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--') continue;
    if (argument === '--json') json = true;
    else if (argument === '--fps') {
      fps = Number(argv[index + 1]);
      index += 1;
    } else files.push(argument);
  }
  return {
    files,
    fps: fps !== null && Number.isFinite(fps) && fps > 0 ? fps : null,
    json,
  };
}

async function analyze(path: string, askedFps: number | null) {
  const bytes = await readFile(path);
  // A take still running, or one a crash cut short, has no trailer: read it as far as it got.
  const text = path.endsWith('.gz')
    ? gunzipSync(bytes, { finishFlush: constants.Z_SYNC_FLUSH }).toString(
        'utf8',
      )
    : bytes.toString('utf8');
  const parsed = parseSession(text);
  if (!parsed.ok) throw new Error(`${path}: ${parsed.reason}`);
  const byCamera = new Map<string, Frame[]>();
  for (const event of parsed.session.events) {
    if (event.type !== 'frame2d') continue;
    const frame = event.frame as unknown as Record<string, unknown>;
    const captureUs = Number(frame['captureTimestampUs']);
    if (!(captureUs > 0)) continue;
    const list = byCamera.get(event.cameraId) ?? [];
    list.push({
      atUs: event.atUs,
      captureUs,
      sequence: Number(frame['sequence']) || 0,
      persons: Array.isArray(frame['persons']) ? frame['persons'].length : 0,
    });
    byCamera.set(event.cameraId, list);
  }
  const cameras = [...byCamera.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([cameraId, frames]) => figuresFor(cameraId, frames, askedFps));
  return {
    file: basename(path),
    producer: parsed.session.producer,
    askedFps,
    cameras,
    alignment: alignment(byCamera),
  };
}

function format(report: Awaited<ReturnType<typeof analyze>>): string {
  const lines = [`${report.file} (${report.producer})`];
  for (const camera of report.cameras) {
    lines.push(
      `  ${camera.cameraId}: ${camera.frames} frames over ${camera.seconds} s`,
      `    frame rate     ${camera.fps} fps${camera.delivered === null ? '' : ` (${camera.delivered}% of ${report.askedFps} fps asked)`}`,
      `    interval       median ${camera.intervalMs.p50} ms, p95 ${camera.intervalMs.p95} ms, max ${camera.intervalMs.max} ms`,
      `    gaps           ${camera.gaps} (longest ${camera.longestGapMs} ms), sequence skips ${camera.sequenceSkips}${camera.duplicates > 0 ? `, ${camera.duplicates} frames recorded twice` : ''}`,
      `    capture->pose  median ${camera.latencyMs.p50} ms, p95 ${camera.latencyMs.p95} ms, max ${camera.latencyMs.max} ms${camera.negativeLatency > 0 ? ` (${camera.negativeLatency} frames before their capture: clocks disagree)` : ''}`,
      `    persons        mean ${camera.personsMean}, max ${camera.personsMax}, none in ${camera.framesWithoutPersons} frames`,
    );
  }
  for (const pair of report.alignment) {
    lines.push(
      `  ${report.cameras[0]?.cameraId} vs ${pair.cameraId}: nearest frame median ${pair.offsetMs.p50} ms, p95 ${pair.offsetMs.p95} ms apart`,
    );
  }
  return lines.join('\n');
}

const options = parseArguments(process.argv.slice(2));
if (options.files.length === 0) {
  console.error(
    'Usage: pnpm run analyze:recording -- <recording.jsonl.gz> [...] [--fps n] [--json]',
  );
  process.exitCode = 1;
} else {
  try {
    const reports = [];
    for (const file of options.files)
      reports.push(await analyze(file, options.fps));
    console.log(
      options.json
        ? JSON.stringify(reports, null, 2)
        : reports.map(format).join('\n\n'),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

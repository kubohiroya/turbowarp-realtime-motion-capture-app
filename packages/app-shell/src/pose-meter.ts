/**
 * Measures several cameras' pose estimation taking turns on one GPU (#36, stage 3).
 *
 * The project infers each running camera in turn and hands this meter each camera's pose status after
 * its turn. What the stage decides from is here: how long one inference takes per camera, how many
 * frames a second each camera gets inferred, how long after capture a result exists, how far apart
 * the cameras' latest frames were captured, and how long a whole round of cameras takes.
 *
 * Capture timestamps come from Camera Source, on this page's clock, so they are compared with this
 * page's clock read through the same origin (`performance.timeOrigin + performance.now()`).
 */

export interface PoseMeterHost {
  /** Monotonic milliseconds. */
  nowMs(): number;
  /** Microseconds since the Unix epoch on this page's clock, the domain capture times are in. */
  pageTimeUs(): number;
}

/** The part of `pose status JSON of camera` the meter reads. */
interface PoseStatus {
  readonly state?: string;
  readonly error?: string;
  readonly inferences?: number;
  readonly skippedFrames?: number;
  readonly lastInferenceMs?: number;
  readonly frameTimeSource?: string;
  readonly captureTimestampUs?: number;
  readonly persons?: number;
}

export interface PoseCameraMeasurement {
  readonly cameraId: string;
  readonly state: string;
  readonly error: string;
  /** Duration of the camera's last inference. */
  readonly inferenceMs: number;
  /** Inferences per second over the last complete window. */
  readonly inferenceFps: number;
  /** Turns given away per second because the camera had no new frame. */
  readonly skippedFps: number;
  /** From capture of the latest inferred frame to when its result was read. */
  readonly captureToResultMs: number;
  readonly frameTimeSource: string;
  readonly persons: number;
}

export interface PoseMeasurement {
  readonly cameras: readonly PoseCameraMeasurement[];
  /** A round of every camera, averaged over the last complete window. */
  readonly cycleMs: number;
  /** Latest capture time of the newest camera minus that of the oldest, over the last round. */
  readonly captureSpreadMs: number;
}

interface CameraWindow {
  status: PoseStatus;
  captureToResultMs: number;
  windowStartMs: number;
  windowInferences: number;
  windowSkipped: number;
  inferenceFps: number;
  skippedFps: number;
}

const WINDOW_MS = 1_000;

export class PoseMeter {
  private readonly host: PoseMeterHost;
  private readonly cameras = new Map<string, CameraWindow>();
  private cycleWindowStartMs: number | undefined;
  private cyclesInWindow = 0;
  private cycleMs = 0;
  private roundCaptures = new Map<string, number>();
  private captureSpreadMs = 0;

  public constructor(host: PoseMeterHost) {
    this.host = host;
  }

  /** Records one camera's status after its turn. Text that is not a status object is ignored. */
  public record(cameraId: string, statusJson: string): void {
    const status = parseStatus(statusJson);
    if (!status) return;
    const now = this.host.nowMs();
    let camera = this.cameras.get(cameraId);
    if (!camera) {
      camera = {
        status,
        captureToResultMs: 0,
        windowStartMs: now,
        windowInferences: status.inferences ?? 0,
        windowSkipped: status.skippedFrames ?? 0,
        inferenceFps: 0,
        skippedFps: 0,
      };
      this.cameras.set(cameraId, camera);
    }
    const previousCapture = camera.status.captureTimestampUs ?? 0;
    camera.status = status;
    const capture = status.captureTimestampUs ?? 0;
    if (capture > 0) {
      if (capture !== previousCapture || camera.captureToResultMs === 0) {
        camera.captureToResultMs = round1(
          (this.host.pageTimeUs() - capture) / 1000,
        );
      }
      this.roundCaptures.set(cameraId, capture);
    }
    const elapsed = now - camera.windowStartMs;
    if (elapsed >= WINDOW_MS) {
      camera.inferenceFps = round1(
        (((status.inferences ?? 0) - camera.windowInferences) * 1000) / elapsed,
      );
      camera.skippedFps = round1(
        (((status.skippedFrames ?? 0) - camera.windowSkipped) * 1000) / elapsed,
      );
      camera.windowStartMs = now;
      camera.windowInferences = status.inferences ?? 0;
      camera.windowSkipped = status.skippedFrames ?? 0;
    }
  }

  /** Marks the end of a round of every camera. */
  public endCycle(): void {
    const now = this.host.nowMs();
    const captures = [...this.roundCaptures.values()];
    this.captureSpreadMs =
      captures.length < 2
        ? 0
        : round1((Math.max(...captures) - Math.min(...captures)) / 1000);
    this.roundCaptures = new Map();
    if (this.cycleWindowStartMs === undefined) {
      this.cycleWindowStartMs = now;
      this.cyclesInWindow = 0;
      return;
    }
    this.cyclesInWindow += 1;
    const elapsed = now - this.cycleWindowStartMs;
    if (elapsed >= WINDOW_MS) {
      this.cycleMs = round1(elapsed / this.cyclesInWindow);
      this.cycleWindowStartMs = now;
      this.cyclesInWindow = 0;
    }
  }

  /**
   * How long ago a PoseFrame2D's frame was captured, in milliseconds on this page's clock, or -1 for
   * text that is not a frame with a capture time. The 3D service refuses frames older than its limit.
   */
  public frameAgeMs(frameJson: string): number {
    const frame = parseStatus(frameJson) as
      { captureTimestampUs?: unknown } | undefined;
    const capture = Number(frame?.captureTimestampUs);
    if (!(capture > 0)) return -1;
    return round1((this.host.pageTimeUs() - capture) / 1000);
  }

  public forget(cameraId: string): void {
    this.cameras.delete(cameraId);
    this.roundCaptures.delete(cameraId);
  }

  public reset(): void {
    this.cameras.clear();
    this.roundCaptures.clear();
    this.cycleWindowStartMs = undefined;
    this.cyclesInWindow = 0;
    this.cycleMs = 0;
    this.captureSpreadMs = 0;
  }

  public measurement(): PoseMeasurement {
    return {
      cameras: [...this.cameras.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([cameraId, camera]) => ({
          cameraId,
          state: camera.status.state ?? '',
          error: camera.status.error ?? '',
          inferenceMs: round1(camera.status.lastInferenceMs ?? 0),
          inferenceFps: camera.inferenceFps,
          skippedFps: camera.skippedFps,
          captureToResultMs: camera.captureToResultMs,
          frameTimeSource: camera.status.frameTimeSource ?? '',
          persons: camera.status.persons ?? 0,
        })),
      cycleMs: this.cycleMs,
      captureSpreadMs: this.captureSpreadMs,
    };
  }

  /** One line for the operator. */
  public summary(): string {
    const measurement = this.measurement();
    if (measurement.cameras.length === 0) return '';
    const cameras = measurement.cameras.map((camera) =>
      camera.state === 'error'
        ? `${camera.cameraId}: エラー ${camera.error}`
        : `${camera.cameraId}: 推論${camera.inferenceMs}ms ${camera.inferenceFps}fps 撮影→結果${camera.captureToResultMs}ms ${camera.persons}人${sourceNote(camera.frameTimeSource)}`,
    );
    return `1周${measurement.cycleMs}ms 撮影時刻のばらつき${measurement.captureSpreadMs}ms — ${cameras.join(' / ')}`;
  }
}

function sourceNote(source: string): string {
  if (source === 'presentation') return '（撮影時刻なし・表示時刻で代用）';
  if (source === '') return '（時刻なし）';
  return '';
}

function parseStatus(text: string): PoseStatus | undefined {
  if (text.trim() === '') return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as PoseStatus)
      : undefined;
  } catch {
    return undefined;
  }
}

function round1(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
}

export function createBrowserPoseMeterHost(): PoseMeterHost {
  const now = () =>
    typeof performance === 'undefined' ? Date.now() : performance.now();
  return {
    nowMs: now,
    pageTimeUs: () =>
      typeof performance === 'undefined'
        ? Date.now() * 1000
        : Math.round((performance.timeOrigin + performance.now()) * 1000),
  };
}

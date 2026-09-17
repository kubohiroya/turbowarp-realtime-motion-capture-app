/**
 * Recording the poses the cameras were estimated to show, and playing them back without them
 * (DEBUG_POSE_REPLAY).
 *
 * Every stage after the camera — association, triangulation, identity, the avatar — has to be worked
 * on repeatedly against the same movement, and a performance cannot be repeated. What is recorded is
 * the 2D poses as they were estimated — not the camera's pixels — with the calibration they were
 * estimated under, so the rest of the pipeline can be run again at a desk: the camera app replays instead of opening a camera, the fusion
 * app replays instead of waiting for a camera app over WebRTC, and the local app replays instead of
 * doing either.
 *
 * Recordings are files, not browser storage. Storage belongs to one origin, and each application has
 * its own port, so a recording made in one would be invisible to the next; a file on the venue PC is
 * read by all of them through their own host, and can be copied, kept and compared like any other
 * file. Where no host serves them — a bare SB3 in TurboWarp — the operator saves and opens the file
 * themselves.
 *
 * The format is `twrmc/pose-3d-session` v1, the same one the 3D service's evaluation tool replays, so
 * a recording taken at a venue can be measured offline without being converted first.
 */

export const RECORDING_SCHEMA = 'twrmc/pose-3d-session';
export const RECORDING_VERSION = 1;
/** Kept equal to `recordingsPath` in `packages/local-host/src/recordings.ts`. */
export const recordingsRoute = '/recordings';

export interface RecordingEntry {
  readonly name: string;
  readonly bytes: number;
  readonly modifiedAt: string;
}

/** Where recordings live, when a venue host serves them. */
export interface RecordingStorePort {
  /** Whether this page is served beside a host that keeps recordings. */
  available(): boolean;
  list(): Promise<RecordingEntry[]>;
  read(name: string): Promise<string>;
  write(name: string, text: string): Promise<void>;
}

export interface PoseReplayHost {
  /** Microseconds since the Unix epoch on this page's clock, the domain capture times are in. */
  pageTimeUs(): number;
  store: RecordingStorePort;
  /** Asks the operator for a recording file. Resolves to its text, or null when they gave up. */
  chooseFile(): Promise<string | null>;
  /** Offers the recording to the operator as a file to keep. */
  saveFile(name: string, text: string): void;
}

interface RecordedFrame {
  readonly type: 'frame2d';
  readonly atUs: number;
  readonly cameraId: string;
  readonly frame: Record<string, unknown>;
}

export type RecordingState = 'idle' | 'recording' | 'recorded';
export type ReplayState = 'idle' | 'playing' | 'ended';

/**
 * How long a recording may be, in events.
 *
 * A pose frame is a few kilobytes, so this is a few hundred megabytes at worst and about twenty
 * minutes of four cameras at 30 fps. Beyond it the oldest events go, and the recording says so: a
 * recorder that stopped silently would leave the operator believing they had the take.
 */
const MAXIMUM_EVENTS = 150_000;

export class PoseReplay {
  private readonly host: PoseReplayHost;
  private configuration: Record<string, unknown> | undefined;
  private events: RecordedFrame[] = [];
  private dropped = 0;
  private recordingState: RecordingState = 'idle';
  private recordedFrames = 0;

  private spaceTime = new Map<string, Record<string, unknown>>();
  private session:
    | {
        configuration: Record<string, unknown>;
        frames: Map<string, RecordedFrame[]>;
        spaceTime: Map<string, Record<string, unknown>>;
      }
    | undefined;
  private sessionName = '';
  private replayState: ReplayState = 'idle';
  private replayStartedAtUs = 0;
  private originStartUs = 0;
  private durationUs = 0;
  private cursor = new Map<string, number>();
  private error = '';

  public constructor(host: PoseReplayHost) {
    this.host = host;
  }

  // Recording ---------------------------------------------------------------

  /**
   * Starts a recording, with the configuration the poses were estimated under.
   *
   * The configuration is what makes a recording replayable rather than merely readable: without the
   * cameras' models and placement, the 2D poses in it cannot be turned back into 3D.
   */
  public startRecording(configurationJson: string): void {
    const configuration = parseObject(configurationJson);
    if (!configuration) {
      this.error = '録画には、ポーズを推定したときの設定が要ります。';
      return;
    }
    this.configuration = configuration;
    this.events = [];
    this.spaceTime = new Map();
    this.dropped = 0;
    this.recordedFrames = 0;
    this.recordingState = 'recording';
    this.error = '';
  }

  /** Records one camera's pose frame, as it was, with the time it was recorded at. */
  public recordFrame(cameraId: string, frameJson: string): void {
    if (this.recordingState !== 'recording') return;
    const frame = parseObject(frameJson);
    if (!frame) return;
    const capture = Number(frame['captureTimestampUs']);
    if (!(capture > 0)) return;
    const last = this.events[this.events.length - 1];
    if (
      last?.cameraId === cameraId &&
      Number(last.frame['captureTimestampUs']) === capture
    )
      return;
    this.events.push({
      type: 'frame2d',
      atUs: this.host.pageTimeUs(),
      cameraId,
      frame,
    });
    this.recordedFrames += 1;
    if (this.events.length > MAXIMUM_EVENTS) {
      this.events.splice(0, this.events.length - MAXIMUM_EVENTS);
      this.dropped += 1;
    }
  }

  /**
   * Records one camera's space-time measurement: the camera model, the corner observation and the
   * time correspondence, exactly as the camera app sends them to the fusion app.
   */
  public recordSpaceTime(cameraId: string, payloadJson: string): void {
    const payload = parseObject(payloadJson);
    if (!payload) return;
    this.spaceTime.set(cameraId, payload);
  }

  public stopRecording(): void {
    if (this.recordingState !== 'recording') return;
    this.recordingState = this.events.length > 0 ? 'recorded' : 'idle';
  }

  public recordingStateName(): RecordingState {
    return this.recordingState;
  }

  /** The recording as a session document, or an empty string when nothing has been recorded. */
  public recordingJson(): string {
    if (!this.configuration || this.events.length === 0) return '';
    return JSON.stringify({
      schema: RECORDING_SCHEMA,
      version: RECORDING_VERSION,
      producer:
        this.dropped === 0
          ? 'debug-camera-replay'
          : `debug-camera-replay (${this.dropped} events dropped)`,
      configuration: this.configuration,
      ...(this.spaceTime.size === 0
        ? {}
        : {
            spaceTime: [...this.spaceTime.entries()].map(
              ([cameraId, payload]) => ({ cameraId, payload }),
            ),
          }),
      events: this.events,
    });
  }

  public recordingSummary(): string {
    if (this.recordingState === 'idle' && this.events.length === 0)
      return '録画していません。';
    const seconds = Math.round(this.spanUs() / 100_000) / 10;
    const cameras = new Set(this.events.map((event) => event.cameraId)).size;
    const state = this.recordingState === 'recording' ? '録画中' : '録画済み';
    const dropped =
      this.dropped === 0 ? '' : `（古い${this.dropped}件を捨てました）`;
    return `${state}: ${cameras}台 / ${this.recordedFrames}フレーム / ${seconds}秒${dropped}`;
  }

  // Files -------------------------------------------------------------------

  /**
   * Keeps the recording under a name.
   *
   * Written to the venue host when this page is served by one, so every application on the PC can
   * replay it; handed to the operator as a file when it is not.
   */
  public async save(name: string): Promise<void> {
    const text = this.recordingJson();
    if (text === '') {
      this.error = '保存できる録画がありません。';
      return;
    }
    const fileName = recordingFileName(name);
    if (!this.host.store.available()) {
      this.host.saveFile(fileName, text);
      this.error = '';
      return;
    }
    try {
      await this.host.store.write(fileName, text);
      this.error = '';
    } catch (error) {
      this.error = messageOf(error);
    }
  }

  public async listRecordings(): Promise<RecordingEntry[]> {
    if (!this.host.store.available()) return [];
    try {
      const entries = await this.host.store.list();
      this.error = '';
      return entries;
    } catch (error) {
      this.error = messageOf(error);
      return [];
    }
  }

  /** Loads a recording by name from the host, or from a file the operator chooses when unnamed. */
  public async load(name: string): Promise<void> {
    let text: string | null = null;
    try {
      text =
        name.trim() === '' || !this.host.store.available()
          ? await this.host.chooseFile()
          : await this.host.store.read(recordingFileName(name));
    } catch (error) {
      this.error = messageOf(error);
      return;
    }
    if (text === null) {
      this.error = '';
      return;
    }
    this.open(text, name.trim() === '' ? 'ファイル' : recordingFileName(name));
  }

  /** Takes a recording that is already in hand. Refuses anything it could not replay. */
  public open(text: string, name: string): void {
    const document = parseObject(text);
    if (
      !document ||
      document['schema'] !== RECORDING_SCHEMA ||
      document['version'] !== RECORDING_VERSION
    ) {
      this.error = `録画として読めません（${RECORDING_SCHEMA} v${RECORDING_VERSION}）。`;
      return;
    }
    const configuration = document['configuration'];
    const events = document['events'];
    if (
      typeof configuration !== 'object' ||
      configuration === null ||
      !Array.isArray(events)
    ) {
      this.error = '録画に設定またはイベントがありません。';
      return;
    }
    const frames = new Map<string, RecordedFrame[]>();
    for (const event of events) {
      if (typeof event !== 'object' || event === null) continue;
      const record = event as Record<string, unknown>;
      if (record['type'] !== 'frame2d') continue;
      const frame = record['frame'];
      const cameraId = record['cameraId'];
      if (
        typeof cameraId !== 'string' ||
        typeof frame !== 'object' ||
        frame === null
      )
        continue;
      const capture = Number(
        (frame as Record<string, unknown>)['captureTimestampUs'],
      );
      if (!(capture > 0)) continue;
      const list = frames.get(cameraId) ?? [];
      list.push({
        type: 'frame2d',
        atUs: Number(record['atUs']) || capture,
        cameraId,
        frame: frame as Record<string, unknown>,
      });
      frames.set(cameraId, list);
    }
    let earliest = Number.POSITIVE_INFINITY;
    let latest = 0;
    for (const list of frames.values()) {
      list.sort((left, right) => captureOf(left) - captureOf(right));
      earliest = Math.min(earliest, captureOf(list[0]!));
      latest = Math.max(latest, captureOf(list[list.length - 1]!));
    }
    if (frames.size === 0) {
      this.error = '録画にフレームがありません。';
      return;
    }
    const spaceTime = new Map<string, Record<string, unknown>>();
    for (const entry of Array.isArray(document['spaceTime'])
      ? document['spaceTime']
      : []) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const cameraId = record['cameraId'];
      const payload = record['payload'];
      if (
        typeof cameraId !== 'string' ||
        typeof payload !== 'object' ||
        payload === null
      ) {
        continue;
      }
      spaceTime.set(cameraId, payload as Record<string, unknown>);
    }
    this.session = {
      configuration: configuration as Record<string, unknown>,
      frames,
      spaceTime,
    };
    this.sessionName = name;
    this.originStartUs = earliest;
    this.durationUs = Math.max(0, latest - earliest);
    this.replayState = 'idle';
    this.cursor = new Map();
    this.error = '';
  }

  // Replay ------------------------------------------------------------------

  /**
   * Starts replaying, from the beginning.
   *
   * Frames are re-stamped onto the present as they are handed out: the consumers judge how old a
   * frame is against the page clock, and a recording from yesterday would be stale on arrival. The
   * spacing between frames, which is what the alignment depends on, is kept exactly.
   */
  public startReplay(): void {
    if (!this.session) {
      this.error = '再生する録画が読み込まれていません。';
      return;
    }
    this.replayStartedAtUs = this.host.pageTimeUs();
    this.replayState = 'playing';
    this.cursor = new Map();
    this.error = '';
  }

  public stopReplay(): void {
    if (this.replayState === 'playing') this.replayState = 'ended';
  }

  /**
   * The newest frame of that camera whose moment has come, re-stamped onto the page clock, or an
   * empty string when the camera has none yet. A frame already handed out is not handed out again.
   */
  public frameFor(cameraId: string): string {
    const session = this.session;
    if (!session || this.replayState !== 'playing') return '';
    const list = session.frames.get(cameraId);
    if (!list || list.length === 0) return '';
    const elapsed = this.host.pageTimeUs() - this.replayStartedAtUs;
    if (elapsed > this.durationUs) {
      this.replayState = 'ended';
      return '';
    }
    let index = this.cursor.get(cameraId) ?? 0;
    let chosen: RecordedFrame | undefined;
    while (
      index < list.length &&
      captureOf(list[index]!) - this.originStartUs <= elapsed
    ) {
      chosen = list[index];
      index += 1;
    }
    this.cursor.set(cameraId, index);
    if (!chosen) return '';
    return JSON.stringify({
      ...chosen.frame,
      captureTimestampUs:
        this.replayStartedAtUs + (captureOf(chosen) - this.originStartUs),
    });
  }

  public replayStateName(): ReplayState {
    // A replay that has run past the end reports it without waiting to be asked for a frame.
    if (
      this.replayState === 'playing' &&
      this.host.pageTimeUs() - this.replayStartedAtUs > this.durationUs
    ) {
      this.replayState = 'ended';
    }
    return this.replayState;
  }

  public replayPositionMs(): number {
    if (this.replayState === 'idle') return 0;
    const elapsed = (this.host.pageTimeUs() - this.replayStartedAtUs) / 1000;
    return Math.round(Math.min(Math.max(elapsed, 0), this.durationUs / 1000));
  }

  public replayDurationMs(): number {
    return Math.round(this.durationUs / 1000);
  }

  /** The configuration the recording was made under, for configuring the 3D service the same way. */
  public loadedConfigurationJson(): string {
    return this.session ? JSON.stringify(this.session.configuration) : '';
  }

  /**
   * The space-time measurement the recording carries for that camera, or an empty string.
   *
   * A camera app replaying a recording answers the fusion app's calibration request with this, which
   * is what lets the placement be solved with no pattern on the wall and no camera looking at it. A
   * recording of a single camera answers for whichever name it is asked about, because a camera app
   * calls its camera `pose` while the recording may have been made under another name.
   */
  public spaceTimePayloadJson(cameraId: string): string {
    const session = this.session;
    if (!session) return '';
    const payload =
      session.spaceTime.get(cameraId) ??
      (session.spaceTime.size === 1
        ? [...session.spaceTime.values()][0]
        : undefined);
    return payload ? JSON.stringify(payload) : '';
  }

  public loadedCamerasJson(): string {
    return JSON.stringify(
      this.session ? [...this.session.frames.keys()].sort() : [],
    );
  }

  public loadedSummary(): string {
    if (!this.session) return '録画を読み込んでいません。';
    const cameras = [...this.session.frames.keys()].sort().join(', ');
    const frames = [...this.session.frames.values()].reduce(
      (total, list) => total + list.length,
      0,
    );
    return `${this.sessionName}: ${cameras}（${frames}フレーム / ${Math.round(this.durationUs / 100_000) / 10}秒）`;
  }

  public errorMessage(): string {
    return this.error;
  }

  private spanUs(): number {
    if (this.events.length === 0) return 0;
    const first = captureOf(this.events[0]!);
    const last = captureOf(this.events[this.events.length - 1]!);
    return Math.max(0, last - first);
  }
}

function captureOf(event: RecordedFrame): number {
  return Number(event.frame['captureTimestampUs']) || 0;
}

/** A name the venue host will accept, from whatever the operator typed. */
export function recordingFileName(name: string): string {
  const trimmed = name.trim().replace(/\.json$/iu, '');
  const safe = trimmed
    .replace(/[^A-Za-z0-9._-]/gu, '-')
    .replace(/^[^A-Za-z0-9]+/u, '')
    .slice(0, 59);
  return `${safe === '' ? 'recording' : safe}.json`;
}

function parseObject(text: string): Record<string, unknown> | undefined {
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The venue host's recording store, reached through this page's own origin with the token it was
 * opened with. A page served any other way reports that it has no store, and the operator handles
 * files themselves.
 */
export function createBrowserRecordingStore(): RecordingStorePort {
  const url = (name?: string): string => {
    const target = new URL(recordingsRoute, location.href);
    const token = new URLSearchParams(location.search).get('token');
    if (token !== null) target.searchParams.set('token', token);
    if (name !== undefined) target.searchParams.set('name', name);
    return target.href;
  };
  const available = () =>
    typeof location !== 'undefined' &&
    (location.protocol === 'http:' || location.protocol === 'https:');
  return {
    available,
    async list() {
      const response = await fetch(url(), { cache: 'no-store' });
      if (!response.ok)
        throw new Error(`録画の一覧を読めません（${response.status}）。`);
      const body = (await response.json()) as { recordings?: RecordingEntry[] };
      return body.recordings ?? [];
    },
    async read(name) {
      const response = await fetch(url(name), { cache: 'no-store' });
      if (!response.ok)
        throw new Error(`録画 ${name} を読めません（${response.status}）。`);
      return await response.text();
    },
    async write(name, text) {
      const response = await fetch(url(name), { method: 'PUT', body: text });
      if (!response.ok)
        throw new Error(
          `録画 ${name} を保存できません（${response.status}）。`,
        );
    },
  };
}

/** Hands the operator a file, for a page with no host to keep it on. */
export function saveTextFileInBrowser(name: string, text: string): void {
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(
    new Blob([text], { type: 'application/json' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next turn of the event loop: revoking it immediately can cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

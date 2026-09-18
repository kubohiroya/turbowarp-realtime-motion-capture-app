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
 * The format is `twrmc/pose-3d-session`, the same one the 3D service's evaluation tool replays, so a
 * recording taken at a venue can be measured offline without being converted first. Version 2 is one
 * JSON object per line: a header, then the frames and measurements in the order they happened. That
 * is what lets a take be written while it is being taken — the page holds a few lines rather than the
 * whole session, and a recording interrupted by a crash or a closed lid keeps the part that was
 * taken. The host writes it into a compression stream as it arrives, so the disk holds about a third
 * of the raw size from the first frame on, and finishing a take is a rename.
 *
 * Version 1 — a single JSON document — is still read, so recordings taken before this still replay.
 */

export const RECORDING_SCHEMA = 'twrmc/pose-3d-session';
export const RECORDING_VERSION = 2;
/** The single-document format this one grew out of. Read, never written. */
export const LEGACY_RECORDING_VERSION = 1;
/** Lines are sent in batches: one request per frame would spend the take talking to the host. */
const FLUSH_LINES = 32;
const FLUSH_BYTES = 32 * 1024;
/** Kept equal to `recordingsPath` in `packages/local-host/src/recordings.ts`. */
export const recordingsRoute = '/recordings';

export interface RecordingEntry {
  readonly name: string;
  readonly bytes: number;
  readonly modifiedAt: string;
}

/**
 * Somewhere a recording can be read from, from its first line, as often as asked.
 *
 * A recording is read as a stream, never as one string: a long take is hundreds of megabytes of
 * lines, and replaying it holds only the few seconds ahead of the replay. Loading reads it once to
 * learn its shape; replaying reads it again, a window at a time.
 */
export interface RecordingSource {
  /** A fresh stream of the recording's text, unpacked when it is stored compressed. */
  open(): Promise<ReadableStream<string>>;
}

/** Where recordings live, when a venue host serves them. */
export interface RecordingStorePort {
  /** Whether this page is served beside a host that keeps recordings. */
  available(): boolean;
  list(): Promise<RecordingEntry[]>;
  source(name: string): RecordingSource;
  write(name: string, text: string): Promise<void>;
  /** Opens a recording with its header line, replacing anything under that name. */
  start(name: string, line: string): Promise<void>;
  /** Adds lines to a recording that is being taken. */
  append(name: string, lines: string): Promise<void>;
  /** Closes the take's compression stream and gives it its final name. */
  finish(name: string, to: string): Promise<void>;
}

export interface PoseReplayHost {
  /** Microseconds since the Unix epoch on this page's clock, the domain capture times are in. */
  pageTimeUs(): number;
  store: RecordingStorePort;
  /** Asks the operator for a recording file. Resolves to it, or null when they gave up. */
  chooseFile(): Promise<RecordingSource | null>;
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
 * How long a recording may be, in events, when it is held in the page.
 *
 * Only a page with no host to write to holds one: there the recording lives in memory until the
 * operator saves it, so it has to stop growing somewhere. Beyond this the oldest events go, and the
 * recording says so — a recorder that stopped silently would leave the operator believing they had
 * the take. Where a host serves the page, the recording is written as it is taken and this does not
 * apply; the host's own size limit does.
 */
const MAXIMUM_EVENTS = 150_000;

/**
 * How far ahead of the replay the recording is read.
 *
 * Enough that a frame is in hand before its moment, whatever the page was doing, and small enough
 * that a take of any length costs the page a few seconds of frames: at four cameras and twelve frames
 * a second this is about a hundred and fifty frames, half a megabyte.
 */
const LOOKAHEAD_US = 3_000_000;

export class PoseReplay {
  private readonly host: PoseReplayHost;
  private configuration: Record<string, unknown> | undefined;
  private events: RecordedFrame[] = [];
  private dropped = 0;
  private recordingState: RecordingState = 'idle';
  private recordedFrames = 0;

  private spaceTime = new Map<string, Record<string, unknown>>();
  private maxSeconds = 0;
  private fps = 0;
  private lastCaptureUs = new Map<string, number>();
  private firstCaptureUs = 0;
  private latestCaptureUs = 0;
  private thinned = 0;
  private cameras = new Set<string>();
  /** The file the take is being written to, or an empty string when it is held in the page. */
  private workingName = '';
  private pendingLines: string[] = [];
  private pendingBytes = 0;
  /** Writes are chained rather than raced: the lines have to reach the file in the order taken. */
  private writing: Promise<void> = Promise.resolve();
  /**
   * The recording loaded for replay: what it is, not what is in it. Its frames stay in the file and
   * are read a window at a time — except a v1 document's, which is one JSON value and is held whole.
   */
  private loaded:
    | {
        source: RecordingSource;
        configuration: Record<string, unknown>;
        spaceTime: Map<string, Record<string, unknown>>;
        frameCounts: Map<string, number>;
        held: Map<string, RecordedFrame[]> | undefined;
      }
    | undefined;
  private sessionName = '';
  private replayState: ReplayState = 'idle';
  private replayStartedAtUs = 0;
  private originStartUs = 0;
  private durationUs = 0;
  /** Bumped on every start and stop, so a read still in flight from an earlier run leaves nothing. */
  private replayRun = 0;
  private reader: ReadableStreamDefaultReader<string> | undefined;
  private reading = false;
  private readerDone = false;
  private carry = '';
  /** Frames read and not yet handed out, per camera, in the order read. */
  private queues = new Map<string, RecordedFrame[]>();
  /** The latest capture time read so far, which is how far ahead of the replay the window reaches. */
  private readThroughUs = 0;
  private error = '';

  public constructor(host: PoseReplayHost) {
    this.host = host;
  }

  // Recording ---------------------------------------------------------------

  /**
   * Starts a recording, with the configuration the poses were estimated under.
   *
   * The configuration is what makes a recording replayable rather than merely readable: without the
   * cameras' models and placement, the 2D poses in it cannot be turned back into 3D. It is written
   * first, as the header line, so a take interrupted half way is still a recording.
   *
   * Where a host serves this page the take is written to it as it happens, under a working name; the
   * operator names it when they save it, and the host compresses it then. Where no host serves the
   * page, the take is held here until it is saved.
   */
  public startRecording(
    configurationJson: string,
    options: { maxSeconds?: number; fps?: number } = {},
  ): void {
    const configuration = parseObject(configurationJson);
    if (!configuration) {
      this.error = '録画には、ポーズを推定したときの設定が要ります。';
      return;
    }
    this.configuration = configuration;
    this.events = [];
    this.spaceTime = new Map();
    this.dropped = 0;
    this.thinned = 0;
    this.recordedFrames = 0;
    this.cameras = new Set();
    this.lastCaptureUs = new Map();
    this.firstCaptureUs = 0;
    this.latestCaptureUs = 0;
    this.maxSeconds = positive(options.maxSeconds);
    this.fps = positive(options.fps);
    this.pendingLines = [];
    this.pendingBytes = 0;
    this.workingName = '';
    this.recordingState = 'recording';
    this.error = '';
    if (!this.host.store.available()) return;
    const working = workingFileName(this.host.pageTimeUs());
    this.workingName = working;
    const header = `${JSON.stringify({
      type: 'header',
      schema: RECORDING_SCHEMA,
      version: RECORDING_VERSION,
      producer: 'debug-pose-replay',
      configuration,
    })}\n`;
    this.enqueue(() => this.host.store.start(working, header));
  }

  /**
   * Records one camera's pose frame, as it was, with the time it was recorded at.
   *
   * The two limits are the operator's, and both are judged on the frames' own capture times rather
   * than on the wall clock: a take is as long as the movement in it, whatever the page was doing.
   *
   * - A frame rate keeps at most that many frames a second per camera, dropping the ones in between.
   *   A recording is replayed at the rate it was taken at, so this is how a long take is made small
   *   enough to keep and to replay on a slower machine.
   * - A length stops the recording once that much movement has been recorded, so a take can be
   *   started and left to finish itself.
   */
  public recordFrame(cameraId: string, frameJson: string): void {
    if (this.recordingState !== 'recording') return;
    const frame = parseObject(frameJson);
    if (!frame) return;
    const capture = Number(frame['captureTimestampUs']);
    if (!(capture > 0)) return;
    if (this.firstCaptureUs === 0) this.firstCaptureUs = capture;
    if (
      this.maxSeconds > 0 &&
      capture - this.firstCaptureUs >= this.maxSeconds * 1_000_000
    ) {
      this.stopRecording();
      return;
    }
    const previous = this.lastCaptureUs.get(cameraId);
    // The same frame offered twice is the camera's newest one, asked for again, not new movement.
    if (previous === capture) return;
    if (this.fps > 0) {
      // A tenth of a period of slack, so a camera delivering exactly at the asked rate is not halved
      // by a frame that arrives a fraction early, while a faster camera is still thinned to the rate.
      if (
        previous !== undefined &&
        capture - previous < (1_000_000 / this.fps) * 0.9
      ) {
        this.thinned += 1;
        return;
      }
    }
    this.lastCaptureUs.set(cameraId, capture);
    this.latestCaptureUs = Math.max(this.latestCaptureUs, capture);
    this.cameras.add(cameraId);
    this.recordedFrames += 1;
    this.write({
      type: 'frame2d',
      atUs: this.host.pageTimeUs(),
      cameraId,
      frame,
    });
  }

  /**
   * Records one camera's space-time measurement: the camera model, the corner observation and the
   * time correspondence, exactly as the camera app sends them to the fusion app.
   */
  public recordSpaceTime(cameraId: string, payloadJson: string): void {
    const payload = parseObject(payloadJson);
    if (!payload) return;
    this.spaceTime.set(cameraId, payload);
    if (this.recordingState !== 'recording' || this.workingName === '') return;
    this.line(JSON.stringify({ type: 'spaceTime', cameraId, payload }));
  }

  public stopRecording(): void {
    if (this.recordingState !== 'recording') return;
    this.flush();
    this.recordingState = this.recordedFrames > 0 ? 'recorded' : 'idle';
  }

  public recordingStateName(): RecordingState {
    return this.recordingState;
  }

  /**
   * The recording as session lines, or an empty string when it is being written to the host instead.
   *
   * Only a page holding its own take has anything to give here; where a host is writing the lines,
   * the file on the host is the recording.
   */
  public recordingText(): string {
    if (!this.configuration || this.events.length === 0) return '';
    const lines = [
      JSON.stringify({
        type: 'header',
        schema: RECORDING_SCHEMA,
        version: RECORDING_VERSION,
        producer:
          this.dropped === 0
            ? 'debug-pose-replay'
            : `debug-pose-replay (${this.dropped} events dropped)`,
        configuration: this.configuration,
      }),
      ...[...this.spaceTime.entries()].map(([cameraId, payload]) =>
        JSON.stringify({ type: 'spaceTime', cameraId, payload }),
      ),
      ...this.events.map((event) => JSON.stringify(event)),
    ];
    return `${lines.join('\n')}\n`;
  }

  public recordingSummary(): string {
    if (this.recordingState === 'idle' && this.recordedFrames === 0)
      return '録画していません。';
    const seconds = Math.round(this.spanUs() / 100_000) / 10;
    const state = this.recordingState === 'recording' ? '録画中' : '録画済み';
    const asked = [
      this.maxSeconds > 0 ? `${this.maxSeconds}秒まで` : '',
      this.fps > 0 ? `${this.fps}fpsまで` : '',
    ].filter((part) => part !== '');
    const limits = asked.length === 0 ? '' : `（指定: ${asked.join(' / ')}）`;
    const thinned = this.thinned === 0 ? '' : `（間引き${this.thinned}件）`;
    const dropped =
      this.dropped === 0 ? '' : `（古い${this.dropped}件を捨てました）`;
    return `${state}: ${this.cameras.size}台 / ${this.recordedFrames}フレーム / ${seconds}秒${limits}${thinned}${dropped}`;
  }

  // Files -------------------------------------------------------------------

  /**
   * Keeps the recording under a name.
   *
   * A take written to the venue host is compressed there under this name, so every application on
   * the PC can replay it. A take held in the page is handed to the operator as a file.
   */
  public async save(name: string): Promise<void> {
    if (this.workingName !== '') {
      if (this.recordedFrames === 0) {
        this.error = '保存できる録画がありません。';
        return;
      }
      const working = this.workingName;
      const target = recordingFileName(name);
      this.flush();
      this.enqueue(() => this.host.store.finish(working, target));
      await this.settled();
      if (this.error === '') this.workingName = '';
      return;
    }
    const text = this.recordingText();
    if (text === '') {
      this.error = '保存できる録画がありません。';
      return;
    }
    // Held in the page, so it is handed over uncompressed: compressing is the host's part.
    const fileName = recordingFileName(name).replace(/\.gz$/u, '');
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
    let source: RecordingSource | null;
    try {
      source =
        name.trim() === '' || !this.host.store.available()
          ? await this.host.chooseFile()
          : this.host.store.source(recordingFileName(name));
    } catch (error) {
      this.error = messageOf(error);
      return;
    }
    if (source === null) {
      this.error = '';
      return;
    }
    await this.openSource(
      source,
      name.trim() === '' ? 'ファイル' : recordingFileName(name),
    );
  }

  /** Takes a recording that is already in hand as text, in either format. */
  public async open(text: string, name: string): Promise<void> {
    await this.openSource(textSource(text), name);
  }

  /**
   * Learns what a recording holds by reading it once, keeping none of its frames.
   *
   * What replay needs before it starts — the configuration, the measurements, which cameras there
   * are and how long it runs — is gathered as the lines go past; the frames themselves are read
   * again, a window at a time, while it plays. A line that cannot be read is skipped rather than
   * refused, and a stream that breaks off ends the recording there: a take interrupted mid-line is a
   * recording of everything before that line, which is exactly what it is for.
   *
   * A v1 recording is one JSON document, which cannot be read a line at a time, so it is read whole
   * and its frames are held. Those were small by construction.
   */
  private async openSource(
    source: RecordingSource,
    name: string,
  ): Promise<void> {
    this.stopReading();
    let header: Record<string, unknown> | undefined;
    let legacyText: string | undefined;
    const spaceTime = new Map<string, Record<string, unknown>>();
    const frameCounts = new Map<string, number>();
    let earliest = Number.POSITIVE_INFINITY;
    let latest = 0;
    let firstLine = true;

    const take = (line: string) => {
      if (line.trim() === '') return;
      const record = parseObject(line);
      if (!record) return;
      if (record['type'] === 'spaceTime') {
        takeSpaceTime(record, spaceTime);
        return;
      }
      const frame = frameOf(record);
      if (!frame) return;
      const capture = captureOf(frame);
      frameCounts.set(
        frame.cameraId,
        (frameCounts.get(frame.cameraId) ?? 0) + 1,
      );
      earliest = Math.min(earliest, capture);
      latest = Math.max(latest, capture);
    };

    try {
      await readLines(source, (line) => {
        if (legacyText !== undefined) {
          legacyText += `${line}\n`;
          return;
        }
        if (firstLine) {
          firstLine = false;
          const first = parseObject(line);
          if (first?.['type'] === 'header') {
            header = first;
            return;
          }
          legacyText = `${line}\n`;
          return;
        }
        take(line);
      });
    } catch (error) {
      if (header === undefined && legacyText === undefined) {
        this.error = messageOf(error);
        return;
      }
      // A stream that broke off after the recording began is the end of the recording.
    }

    if (legacyText !== undefined) {
      this.openDocument(legacyText, name, source);
      return;
    }
    if (
      header === undefined ||
      header['schema'] !== RECORDING_SCHEMA ||
      header['version'] !== RECORDING_VERSION
    ) {
      this.error = `録画として読めません（${RECORDING_SCHEMA} v${RECORDING_VERSION}）。`;
      return;
    }
    const configuration = header['configuration'];
    if (typeof configuration !== 'object' || configuration === null) {
      this.error = '録画に設定がありません。';
      return;
    }
    if (frameCounts.size === 0) {
      this.error = '録画にフレームがありません。';
      return;
    }
    this.adopt({
      source,
      configuration: configuration as Record<string, unknown>,
      spaceTime,
      frameCounts,
      held: undefined,
      earliest,
      latest,
      name,
    });
  }

  private openDocument(
    text: string,
    name: string,
    source: RecordingSource,
  ): void {
    const document = parseObject(text);
    if (
      !document ||
      document['schema'] !== RECORDING_SCHEMA ||
      document['version'] !== LEGACY_RECORDING_VERSION
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
    const held = new Map<string, RecordedFrame[]>();
    for (const event of events) {
      if (typeof event !== 'object' || event === null) continue;
      const frame = frameOf(event as Record<string, unknown>);
      if (!frame) continue;
      const list = held.get(frame.cameraId) ?? [];
      list.push(frame);
      held.set(frame.cameraId, list);
    }
    const spaceTime = new Map<string, Record<string, unknown>>();
    for (const entry of Array.isArray(document['spaceTime'])
      ? document['spaceTime']
      : []) {
      if (typeof entry !== 'object' || entry === null) continue;
      takeSpaceTime(entry as Record<string, unknown>, spaceTime);
    }
    if (held.size === 0) {
      this.error = '録画にフレームがありません。';
      return;
    }
    let earliest = Number.POSITIVE_INFINITY;
    let latest = 0;
    const frameCounts = new Map<string, number>();
    for (const [cameraId, list] of held) {
      list.sort((left, right) => captureOf(left) - captureOf(right));
      earliest = Math.min(earliest, captureOf(list[0]!));
      latest = Math.max(latest, captureOf(list[list.length - 1]!));
      frameCounts.set(cameraId, list.length);
    }
    this.adopt({
      source,
      configuration: configuration as Record<string, unknown>,
      spaceTime,
      frameCounts,
      held,
      earliest,
      latest,
      name,
    });
  }

  private adopt(recording: {
    source: RecordingSource;
    configuration: Record<string, unknown>;
    spaceTime: Map<string, Record<string, unknown>>;
    frameCounts: Map<string, number>;
    held: Map<string, RecordedFrame[]> | undefined;
    earliest: number;
    latest: number;
    name: string;
  }): void {
    this.loaded = {
      source: recording.source,
      configuration: recording.configuration,
      spaceTime: recording.spaceTime,
      frameCounts: recording.frameCounts,
      held: recording.held,
    };
    this.sessionName = recording.name;
    this.originStartUs = recording.earliest;
    this.durationUs = Math.max(0, recording.latest - recording.earliest);
    this.replayState = 'idle';
    this.queues = new Map();
    this.error = '';
  }

  // Writing -----------------------------------------------------------------

  /** Keeps the event: sent to the host as it is taken, or held here when there is no host. */
  private write(event: RecordedFrame): void {
    if (this.workingName !== '') {
      this.line(JSON.stringify(event));
      return;
    }
    this.events.push(event);
    if (this.events.length > MAXIMUM_EVENTS) {
      this.events.splice(0, this.events.length - MAXIMUM_EVENTS);
      this.dropped += 1;
    }
  }

  private line(line: string): void {
    this.pendingLines.push(line);
    this.pendingBytes += line.length + 1;
    if (
      this.pendingLines.length >= FLUSH_LINES ||
      this.pendingBytes >= FLUSH_BYTES
    ) {
      this.flush();
    }
  }

  private flush(): void {
    if (this.pendingLines.length === 0 || this.workingName === '') return;
    const body = `${this.pendingLines.join('\n')}\n`;
    const working = this.workingName;
    this.pendingLines = [];
    this.pendingBytes = 0;
    this.enqueue(() => this.host.store.append(working, body));
  }

  /**
   * Runs the writes one after another, and stops the take on the first one that fails.
   *
   * A recording that cannot be written is not a recording, and carrying on would leave the operator
   * watching a counter rise over a file that is missing the middle of the take.
   */
  private enqueue(write: () => Promise<void>): void {
    this.writing = this.writing.then(async () => {
      if (this.error !== '' && this.workingName === '') return;
      try {
        await write();
      } catch (error) {
        this.error = messageOf(error);
        this.pendingLines = [];
        this.pendingBytes = 0;
        if (this.recordingState === 'recording') {
          this.recordingState = this.recordedFrames > 0 ? 'recorded' : 'idle';
        }
      }
    });
  }

  /** Waits for the writes in flight, for the steps that need the file to be complete. */
  private async settled(): Promise<void> {
    await this.writing;
  }

  // Replay ------------------------------------------------------------------

  /**
   * Starts replaying, from the beginning.
   *
   * Frames are re-stamped onto the present as they are handed out: the consumers judge how old a
   * frame is against the page clock, and a recording from yesterday would be stale on arrival. The
   * spacing between frames, which is what the alignment depends on, is kept exactly.
   *
   * The recording is read again from its first line, a few seconds ahead of the replay at a time, so
   * a take of any length costs the page only the frames about to be played.
   */
  public startReplay(): void {
    const loaded = this.loaded;
    if (!loaded) {
      this.error = '再生する録画が読み込まれていません。';
      return;
    }
    this.stopReading();
    this.replayStartedAtUs = this.host.pageTimeUs();
    this.replayState = 'playing';
    this.error = '';
    if (loaded.held) {
      this.queues = new Map(
        [...loaded.held].map(([cameraId, list]) => [cameraId, [...list]]),
      );
      this.readerDone = true;
      return;
    }
    this.readAhead();
  }

  public stopReplay(): void {
    if (this.replayState === 'playing') this.replayState = 'ended';
    this.stopReading();
  }

  /**
   * The newest frame of that camera whose moment has come, re-stamped onto the page clock, or an
   * empty string when the camera has none yet. A frame already handed out is not handed out again.
   *
   * Asking also keeps the window full: when what has been read runs short of a few seconds ahead,
   * the next part of the recording is read in the background. If the reading falls behind — a page
   * that stalled, a disk that did — the camera simply has nothing new for a moment, as a real camera
   * would, rather than the replay stopping to wait.
   */
  public frameFor(cameraId: string): string {
    if (!this.loaded || this.replayState !== 'playing') return '';
    const elapsed = this.host.pageTimeUs() - this.replayStartedAtUs;
    if (elapsed > this.durationUs) {
      this.replayState = 'ended';
      this.stopReading();
      return '';
    }
    this.readAhead();
    const queue = this.queues.get(cameraId);
    if (!queue || queue.length === 0) return '';
    let chosen: RecordedFrame | undefined;
    while (
      queue.length > 0 &&
      captureOf(queue[0]!) - this.originStartUs <= elapsed
    ) {
      const due = queue.shift()!;
      if (!chosen || captureOf(due) >= captureOf(chosen)) chosen = due;
    }
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
      this.stopReading();
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

  /** How many frames are read and waiting, across the cameras. What the window costs, as a count. */
  public bufferedFrameCount(): number {
    let count = 0;
    for (const queue of this.queues.values()) count += queue.length;
    return count;
  }

  /** The configuration the recording was made under, for configuring the 3D service the same way. */
  public loadedConfigurationJson(): string {
    return this.loaded ? JSON.stringify(this.loaded.configuration) : '';
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
    const loaded = this.loaded;
    if (!loaded) return '';
    const payload =
      loaded.spaceTime.get(cameraId) ??
      (loaded.spaceTime.size === 1
        ? [...loaded.spaceTime.values()][0]
        : undefined);
    return payload ? JSON.stringify(payload) : '';
  }

  public loadedCamerasJson(): string {
    return JSON.stringify(
      this.loaded ? [...this.loaded.frameCounts.keys()].sort() : [],
    );
  }

  public loadedSummary(): string {
    if (!this.loaded) return '録画を読み込んでいません。';
    const cameras = [...this.loaded.frameCounts.keys()].sort().join(', ');
    const frames = [...this.loaded.frameCounts.values()].reduce(
      (total, count) => total + count,
      0,
    );
    return `${this.sessionName}: ${cameras}（${frames}フレーム / ${Math.round(this.durationUs / 100_000) / 10}秒）`;
  }

  /**
   * Reads on until the window reaches a few seconds past the replay, then stops until asked again.
   *
   * One read at a time, and each belongs to the run that started it: a read that finishes after the
   * replay was stopped or restarted leaves its lines unused.
   */
  private readAhead(): void {
    const loaded = this.loaded;
    if (
      !loaded ||
      loaded.held ||
      this.reading ||
      this.readerDone ||
      this.replayState !== 'playing'
    ) {
      return;
    }
    if (this.windowIsFull()) return;
    this.reading = true;
    const run = this.replayRun;
    void (async () => {
      try {
        this.reader ??= (await loaded.source.open()).getReader();
        while (run === this.replayRun && !this.windowIsFull()) {
          const { value, done } = await this.reader.read();
          if (run !== this.replayRun) return;
          if (done) {
            this.takeReplayLine(this.carry);
            this.carry = '';
            this.readerDone = true;
            return;
          }
          const lines = `${this.carry}${value}`.split('\n');
          this.carry = lines.pop() ?? '';
          for (const line of lines) this.takeReplayLine(line);
        }
      } catch {
        // The recording breaks off here, as a take cut short does. What was read still plays.
        if (run === this.replayRun) this.readerDone = true;
      } finally {
        if (run === this.replayRun) this.reading = false;
      }
    })();
  }

  private windowIsFull(): boolean {
    const elapsed = this.host.pageTimeUs() - this.replayStartedAtUs;
    return this.readThroughUs - this.originStartUs >= elapsed + LOOKAHEAD_US;
  }

  private takeReplayLine(line: string): void {
    if (line.trim() === '') return;
    const record = parseObject(line);
    if (!record) return;
    const frame = frameOf(record);
    if (!frame) return;
    const queue = this.queues.get(frame.cameraId) ?? [];
    queue.push(frame);
    this.queues.set(frame.cameraId, queue);
    this.readThroughUs = Math.max(this.readThroughUs, captureOf(frame));
  }

  /** Lets go of the recording being read, and of everything read ahead. */
  private stopReading(): void {
    this.replayRun += 1;
    const reader = this.reader;
    this.reader = undefined;
    if (reader) void reader.cancel().catch(() => undefined);
    this.reading = false;
    this.readerDone = false;
    this.carry = '';
    this.queues = new Map();
    this.readThroughUs = 0;
  }

  public errorMessage(): string {
    return this.error;
  }

  private spanUs(): number {
    if (this.firstCaptureUs === 0 || this.latestCaptureUs === 0) return 0;
    return Math.max(0, this.latestCaptureUs - this.firstCaptureUs);
  }
}

function captureOf(event: RecordedFrame): number {
  return Number(event.frame['captureTimestampUs']) || 0;
}

/** A frame line or v1 event as a frame to replay, or nothing when it is not one. */
function frameOf(record: Record<string, unknown>): RecordedFrame | undefined {
  if (record['type'] !== 'frame2d') return undefined;
  const frame = record['frame'];
  const cameraId = record['cameraId'];
  if (
    typeof cameraId !== 'string' ||
    typeof frame !== 'object' ||
    frame === null
  )
    return undefined;
  const capture = Number(
    (frame as Record<string, unknown>)['captureTimestampUs'],
  );
  if (!(capture > 0)) return undefined;
  return {
    type: 'frame2d',
    atUs: Number(record['atUs']) || capture,
    cameraId,
    frame: frame as Record<string, unknown>,
  };
}

function takeSpaceTime(
  record: Record<string, unknown>,
  into: Map<string, Record<string, unknown>>,
): void {
  const cameraId = record['cameraId'];
  const payload = record['payload'];
  if (
    typeof cameraId !== 'string' ||
    typeof payload !== 'object' ||
    payload === null
  ) {
    return;
  }
  into.set(cameraId, payload as Record<string, unknown>);
}

/**
 * Hands each line of a recording to `onLine`, as the stream delivers them.
 *
 * A line split across two chunks is joined first. A stream that fails part way throws after the
 * lines before the failure have been handed over, and the broken line is not: the caller decides
 * whether that is the end of the recording or a recording that could not be read.
 */
export async function readLines(
  source: RecordingSource,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = (await source.open()).getReader();
  let carry = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const lines = `${carry}${value}`.split('\n');
    carry = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  }
  if (carry !== '') onLine(carry);
}

/** A recording already in hand, handed out in pieces as a file or the network would. */
export function textSource(text: string, chunk = 64 * 1024): RecordingSource {
  return {
    async open() {
      let offset = 0;
      return new ReadableStream<string>({
        pull(controller) {
          if (offset >= text.length) {
            controller.close();
            return;
          }
          controller.enqueue(text.slice(offset, offset + chunk));
          offset += chunk;
        },
      });
    },
  };
}

/** Bytes as text, unpacked first when they are stored compressed. */
function decodeRecording(
  bytes: ReadableStream<Uint8Array>,
  compressed: boolean,
): ReadableStream<string> {
  const unpacked = compressed
    ? bytes.pipeThrough(
        new DecompressionStream('gzip') as unknown as ReadableWritablePair<
          Uint8Array,
          Uint8Array
        >,
      )
    : bytes;
  return unpacked.pipeThrough(
    new TextDecoderStream() as unknown as ReadableWritablePair<
      string,
      Uint8Array
    >,
  );
}

/**
 * A name the venue host will accept, from whatever the operator typed.
 *
 * A name that already carries one of the recording extensions keeps it — that is how a name picked
 * from the host's own list is read back. Anything else becomes a finished recording's name.
 */
export function recordingFileName(name: string): string {
  const trimmed = name.trim();
  const known = /\.(?:json|jsonl|jsonl\.gz)$/iu.exec(trimmed);
  const extension = known === null ? '.jsonl.gz' : known[0].toLowerCase();
  const safe = trimmed
    .slice(0, trimmed.length - (known?.[0].length ?? 0))
    .replace(/[^A-Za-z0-9._-]/gu, '-')
    .replace(/^[^A-Za-z0-9]+/u, '')
    .slice(0, 64 - extension.length);
  return `${safe === '' ? 'recording' : safe}${extension}`;
}

/**
 * The name a take is written under while it runs.
 *
 * It carries the time it started, so two takes never collide and an interrupted one can be found
 * afterwards by when it was taken.
 */
export function workingFileName(pageTimeUs: number): string {
  const stamp = new Date(Math.round(pageTimeUs / 1000))
    .toISOString()
    .replace(/[:.]/gu, '-')
    .replace(/Z$/u, '');
  return `taking-${stamp}.jsonl.gz`;
}

/** A limit the operator left out, or typed as zero or nonsense, is no limit. */
function positive(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/** The first line of a recording, when it has one that reads as an object. */
function firstObject(text: string): Record<string, unknown> | undefined {
  const first = text.split('\n', 1)[0] ?? '';
  return parseObject(first);
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
    source(name) {
      return {
        async open() {
          const response = await fetch(url(name), { cache: 'no-store' });
          if (!response.ok || response.body === null)
            throw new Error(
              `録画 ${name} を読めません（${response.status}）。`,
            );
          return decodeRecording(response.body, name.endsWith('.gz'));
        },
      };
    },
    async write(name, text) {
      const response = await fetch(url(name), { method: 'PUT', body: text });
      if (!response.ok)
        throw new Error(
          `録画 ${name} を保存できません（${response.status}）。`,
        );
    },
    async start(name, line) {
      await post(`${url(name)}&mode=start`, line, name, '始められません');
    },
    async append(name, lines) {
      await post(`${url(name)}&mode=append`, lines, name, '書き足せません');
    },
    async finish(name, to) {
      await post(
        `${url(name)}&mode=finish&to=${encodeURIComponent(to)}`,
        '',
        to,
        '保存できません',
      );
    },
  };
}

async function post(
  target: string,
  body: string,
  name: string,
  what: string,
): Promise<void> {
  const response = await fetch(target, { method: 'POST', body });
  if (response.ok) return;
  // The size limit is the one an operator meets, so it is named rather than numbered.
  if (response.status === 413) {
    throw new Error(`録画 ${name} が大きくなりすぎました。`);
  }
  throw new Error(`録画 ${name} を${what}（${response.status}）。`);
}

/** The files the recording chooser offers: session lines, compressed or not, and v1 documents. */
export const RECORDING_FILE_ACCEPT =
  '.jsonl,.gz,.json,application/x-ndjson,application/gzip,application/json';

/**
 * A recording the operator chose, compressed or not, to be read like one the host keeps.
 *
 * A finished recording is gzip on disk, and a file opened from disk arrives without anything to
 * unpack it on the way, so it is unpacked here. The two magic bytes decide, not the name: a
 * recording copied from a venue may have been renamed on the way.
 */
export async function recordingFileSource(
  file: File,
): Promise<RecordingSource> {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const compressed = head[0] === 0x1f && head[1] === 0x8b;
  return {
    async open() {
      return decodeRecording(
        file.stream() as ReadableStream<Uint8Array>,
        compressed,
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

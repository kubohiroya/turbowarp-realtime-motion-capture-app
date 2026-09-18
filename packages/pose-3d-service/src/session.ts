/**
 * A recorded run of the 3D service, and the ground truth when there is one (#34, stage 2).
 *
 * Everything the service was given, in the order it was given, with the time it arrived. A session
 * replays into any implementation, so two implementations can be compared on the same input, and a
 * venue recording can be replayed at a desk. It is the evaluation format for every later stage, so it
 * carries what the service was configured with rather than a reference to it.
 *
 * This package imports with `.ts` specifiers throughout: Vite builds the extension bundle from source
 * and Node runs the evaluation tool from the same files, with no build step in between.
 *
 * Ground truth belongs to synthetic sessions. A recording from real cameras has none, which is why it
 * is optional and why metrics say which figures they could compute.
 */

import type {
  Coco17KeypointId,
  PoseFrame2D,
  ServiceConfiguration,
} from './contracts.ts';

export const SESSION_SCHEMA = 'twrmc/pose-3d-session';
/**
 * Version 2 is JSONL: a header line, then one line per event, then the truth frames when there are
 * any. A session is written while it is taken — by a camera app recording a venue, or by this tool
 * writing a long scene — so it has to be readable before it is complete, and appendable while it
 * grows. Version 1, a single JSON document, is still read.
 */
export const SESSION_VERSION = 2;
export const LEGACY_SESSION_VERSION = 1;

export interface SessionFrameEvent {
  readonly type: 'frame2d';
  /** When the service was given this, in microseconds on the recording clock. */
  readonly atUs: number;
  readonly cameraId: string;
  readonly frame: PoseFrame2D;
}

export interface SessionRequestEvent {
  readonly type: 'requestPose3d';
  readonly atUs: number;
}

export type SessionEvent = SessionFrameEvent | SessionRequestEvent;

/** One person's joints in reference coordinates, as the scene put them. */
export interface TruthPerson {
  readonly personId: string;
  readonly joints: ReadonlyArray<{
    readonly id: Coco17KeypointId;
    readonly x: number;
    readonly y: number;
    readonly z: number;
    /** The cameras that could see this joint: outside their view, or hidden, it is absent here. */
    readonly cameraIds: readonly string[];
  }>;
}

export interface TruthFrame {
  readonly timestampUs: number;
  readonly persons: readonly TruthPerson[];
}

export interface Session {
  readonly schema: typeof SESSION_SCHEMA;
  readonly version: typeof SESSION_VERSION;
  /** What produced this, such as `synthetic/walk-v1` or `local-app`. Recorded, never interpreted. */
  readonly producer: string;
  readonly configuration: ServiceConfiguration;
  readonly events: readonly SessionEvent[];
  /** Present for synthetic sessions only. */
  readonly truth?: readonly TruthFrame[];
}

/** The session as lines: header, events in order, then the truth frames a scene brought with it. */
export function serializeSession(session: Session): string {
  const lines = [
    JSON.stringify({
      type: 'header',
      schema: SESSION_SCHEMA,
      version: SESSION_VERSION,
      producer: session.producer,
      configuration: session.configuration,
    }),
    ...session.events.map((event) => JSON.stringify(event)),
    ...(session.truth ?? []).map((frame) =>
      JSON.stringify({ type: 'truth', ...frame }),
    ),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Reads a session, refusing anything it cannot replay faithfully.
 *
 * Deliberately strict about the envelope and lenient about the documents inside: frames and
 * configurations are validated where they are used, by the same checks the live path uses, so a
 * session recorded from a build with a newer document version still reports the same refusal here as
 * it would there.
 */
export function parseSession(
  text: string,
): { ok: true; session: Session } | { ok: false; reason: string } {
  const first = text.split('\n', 1)[0] ?? '';
  if (isSessionHeaderLine(first)) return parseSessionLines(text);
  return parseSessionDocument(text);
}

/** Whether a first line is the header of a session written as lines, whatever it says. */
function isSessionHeaderLine(line: string): boolean {
  const record = parseRecord(line);
  return record !== undefined && record['type'] === 'header';
}

/** What a session's header line says, and what it is recorded with. */
export interface SessionHeader {
  readonly producer: string;
  readonly configuration: Session['configuration'];
}

/**
 * Reads the header line of a session written as lines, refusing anything it cannot replay.
 *
 * With `parseSessionLine`, this is the whole of `parseSession` for version 2, one line at a time, so a
 * recording too large to hold as one string is read by the same rules as one that is not.
 */
export function parseSessionHeader(
  line: string,
): { ok: true; header: SessionHeader } | { ok: false; reason: string } {
  const header = parseRecord(line);
  if (header === undefined || header['type'] !== 'header')
    return { ok: false, reason: 'A session must start with its header.' };
  if (header['schema'] !== SESSION_SCHEMA)
    return {
      ok: false,
      reason: `A session must have schema ${SESSION_SCHEMA}.`,
    };
  if (header['version'] !== SESSION_VERSION) {
    return {
      ok: false,
      reason: `Session version ${String(header['version'])} is not supported.`,
    };
  }
  if (typeof header['producer'] !== 'string')
    return { ok: false, reason: 'A session must name its producer.' };
  if (
    typeof header['configuration'] !== 'object' ||
    header['configuration'] === null
  ) {
    return {
      ok: false,
      reason: 'A session must carry the configuration it was recorded with.',
    };
  }
  return {
    ok: true,
    header: {
      producer: header['producer'],
      configuration: header['configuration'] as Session['configuration'],
    },
  };
}

/** One line after the header, as `parseSessionLine` reads it. */
export type SessionLine =
  | { readonly kind: 'event'; readonly event: SessionEvent }
  | { readonly kind: 'truth'; readonly truth: TruthFrame }
  | { readonly kind: 'other' }
  | { readonly kind: 'end' }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * Reads one line after the header.
 *
 * `end` is a line that cannot be read: the session ends there rather than failing, because a
 * recording interrupted mid-line is a recording of everything before that line, and refusing it would
 * throw away the take to keep the format tidy. `other` is a blank line or a kind of line the service
 * does not replay (a camera's space-time measurement, say). `lineNumber` counts from 1, the header
 * being line 1, and is what a refusal names.
 */
export function parseSessionLine(
  line: string,
  lineNumber: number,
): SessionLine {
  if (line.trim() === '') return { kind: 'other' };
  const record = parseRecord(line);
  if (record === undefined) return { kind: 'end' };
  const kind = record['type'];
  if (kind === 'truth')
    return { kind: 'truth', truth: record as unknown as TruthFrame };
  if (kind !== 'frame2d' && kind !== 'requestPose3d') return { kind: 'other' };
  const failure = eventFailure(record, lineNumber);
  if (failure !== undefined) return { kind: 'failed', reason: failure };
  return { kind: 'event', event: record as unknown as SessionEvent };
}

/** A line as a JSON object, or nothing when it is not one. */
function parseRecord(line: string): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

/**
 * Reads a session written as lines.
 *
 * Everything before a broken line is replayed, and the caller is told nothing, because a truncated
 * take is what it looks like.
 */
function parseSessionLines(
  text: string,
): { ok: true; session: Session } | { ok: false; reason: string } {
  const lines = text.split('\n');
  const header = parseSessionHeader(lines[0] ?? '');
  if (!header.ok) return header;
  const events: SessionEvent[] = [];
  const truth: TruthFrame[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const read = parseSessionLine(lines[index] ?? '', index + 1);
    if (read.kind === 'end') break;
    if (read.kind === 'failed') return { ok: false, reason: read.reason };
    if (read.kind === 'event') events.push(read.event);
    else if (read.kind === 'truth') truth.push(read.truth);
  }
  return {
    ok: true,
    session: {
      schema: SESSION_SCHEMA,
      version: SESSION_VERSION,
      producer: header.header.producer,
      configuration: header.header.configuration,
      events,
      ...(truth.length === 0 ? {} : { truth }),
    },
  };
}

/** Reads the single-document form, which is what every session written before version 2 is. */
function parseSessionDocument(
  text: string,
): { ok: true; session: Session } | { ok: false; reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      reason: `The session is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'A session must be an object.' };
  }
  const record = value as Record<string, unknown>;
  if (record['schema'] !== SESSION_SCHEMA)
    return {
      ok: false,
      reason: `A session must have schema ${SESSION_SCHEMA}.`,
    };
  if (record['version'] !== LEGACY_SESSION_VERSION) {
    return {
      ok: false,
      reason: `Session version ${String(record['version'])} is not supported.`,
    };
  }
  if (typeof record['producer'] !== 'string')
    return { ok: false, reason: 'A session must name its producer.' };
  if (
    typeof record['configuration'] !== 'object' ||
    record['configuration'] === null
  ) {
    return {
      ok: false,
      reason: 'A session must carry the configuration it was recorded with.',
    };
  }
  const events = record['events'];
  if (!Array.isArray(events))
    return { ok: false, reason: 'A session must carry an event list.' };
  for (const [index, event] of events.entries()) {
    if (typeof event !== 'object' || event === null)
      return { ok: false, reason: `Event ${index} is not an object.` };
    const failure = eventFailure(event as Record<string, unknown>, index);
    if (failure !== undefined) return { ok: false, reason: failure };
  }
  return {
    ok: true,
    session: {
      ...(record as unknown as Session),
      version: SESSION_VERSION,
    } as Session,
  };
}

/** What is wrong with an event, or nothing. Shared by both forms, so both refuse the same things. */
function eventFailure(
  event: Record<string, unknown>,
  where: number,
): string | undefined {
  const kind = event['type'];
  if (kind !== 'frame2d' && kind !== 'requestPose3d')
    return `Event ${where} has an unknown type ${String(kind)}.`;
  const atUs = event['atUs'];
  if (typeof atUs !== 'number' || !Number.isFinite(atUs))
    return `Event ${where} needs a finite atUs.`;
  if (kind === 'frame2d' && typeof event['cameraId'] !== 'string')
    return `Event ${where} needs a cameraId.`;
  return undefined;
}

/**
 * Collects a session while the service is being used.
 *
 * Bounded by event count rather than by time: a recorder that grew without limit would be a slow leak
 * in a venue, and one that dropped the newest events would lose exactly the moment worth keeping. The
 * oldest events go first, and the session says how many were dropped.
 */
export class SessionRecorder {
  private readonly limit: number;
  private readonly producer: string;
  private events: SessionEvent[] = [];
  private configuration: ServiceConfiguration | undefined;
  private dropped = 0;

  public constructor(options: { producer: string; limit?: number }) {
    this.producer = options.producer;
    this.limit = options.limit ?? 20_000;
  }

  public configured(configuration: ServiceConfiguration): void {
    this.configuration = configuration;
    this.events = [];
    this.dropped = 0;
  }

  public frame(atUs: number, cameraId: string, frame: PoseFrame2D): void {
    this.push({ type: 'frame2d', atUs, cameraId, frame });
  }

  public request(atUs: number): void {
    this.push({ type: 'requestPose3d', atUs });
  }

  public eventCount(): number {
    return this.events.length;
  }

  public droppedCount(): number {
    return this.dropped;
  }

  /** The session so far, or nothing when no configuration has been recorded. */
  public session(): Session | undefined {
    if (!this.configuration) return undefined;
    return {
      schema: SESSION_SCHEMA,
      version: SESSION_VERSION,
      producer:
        this.dropped === 0
          ? this.producer
          : `${this.producer} (${this.dropped} events dropped)`,
      configuration: this.configuration,
      events: [...this.events],
    };
  }

  public clear(): void {
    this.events = [];
    this.dropped = 0;
    this.configuration = undefined;
  }

  private push(event: SessionEvent): void {
    if (!this.configuration) return;
    this.events.push(event);
    if (this.events.length > this.limit) {
      this.events.splice(0, this.events.length - this.limit);
      this.dropped += 1;
    }
  }
}

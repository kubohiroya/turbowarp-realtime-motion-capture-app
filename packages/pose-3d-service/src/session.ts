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

import type {Coco17KeypointId, PoseFrame2D, ServiceConfiguration} from './contracts.ts';

export const SESSION_SCHEMA = 'twrmc/pose-3d-session';
export const SESSION_VERSION = 1;

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

export function serializeSession(session: Session): string {
  return JSON.stringify(session);
}

/**
 * Reads a session, refusing anything it cannot replay faithfully.
 *
 * Deliberately strict about the envelope and lenient about the documents inside: frames and
 * configurations are validated where they are used, by the same checks the live path uses, so a
 * session recorded from a build with a newer document version still reports the same refusal here as
 * it would there.
 */
export function parseSession(text: string): {ok: true; session: Session} | {ok: false; reason: string} {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {ok: false, reason: `The session is not JSON: ${error instanceof Error ? error.message : String(error)}`};
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {ok: false, reason: 'A session must be an object.'};
  }
  const record = value as Record<string, unknown>;
  if (record['schema'] !== SESSION_SCHEMA) return {ok: false, reason: `A session must have schema ${SESSION_SCHEMA}.`};
  if (record['version'] !== SESSION_VERSION) {
    return {ok: false, reason: `Session version ${String(record['version'])} is not supported.`};
  }
  if (typeof record['producer'] !== 'string') return {ok: false, reason: 'A session must name its producer.'};
  if (typeof record['configuration'] !== 'object' || record['configuration'] === null) {
    return {ok: false, reason: 'A session must carry the configuration it was recorded with.'};
  }
  const events = record['events'];
  if (!Array.isArray(events)) return {ok: false, reason: 'A session must carry an event list.'};
  for (const [index, event] of events.entries()) {
    if (typeof event !== 'object' || event === null) return {ok: false, reason: `Event ${index} is not an object.`};
    const kind = (event as Record<string, unknown>)['type'];
    const atUs = (event as Record<string, unknown>)['atUs'];
    if (kind !== 'frame2d' && kind !== 'requestPose3d') {
      return {ok: false, reason: `Event ${index} has an unknown type ${String(kind)}.`};
    }
    if (typeof atUs !== 'number' || !Number.isFinite(atUs)) {
      return {ok: false, reason: `Event ${index} needs a finite atUs.`};
    }
    if (kind === 'frame2d' && typeof (event as Record<string, unknown>)['cameraId'] !== 'string') {
      return {ok: false, reason: `Event ${index} needs a cameraId.`};
    }
  }
  return {ok: true, session: record as unknown as Session};
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

  public constructor(options: {producer: string; limit?: number} ) {
    this.producer = options.producer;
    this.limit = options.limit ?? 20_000;
  }

  public configured(configuration: ServiceConfiguration): void {
    this.configuration = configuration;
    this.events = [];
    this.dropped = 0;
  }

  public frame(atUs: number, cameraId: string, frame: PoseFrame2D): void {
    this.push({type: 'frame2d', atUs, cameraId, frame});
  }

  public request(atUs: number): void {
    this.push({type: 'requestPose3d', atUs});
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
      producer: this.dropped === 0 ? this.producer : `${this.producer} (${this.dropped} events dropped)`,
      configuration: this.configuration,
      events: [...this.events]
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

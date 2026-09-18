/**
 * Replays a recorded session into a service and times it (#34, stage 2).
 *
 * The events go in as they were recorded, in order, and the answers come out with the time each one
 * took inside the service. Nothing waits for wall-clock time: a ten-second session replays in
 * milliseconds, which is what makes it usable in a test.
 *
 * The service is replaced, never the session, so two implementations are compared on identical input.
 */

import { Pose3dService } from './service.ts';
import {
  request,
  validateResponse,
  type ImplementationId,
  type PoseFrame3DV2,
  type ServiceErrorCode,
} from './contracts.ts';
import type { Session } from './session.ts';

export interface ServiceHandler {
  handle(message: unknown): unknown;
}

export interface ReplayAnswer {
  /** The recording time of the request this answers. */
  readonly atUs: number;
  readonly frame: PoseFrame3DV2 | null;
  /** How long the service took, in milliseconds. */
  readonly handleMs: number;
}

export interface ReplayResult {
  readonly answers: readonly ReplayAnswer[];
  /** How long after its request each answer is taken to be shown, microseconds. */
  readonly displayLeadUs: number;
  readonly framesSent: number;
  readonly framesAccepted: number;
  readonly requests: number;
  readonly unanswered: number;
  readonly errors: ReadonlyArray<{
    readonly code: ServiceErrorCode;
    readonly message: string;
  }>;
  /** Milliseconds the service spent on each message, in the order they were handled. */
  readonly handleMs: readonly number[];
}

export interface ReplayOptions {
  /** Defaults to the session's own implementation, which a synthetic session leaves at the stub. */
  readonly implementation?: ImplementationId;
  readonly service?: ServiceHandler;
  /** Monotonic milliseconds. Injected so a test can measure without a real clock. */
  readonly nowMs?: () => number;
  /** How long after its request each answer is shown, microseconds; 0 when not given. */
  readonly displayLeadUs?: number;
  /** Asks the service to extrapolate each answer to its request plus `displayLeadUs`. */
  readonly predict?: boolean;
}

export function replaySession(
  session: Session,
  options: ReplayOptions = {},
): ReplayResult {
  const service = options.service ?? new Pose3dService();
  const nowMs = options.nowMs ?? defaultNowMs;
  const configuration = options.implementation
    ? { ...session.configuration, implementation: options.implementation }
    : session.configuration;
  const answers: ReplayAnswer[] = [];
  const errors: Array<{ code: ServiceErrorCode; message: string }> = [];
  const handleMs: number[] = [];
  let id = 1;
  let framesSent = 0;
  let framesAccepted = 0;
  let requests = 0;
  let unanswered = 0;

  const send = (message: unknown): unknown => {
    const started = nowMs();
    const answer = service.handle(message);
    handleMs.push(nowMs() - started);
    return answer;
  };

  const configured = send(request(id++, 'configure', configuration));
  const checkedConfiguration = validateResponse(configured);
  if (
    !checkedConfiguration.ok ||
    checkedConfiguration.value.type !== 'configured'
  ) {
    const reason = !checkedConfiguration.ok
      ? {
          code: checkedConfiguration.code,
          message: checkedConfiguration.message,
        }
      : {
          code: 'invalid-response' as const,
          message: `Expected configured, received ${checkedConfiguration.value.type}.`,
        };
    return {
      answers: [],
      displayLeadUs: options.displayLeadUs ?? 0,
      framesSent: 0,
      framesAccepted: 0,
      requests: 0,
      unanswered: 0,
      errors: [reason],
      handleMs,
    };
  }

  for (const event of session.events) {
    if (event.type === 'frame2d') {
      framesSent += 1;
      const answer = validateResponse(
        send(
          request(id++, 'frame2d', {
            cameraId: event.cameraId,
            frame: event.frame,
          }),
        ),
      );
      if (!answer.ok)
        errors.push({ code: answer.code, message: answer.message });
      else if (answer.value.type === 'accepted') framesAccepted += 1;
      else if (answer.value.type === 'error') errors.push(answer.value.payload);
      continue;
    }
    requests += 1;
    const raw = send(
      request(id++, 'requestPose3d', {
        timestampUs: null,
        predictToUs:
          options.predict === true
            ? event.atUs + (options.displayLeadUs ?? 0)
            : null,
      }),
    );
    if (raw === null || raw === undefined) {
      unanswered += 1;
      continue;
    }
    const answer = validateResponse(raw);
    if (!answer.ok) {
      errors.push({ code: answer.code, message: answer.message });
      continue;
    }
    if (answer.value.type === 'error') {
      errors.push(answer.value.payload);
      continue;
    }
    if (answer.value.type !== 'pose3d') {
      errors.push({
        code: 'invalid-response',
        message: `Expected pose3d, received ${answer.value.type}.`,
      });
      continue;
    }
    answers.push({
      atUs: event.atUs,
      frame: answer.value.payload,
      handleMs: handleMs[handleMs.length - 1] ?? 0,
    });
  }

  return {
    answers,
    displayLeadUs: options.displayLeadUs ?? 0,
    framesSent,
    framesAccepted,
    requests,
    unanswered,
    errors,
    handleMs,
  };
}

function defaultNowMs(): number {
  return typeof performance === 'object' &&
    typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

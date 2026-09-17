import {
  LIMITS,
  request,
  serializedBytes,
  validateConfiguration,
  validatePoseFrame2D,
  validateResponse,
  type PoseFrame3DV2,
  type ServiceConfiguration,
  type ServiceErrorCode,
  type ServiceRequest,
  type ServiceResponse,
} from './contracts.js';

/** How the client reaches a service: a Worker in the page, or anything else that carries messages. */
export interface ServicePort {
  post(message: ServiceRequest): void;
  onMessage(listener: (message: unknown) => void): void;
  onFailure(listener: (reason: string) => void): void;
  close(): void;
}

export interface ClientClock {
  nowMs(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * - `idle`: nothing configured.
 * - `configuring`: a configuration is on its way.
 * - `ready`: the last 3D request was answered with a valid frame, or none has been made yet.
 * - `degraded`: the last 3D request timed out or was answered with something invalid. 3D output is
 *   withheld until a valid answer arrives again.
 * - `error`: configuration failed or the service stopped. Nothing is sent until it is configured again.
 */
export type ClientState =
  'idle' | 'configuring' | 'ready' | 'degraded' | 'error';

export interface ClientStatus {
  readonly state: ClientState;
  readonly implementation: string;
  readonly errorCode: ServiceErrorCode | '';
  readonly errorMessage: string;
  readonly rttMs: number;
  readonly poseAgeMs: number;
  readonly persons: number;
  readonly framesSent: number;
  readonly framesRejected: number;
  readonly framesStale: number;
  readonly framesInvalid: number;
  readonly consecutiveTimeouts: number;
}

interface Pending {
  readonly resolve: (message: ServiceResponse | undefined) => void;
  readonly timer: unknown;
}

/**
 * The fusion app's side of interface v1.
 *
 * It validates what it sends so the service never has to be trusted to reject garbage, validates what
 * it receives so a broken service cannot reach a consumer, and never shows a 3D frame it could not
 * confirm is current: a timeout or an invalid answer clears the frame instead of leaving the last one
 * standing.
 */
export class Pose3dServiceClient {
  private readonly port: ServicePort;
  private readonly clock: ClientClock;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private configuration: ServiceConfiguration | undefined;
  private readonly lastSequence = new Map<string, number>();
  private latest: PoseFrame3DV2 | undefined;
  private latestAtMs = 0;
  private requestInFlight: Promise<void> | undefined;
  private state: ClientState = 'idle';
  private errorCode: ServiceErrorCode | '' = '';
  private errorMessage = '';
  private rttMs = 0;
  private framesSent = 0;
  private framesRejected = 0;
  private framesStale = 0;
  private framesInvalid = 0;
  private consecutiveTimeouts = 0;

  public constructor(port: ServicePort, clock: ClientClock) {
    this.port = port;
    this.clock = clock;
    port.onMessage((message) => this.receive(message));
    port.onFailure((reason) => {
      this.fail('worker-failed', reason);
      for (const [id, pending] of this.pending) {
        this.clock.clearTimeout(pending.timer);
        pending.resolve(undefined);
        this.pending.delete(id);
      }
    });
  }

  public async configure(value: unknown): Promise<void> {
    const checked = validateConfiguration(value);
    if (!checked.ok) {
      this.fail(checked.code, checked.message);
      return;
    }
    this.state = 'configuring';
    this.latest = undefined;
    this.lastSequence.clear();
    const answer = await this.send(
      'configure',
      checked.value,
      LIMITS.configureTimeoutMs,
    );
    if (answer === undefined) {
      if (this.state === 'configuring')
        this.fail('timeout', 'The service did not answer the configuration.');
      return;
    }
    if (answer.type === 'error') {
      this.fail(answer.payload.code, answer.payload.message);
      return;
    }
    if (answer.type !== 'configured') {
      this.fail(
        'invalid-response',
        `Expected configured, received ${answer.type}.`,
      );
      return;
    }
    this.configuration = checked.value;
    this.state = 'ready';
    this.errorCode = '';
    this.errorMessage = '';
  }

  /**
   * Forwards one camera's newest frame unless it is invalid, stale, already sent, or refers to a
   * calibration other than the one the camera was placed with. The capture timestamp travels as it
   * arrived.
   */
  public sendFrame(
    cameraId: string,
    frameJson: string,
    receivedAgoMs: number,
  ): void {
    const configuration = this.configuration;
    if (
      !configuration ||
      this.state === 'error' ||
      this.state === 'configuring' ||
      this.state === 'idle'
    )
      return;
    if (frameJson === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(frameJson);
    } catch {
      this.framesInvalid += 1;
      return;
    }
    const frame = validatePoseFrame2D(parsed);
    if (!frame.ok) {
      this.framesInvalid += 1;
      return;
    }
    const camera = configuration.cameras.find(
      (candidate) => candidate.cameraId === cameraId,
    );
    if (
      !camera ||
      frame.value.calibrationId !== camera.model.intrinsicProfileId
    ) {
      this.framesInvalid += 1;
      return;
    }
    if (this.lastSequence.get(cameraId) === frame.value.sequence) return;
    this.lastSequence.set(cameraId, frame.value.sequence);
    if (!(receivedAgoMs >= 0) || receivedAgoMs > LIMITS.maxFrameAgeMs) {
      this.framesStale += 1;
      return;
    }
    this.framesSent += 1;
    void this.send(
      'frame2d',
      { cameraId, frame: frame.value },
      LIMITS.requestTimeoutMs,
    ).then((answer) => {
      if (answer?.type === 'error') this.framesRejected += 1;
    });
  }

  /** Asks for the current 3D frame. A request still in flight is joined rather than duplicated. */
  public requestPose3d(): Promise<void> {
    if (this.requestInFlight) return this.requestInFlight;
    const inFlight = this.runRequest().finally(() => {
      if (this.requestInFlight === inFlight) this.requestInFlight = undefined;
    });
    this.requestInFlight = inFlight;
    return inFlight;
  }

  private async runRequest(): Promise<void> {
    if (
      !this.configuration ||
      this.state === 'error' ||
      this.state === 'configuring' ||
      this.state === 'idle'
    )
      return;
    const started = this.clock.nowMs();
    const answer = await this.send(
      'requestPose3d',
      { timestampUs: null },
      LIMITS.requestTimeoutMs,
    );
    // The service may have failed or been reconfigured while this request was out.
    if ((this.state as ClientState) === 'error') return;
    if (answer === undefined) {
      this.consecutiveTimeouts += 1;
      this.withhold(
        'timeout',
        'The service did not answer the 3D request in time.',
      );
      return;
    }
    if (answer.type === 'error') {
      this.withhold(answer.payload.code, answer.payload.message);
      return;
    }
    if (answer.type !== 'pose3d') {
      this.withhold(
        'invalid-response',
        `Expected pose3d, received ${answer.type}.`,
      );
      return;
    }
    this.consecutiveTimeouts = 0;
    this.rttMs = this.clock.nowMs() - started;
    this.latest = answer.payload ?? undefined;
    this.latestAtMs = this.clock.nowMs();
    this.state = 'ready';
    this.errorCode = '';
    this.errorMessage = '';
  }

  public latestFrame(): PoseFrame3DV2 | undefined {
    return this.latest;
  }

  public status(): ClientStatus {
    return {
      state: this.state,
      implementation: this.configuration?.implementation ?? '',
      errorCode: this.errorCode,
      errorMessage: this.errorMessage,
      rttMs: Math.round(this.rttMs),
      poseAgeMs:
        this.latest === undefined
          ? -1
          : Math.round(this.clock.nowMs() - this.latestAtMs),
      persons: this.latest?.persons.length ?? 0,
      framesSent: this.framesSent,
      framesRejected: this.framesRejected,
      framesStale: this.framesStale,
      framesInvalid: this.framesInvalid,
      consecutiveTimeouts: this.consecutiveTimeouts,
    };
  }

  public close(): void {
    for (const pending of this.pending.values()) {
      this.clock.clearTimeout(pending.timer);
      pending.resolve(undefined);
    }
    this.pending.clear();
    this.port.close();
    this.configuration = undefined;
    this.latest = undefined;
    this.state = 'idle';
  }

  private send<Type extends ServiceRequest['type']>(
    type: Type,
    payload: Extract<ServiceRequest, { type: Type }>['payload'],
    timeoutMs: number,
  ): Promise<ServiceResponse | undefined> {
    const id = this.nextId++;
    const message = request(id, type, payload as never);
    if (serializedBytes(message) > LIMITS.maxMessageBytes) {
      this.framesInvalid += 1;
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      const timer = this.clock.setTimeout(() => {
        this.pending.delete(id);
        resolve(undefined);
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.port.post(message);
    });
  }

  private receive(message: unknown): void {
    const checked = validateResponse(message);
    const id =
      typeof message === 'object' && message !== null
        ? (message as { id?: unknown }).id
        : undefined;
    const pending = typeof id === 'number' ? this.pending.get(id) : undefined;
    if (!pending) return;
    this.pending.delete(id as number);
    this.clock.clearTimeout(pending.timer);
    if (!checked.ok) {
      this.withhold(checked.code, checked.message);
      pending.resolve({
        interface: 'twrmc/pose-3d-service',
        version: 1,
        id: id as number,
        type: 'error',
        payload: { code: checked.code, message: checked.message },
      });
      return;
    }
    pending.resolve(checked.value);
  }

  /** Withdraws the 3D frame: output stops rather than showing one that may no longer hold. */
  private withhold(code: ServiceErrorCode, message: string): void {
    this.latest = undefined;
    if (this.state !== 'error') this.state = 'degraded';
    this.errorCode = code;
    this.errorMessage = message;
  }

  private fail(code: ServiceErrorCode, message: string): void {
    this.latest = undefined;
    this.configuration = undefined;
    this.state = 'error';
    this.errorCode = code;
    this.errorMessage = message;
  }
}

import definitions from './block-definitions.json';
import {Pose3dServiceClient, type ClientClock, type ServicePort} from './client.ts';
import {toPoseFrame3DV1, type ServiceCamera} from './contracts.ts';

type BlockTypeName = 'COMMAND' | 'REPORTER';
type ArgumentTypeName = 'STRING' | 'NUMBER';

interface BlockDefinition {
  opcode: string;
  blockType: BlockTypeName;
  text: string;
  description: string;
  arguments: Record<string, {type: ArgumentTypeName; defaultValue: string | number}>;
}

export const extensionId = 'realtimemotioncapturepose3dservice';

/** Creates the transport. The extension creates a Worker; tests pass an in-process port. */
export type PortFactory = () => ServicePort;

export const browserClock: ClientClock = {
  nowMs: () => (typeof performance === 'undefined' ? Date.now() : performance.now()),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

function readJson(value: unknown): unknown {
  try {
    return JSON.parse(Scratch.Cast.toString(value));
  } catch {
    return undefined;
  }
}

/**
 * Blocks for the fusion app to drive the 3D pose service (#34, stage 1).
 *
 * A configuration is assembled camera by camera, because a Scratch script cannot build a JSON array,
 * then applied at once. Frames are forwarded one camera at a time; the client drops repeats and stale
 * frames. The 3D frame reported here is always one the client validated and received in answer to the
 * latest request; after a timeout or an invalid answer the reporters are empty, never the last frame.
 */
export class Pose3dServiceExtension implements TurboWarpExtension {
  private readonly createPort: PortFactory;
  private readonly clock: ClientClock;
  private client: Pose3dServiceClient | undefined;
  private draft: {implementation: string; referenceId: string; cameras: ServiceCamera[]} | undefined;
  private draftError = '';

  public constructor(createPort: PortFactory, clock: ClientClock = browserClock) {
    this.createPort = createPort;
    this.clock = clock;
  }

  public getInfo(): Record<string, unknown> {
    return {
      id: extensionId,
      name: 'Pose 3D Service',
      blocks: (definitions.blocks as BlockDefinition[]).map((block) => ({
        opcode: block.opcode,
        blockType: Scratch.BlockType[block.blockType],
        text: block.text,
        arguments: Object.fromEntries(
          Object.entries(block.arguments).map(([name, argument]) => [
            name,
            {type: Scratch.ArgumentType[argument.type], defaultValue: argument.defaultValue}
          ])
        )
      }))
    };
  }

  public beginConfiguration(args: {IMPLEMENTATION: unknown; REFERENCE_ID: unknown}): void {
    this.draft = {
      implementation: Scratch.Cast.toString(args.IMPLEMENTATION),
      referenceId: Scratch.Cast.toString(args.REFERENCE_ID),
      cameras: []
    };
    this.draftError = '';
  }

  public addCamera(args: {CAMERA_ID: unknown; MODEL_JSON: unknown; PLACEMENT_JSON: unknown; TIME_JSON: unknown}): void {
    const draft = this.draft;
    if (!draft) {
      this.draftError = 'Begin a configuration before adding cameras.';
      return;
    }
    const cameraId = Scratch.Cast.toString(args.CAMERA_ID);
    const placement = readJson(args.PLACEMENT_JSON) as {cameras?: Array<{cameraId?: unknown; cameraFromReference?: unknown}>} | undefined;
    const placed = placement?.cameras?.find((camera) => camera.cameraId === cameraId);
    draft.cameras.push({
      cameraId,
      model: readJson(args.MODEL_JSON) as ServiceCamera['model'],
      cameraFromReference: (placed?.cameraFromReference ?? []) as number[],
      timeCorrespondence: readJson(args.TIME_JSON) ?? null
    });
  }

  public async applyConfiguration(): Promise<void> {
    const draft = this.draft;
    if (!draft) {
      this.draftError = 'Begin a configuration before applying it.';
      return;
    }
    this.client?.close();
    this.client = new Pose3dServiceClient(this.createPort(), this.clock);
    await this.client.configure(draft);
  }

  public sendPoseFrame(args: {FRAME_JSON: unknown; CAMERA_ID: unknown; AGE_MS: unknown}): void {
    this.client?.sendFrame(
      Scratch.Cast.toString(args.CAMERA_ID),
      Scratch.Cast.toString(args.FRAME_JSON),
      Scratch.Cast.toNumber(args.AGE_MS)
    );
  }

  public async requestPose3d(): Promise<void> {
    await this.client?.requestPose3d();
  }

  public latestPose3dJson(): string {
    const frame = this.client?.latestFrame();
    return frame ? JSON.stringify(frame) : '';
  }

  public latestPose3dV1Json(): string {
    const frame = this.client?.latestFrame();
    return frame ? JSON.stringify(toPoseFrame3DV1(frame)) : '';
  }

  public serviceState(): string {
    return this.client?.status().state ?? 'idle';
  }

  public serviceError(): string {
    if (this.draftError) return `invalid-payload: ${this.draftError}`;
    const status = this.client?.status();
    return status && status.errorCode ? `${status.errorCode}: ${status.errorMessage}` : '';
  }

  public serviceStatusJson(): string {
    return JSON.stringify(this.client?.status() ?? {state: 'idle'});
  }

  public stopService(): void {
    this.client?.close();
    this.client = undefined;
    this.draft = undefined;
    this.draftError = '';
  }
}

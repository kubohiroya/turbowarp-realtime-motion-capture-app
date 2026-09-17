import {createScratchShellHost} from './host.js';

/**
 * Several cameras on one PC: start each at a requested size, show them side by side, and measure
 * what each one actually delivers (#36, stage 1).
 *
 * Cameras are acquired through Camera Source's runtime API, so every other consumer shares the same
 * stream and lease rules. Camera Source draws its own stage preview centred and covering the whole
 * stage, which is right for one camera and makes several overlap; the grid shows each stream in its
 * own tile instead. The tiles play the stream Camera Source opened — they do not open another.
 *
 * What a camera reports it was configured for and what it delivers differ once several cameras share
 * a USB controller: a camera can accept 1080p at 30 fps and deliver 12 frames a second. The grid
 * counts presented frames per camera, so that limit is measured rather than assumed.
 */

export interface CameraLeasePort {
  getFrameSource(): {readonly element: HTMLVideoElement; readonly width: number; readonly height: number};
  release(): Promise<void>;
}

export interface CameraSourcePort {
  acquireCamera(options: {
    owner: string;
    cameraId: string;
    video?: MediaTrackConstraints;
  }): Promise<CameraLeasePort>;
}

export interface CameraGridHost {
  readonly document: Document | null;
  /**
   * The element the stage and the shell's overlays live in. The grid goes inside it, below them:
   * placed on `body` instead, it would cover the whole stage container — menu and messages included —
   * whatever z-index they have inside it.
   */
  resolveMount(): HTMLElement | null;
  cameraSource(): CameraSourcePort | null;
  nowMs(): number;
}

export interface CameraRequest {
  readonly cameraId: string;
  readonly deviceId: string;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
}

export type GridCameraState = 'starting' | 'running' | 'ended' | 'error';

export interface GridCameraReport {
  readonly cameraId: string;
  readonly state: GridCameraState;
  readonly error: string;
  readonly deviceId: string;
  readonly label: string;
  readonly requested: {readonly width: number; readonly height: number; readonly frameRate: number};
  /** What the track says it was configured to, which is not what it delivers. */
  readonly settings: {readonly width: number; readonly height: number; readonly frameRate: number};
  /** Frames presented during the last complete measurement window, per second. */
  readonly measuredFps: number;
}

interface GridCamera {
  readonly request: CameraRequest;
  state: GridCameraState;
  error: string;
  lease: CameraLeasePort | undefined;
  track: MediaStreamTrack | undefined;
  frames: number;
  windowStartMs: number;
  measuredFps: number;
  cancelFrames: (() => void) | undefined;
  tile: HTMLVideoElement | undefined;
}

const OWNER = 'local-app-camera-grid';
/** Long enough that one late frame does not move the figure, short enough to follow a change. */
const MEASUREMENT_WINDOW_MS = 1_000;
/** Above the stage canvas, below every overlay the shell and the title menu put in the same container. */
const GRID_Z_INDEX = '10';

type VideoFrameCallbackElement = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export class CameraGrid {
  private readonly host: CameraGridHost;
  private readonly cameras = new Map<string, GridCamera>();
  private overlay: HTMLElement | undefined;

  public constructor(host: CameraGridHost) {
    this.host = host;
  }

  /**
   * Starts one camera at the requested size. A camera ID already running is restarted with the new
   * request, and a device another camera ID already holds is refused rather than shared under two
   * names, because two IDs on one device would be measured and calibrated as two cameras.
   */
  public async start(request: CameraRequest): Promise<GridCameraState> {
    const holder = [...this.cameras.values()].find(
      (camera) =>
        camera.request.cameraId !== request.cameraId &&
        request.deviceId !== '' &&
        camera.request.deviceId === request.deviceId &&
        camera.state !== 'error'
    );
    await this.stop(request.cameraId);
    const camera: GridCamera = {
      request,
      state: 'starting',
      error: '',
      lease: undefined,
      track: undefined,
      frames: 0,
      windowStartMs: this.host.nowMs(),
      measuredFps: 0,
      cancelFrames: undefined,
      tile: undefined
    };
    this.cameras.set(request.cameraId, camera);
    if (holder) return this.fail(camera, `device-in-use: ${holder.request.cameraId} already uses this device.`);
    const source = this.host.cameraSource();
    if (!source) return this.fail(camera, 'camera-source-missing: Camera Source is not loaded.');
    try {
      const lease = await source.acquireCamera({
        owner: OWNER,
        cameraId: request.cameraId,
        video: constraintsFor(request)
      });
      if (this.cameras.get(request.cameraId) !== camera) {
        await lease.release();
        return 'ended';
      }
      camera.lease = lease;
      const element = lease.getFrameSource().element;
      // Read by shape rather than `instanceof MediaStream`, which does not exist outside a browser.
      const stream = element.srcObject as {getVideoTracks?: () => MediaStreamTrack[]} | null;
      camera.track = stream?.getVideoTracks?.()[0];
      camera.state = 'running';
      this.measure(camera, element as VideoFrameCallbackElement);
      this.render();
      return camera.state;
    } catch (error) {
      return this.fail(camera, `${errorName(error)}: ${errorMessage(error)}`);
    }
  }

  public async stop(cameraId: string): Promise<void> {
    const camera = this.cameras.get(cameraId);
    if (!camera) return;
    this.cameras.delete(cameraId);
    this.detach(camera);
    await camera.lease?.release().catch(() => undefined);
    this.render();
  }

  public async stopAll(): Promise<void> {
    await Promise.all([...this.cameras.keys()].map((cameraId) => this.stop(cameraId)));
    this.hide();
  }

  public show(): void {
    const document = this.host.document;
    const mount = this.host.resolveMount();
    if (!document || !mount) return;
    if (!this.overlay) {
      const overlay = document.createElement('div');
      overlay.setAttribute('data-camera-grid', '');
      Object.assign(overlay.style, {
        position: 'absolute',
        inset: '0',
        display: 'grid',
        gap: '4px',
        background: '#000000',
        zIndex: GRID_Z_INDEX,
        pointerEvents: 'none'
      });
      mount.appendChild(overlay);
      this.overlay = overlay;
    }
    this.render();
  }

  public hide(): void {
    for (const camera of this.cameras.values()) camera.tile = undefined;
    this.overlay?.remove();
    this.overlay = undefined;
  }

  public report(cameraId: string): GridCameraReport | undefined {
    const camera = this.cameras.get(cameraId);
    if (!camera) return undefined;
    this.refreshState(camera);
    const settings = camera.track?.getSettings?.() ?? {};
    return {
      cameraId,
      state: camera.state,
      error: camera.error,
      deviceId: settings.deviceId ?? camera.request.deviceId,
      label: camera.track?.label ?? '',
      requested: {
        width: camera.request.width,
        height: camera.request.height,
        frameRate: camera.request.frameRate
      },
      settings: {
        width: settings.width ?? 0,
        height: settings.height ?? 0,
        frameRate: settings.frameRate ?? 0
      },
      measuredFps: camera.measuredFps
    };
  }

  public reports(): GridCameraReport[] {
    return [...this.cameras.keys()]
      .sort()
      .map((cameraId) => this.report(cameraId))
      .filter((report): report is GridCameraReport => report !== undefined);
  }

  /** Counts presented frames, and closes a window once a second has passed. */
  private measure(camera: GridCamera, element: VideoFrameCallbackElement): void {
    if (typeof element.requestVideoFrameCallback !== 'function') return;
    let handle: number | undefined;
    const onFrame = () => {
      if (this.cameras.get(camera.request.cameraId) !== camera) return;
      camera.frames += 1;
      const now = this.host.nowMs();
      const elapsed = now - camera.windowStartMs;
      if (elapsed >= MEASUREMENT_WINDOW_MS) {
        camera.measuredFps = Math.round((camera.frames * 10_000) / elapsed) / 10;
        camera.frames = 0;
        camera.windowStartMs = now;
        this.caption(camera);
      }
      handle = element.requestVideoFrameCallback?.(onFrame);
    };
    handle = element.requestVideoFrameCallback(onFrame);
    camera.cancelFrames = () => {
      if (handle !== undefined) element.cancelVideoFrameCallback?.(handle);
    };
  }

  private detach(camera: GridCamera): void {
    camera.cancelFrames?.();
    camera.cancelFrames = undefined;
    camera.tile?.parentElement?.remove();
    camera.tile = undefined;
  }

  /** A track that ended — unplugged, or taken by the OS — reads as ended without a block call. */
  private refreshState(camera: GridCamera): void {
    if (camera.state === 'running' && camera.track?.readyState === 'ended') {
      camera.state = 'ended';
      camera.measuredFps = 0;
      camera.error = 'track-ended: The camera stopped delivering frames.';
    }
  }

  private fail(camera: GridCamera, message: string): GridCameraState {
    camera.state = 'error';
    camera.error = message;
    this.render();
    return camera.state;
  }

  /** One tile per running camera, in camera ID order, in the smallest square-ish grid that fits. */
  private render(): void {
    const overlay = this.overlay;
    const document = this.host.document;
    if (!overlay || !document) return;
    const running = [...this.cameras.values()]
      .filter((camera) => camera.lease)
      .sort((left, right) => left.request.cameraId.localeCompare(right.request.cameraId));
    const columns = Math.max(1, Math.ceil(Math.sqrt(running.length)));
    const rows = Math.max(1, Math.ceil(running.length / columns));
    overlay.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
    overlay.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
    for (const child of [...overlay.children]) child.remove();
    for (const camera of running) {
      const cell = document.createElement('div');
      Object.assign(cell.style, {position: 'relative', overflow: 'hidden', background: '#111111'});
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      video.srcObject = camera.lease?.getFrameSource().element.srcObject ?? null;
      Object.assign(video.style, {width: '100%', height: '100%', objectFit: 'contain'});
      const caption = document.createElement('div');
      Object.assign(caption.style, {
        position: 'absolute',
        left: '8px',
        top: '8px',
        padding: '2px 8px',
        background: 'rgba(0, 0, 0, 0.6)',
        color: '#ffffff',
        font: '14px system-ui, sans-serif',
        borderRadius: '4px'
      });
      cell.appendChild(video);
      cell.appendChild(caption);
      overlay.appendChild(cell);
      camera.tile = video;
      this.caption(camera);
      void video.play?.()?.catch?.(() => undefined);
    }
  }

  private caption(camera: GridCamera): void {
    const caption = camera.tile?.nextElementSibling;
    if (!caption) return;
    const report = this.report(camera.request.cameraId);
    if (!report) return;
    caption.textContent = `${report.cameraId} ${report.settings.width}x${report.settings.height} 設定${report.settings.frameRate}fps / 実測${report.measuredFps}fps`;
  }
}

/** Asks for the size as ideal, not exact: a camera that cannot meet it still starts, and says so. */
export function constraintsFor(request: CameraRequest): MediaTrackConstraints {
  return {
    ...(request.deviceId ? {deviceId: {exact: request.deviceId}} : {}),
    ...(request.width > 0 ? {width: {ideal: request.width}} : {}),
    ...(request.height > 0 ? {height: {ideal: request.height}} : {}),
    ...(request.frameRate > 0 ? {frameRate: {ideal: request.frameRate}} : {})
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reaches Camera Source the way other extensions do: through its runtime key. */
export function createScratchCameraGridHost(): CameraGridHost {
  const shellHost = createScratchShellHost();
  return {
    document: shellHost.document,
    resolveMount: () => shellHost.resolveMount(),
    cameraSource() {
      const candidate = Scratch.vm?.runtime?.['ext_kubohiroyacamerasource'];
      if (typeof candidate !== 'object' || candidate === null) return null;
      const port = candidate as Partial<CameraSourcePort>;
      return typeof port.acquireCamera === 'function' ? (candidate as CameraSourcePort) : null;
    },
    nowMs: () => (typeof performance === 'undefined' ? Date.now() : performance.now())
  };
}

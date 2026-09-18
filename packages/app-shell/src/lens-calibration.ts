import type { ShellLocale } from './app-config.js';

/**
 * Where the lens calibration app is served, relative to the application page.
 *
 * Kept equal to `lensCalibrationPath` in `packages/local-host/src/host.ts`. The two packages do not
 * import each other — one runs in the browser, the other on the venue PC — so the tests on both
 * sides pin the same literal instead.
 */
export const lensCalibrationRoute = '/lens-calibration';

/** Window name, so asking twice brings the same window forward instead of opening a second one. */
const windowName = 'lens-calibration';

/**
 * - `open`: the calibration window was opened and has not been closed.
 * - `closed`: it was opened and the operator has since closed it.
 * - `unavailable`: this page is not served beside a calibration app.
 * - `blocked`: the browser refused to open a window.
 * - `busy`: the calibration window is open for another camera. It is left alone: opening it again
 *   would throw away a calibration in progress.
 */
export type LensCalibrationAppState =
  '' | 'open' | 'closed' | 'unavailable' | 'blocked' | 'busy';

/**
 * The camera a calibration is for, when the app runs several.
 *
 * The calibration app starts exactly this device, at this size: a camera the browser picked could be
 * another of the same model, and a profile solved at another size does not fit.
 */
export interface LensCalibrationRequest {
  readonly deviceId: string;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
}

/**
 * The query parameters Camera Source's `start shared camera ... requested by this page` reads.
 *
 * Only positive sizes are written, so a request with an unknown rate asks the calibration app for no
 * particular rate rather than for zero.
 */
export function lensCalibrationRequestParameters(
  request: LensCalibrationRequest,
): [string, string][] {
  const parameters: [string, string][] = [['cameraDeviceId', request.deviceId]];
  const positive = (name: string, value: number) => {
    if (Number.isFinite(value) && value > 0)
      parameters.push([name, String(value)]);
  };
  positive('cameraWidth', request.width);
  positive('cameraHeight', request.height);
  positive('cameraFrameRate', request.frameRate);
  return parameters;
}

function requestKey(request: LensCalibrationRequest | undefined): string {
  return request === undefined
    ? ''
    : JSON.stringify(lensCalibrationRequestParameters(request));
}

export interface LensCalibrationWindow {
  readonly closed: boolean;
  focus?(): void;
}

/** Everything the launcher needs from the browser, so the decisions can be tested without one. */
export interface LensCalibrationHost {
  /**
   * The calibration app's URL on this origin, naming the camera when there is a request, or `null`
   * when the page has no such origin.
   */
  resolveUrl(request?: LensCalibrationRequest): string | null;
  /** Whether the host actually serves it. A packaged build may carry no calibration app. */
  isServed(url: string): Promise<boolean>;
  openWindow(url: string, name: string): LensCalibrationWindow | null;
  /** Resolves to the chosen file's text, or `null` when the operator gave up. */
  chooseTextFile(): Promise<string | null>;
}

export class LensCalibrationLauncher {
  private readonly host: LensCalibrationHost;
  private window: LensCalibrationWindow | null = null;
  private windowRequest = '';
  private lastState: LensCalibrationAppState = '';
  private chosenText = '';

  public constructor(host: LensCalibrationHost) {
    this.host = host;
  }

  /**
   * Opens the calibration app in its own window.
   *
   * Same origin is required, not preferred: the calibration app hands its profile over through
   * browser storage, which is scoped to the origin. A page opened as a file or on turbowarp.org has
   * no calibration app beside it, and saying `unavailable` there is what sends the operator to the
   * profile file instead of to a window that could never report back.
   */
  public async open(
    request?: LensCalibrationRequest,
  ): Promise<LensCalibrationAppState> {
    const key = requestKey(request);
    if (this.window !== null && !this.window.closed) {
      if (key !== this.windowRequest) return this.settle('busy');
      this.window.focus?.();
      return this.settle('open');
    }
    const url = this.host.resolveUrl(request);
    if (url === null || !(await this.host.isServed(url).catch(() => false))) {
      return this.settle('unavailable');
    }
    const opened = this.host.openWindow(url, windowName);
    this.window = opened;
    this.windowRequest = key;
    return this.settle(opened === null ? 'blocked' : 'open');
  }

  /** The state as of now. A window the operator closed reads `closed` without another block call. */
  public state(): LensCalibrationAppState {
    if (
      (this.lastState === 'open' || this.lastState === 'busy') &&
      (this.window === null || this.window.closed)
    ) {
      this.lastState = 'closed';
    }
    return this.lastState;
  }

  /** Whether the window this app opened is still open, whichever camera it was opened for. */
  public isOpen(): boolean {
    const state = this.state();
    return state === 'open' || state === 'busy';
  }

  /** Asks the operator for a profile file. An abandoned choice leaves the text empty, not stale. */
  public async chooseFile(): Promise<string> {
    this.chosenText = '';
    const text = await this.host.chooseTextFile().catch(() => null);
    this.chosenText = text ?? '';
    return this.chosenText;
  }

  public chosenFileText(): string {
    return this.chosenText;
  }

  private settle(state: LensCalibrationAppState): LensCalibrationAppState {
    this.lastState = state;
    return state;
  }
}

interface ChooserLabels {
  readonly title: string;
  readonly choose: string;
  readonly cancel: string;
}

/** The files the chooser offers: camera_info YAML under the names it travels with, and JSON. */
export const LENS_CALIBRATION_FILE_ACCEPT =
  '.yaml,.yml,.txt,.json,application/json,application/yaml,text/yaml,text/plain';

const chooserLabels: Readonly<Record<ShellLocale, ChooserLabels>> = {
  en: {
    title:
      'Choose the lens calibration file for this camera: the ROS camera_info YAML the lens calibration app exports (saved as profile.txt), or profile JSON.',
    choose: 'Choose file',
    cancel: 'Cancel',
  },
  ja: {
    title:
      'このカメラのレンズ校正ファイルを選んでください。レンズ校正アプリが書き出すROSのcamera_info YAML（profile.txtとして保存されます）か、プロファイルのJSONです。',
    choose: 'ファイルを選ぶ',
    cancel: 'やめる',
  },
};

export interface FileChooserOptions {
  readonly document: Document;
  readonly mount: HTMLElement;
  readonly locale: ShellLocale;
  /** What the picker offers. Defaults to the lens calibration's own files. */
  readonly accept?: string;
  /** How the chosen file becomes text. Defaults to reading it as text. */
  readonly read?: (file: File) => Promise<string>;
}

/**
 * Shows a small dialog whose button opens the browser's file picker.
 *
 * A block cannot open the picker by itself: it runs on the VM's frame timer, and a browser opens a
 * file dialog only from the operator's own click. The dialog supplies that click. Closing the picker
 * without a file keeps the dialog up, so the operator decides to give up rather than the browser.
 */
export function chooseTextFileWithDialog(
  options: FileChooserOptions,
): Promise<string | null> {
  const { document, mount, locale } = options;
  const labels = chooserLabels[locale];
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0, 0, 0, 0.55)',
      zIndex: '1000',
      fontFamily: 'system-ui, sans-serif',
    });

    const panel = document.createElement('div');
    Object.assign(panel.style, {
      background: '#ffffff',
      color: '#1f2933',
      borderRadius: '8px',
      padding: '20px 24px',
      maxWidth: '420px',
      display: 'flex',
      flexDirection: 'column',
      gap: '16px',
    });

    const title = document.createElement('p');
    title.textContent = labels.title;
    Object.assign(title.style, {
      margin: '0',
      lineHeight: '1.5',
      fontSize: '16px',
    });

    const input = document.createElement('input');
    input.type = 'file';
    // The lens calibration app exports a ROS camera_info YAML document, and TurboWarp saves a list
    // export as `.txt`; an operator may have renamed it to `.yaml` for ROS tools. JSON is still read.
    // Camera Source decides which it is from the text, so the filter only has to let each through.
    input.setAttribute(
      'accept',
      options.accept ?? LENS_CALIBRATION_FILE_ACCEPT,
    );
    input.hidden = true;

    const buttons = document.createElement('div');
    Object.assign(buttons.style, {
      display: 'flex',
      gap: '8px',
      justifyContent: 'flex-end',
    });
    // Sized for an operator at a venue PC, not for a form: the stage is scaled to the window and the
    // browser's default button is a few pixels tall beside it.
    const buttonStyle = {
      font: 'inherit',
      fontSize: '16px',
      padding: '8px 16px',
      borderRadius: '6px',
    };
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = labels.cancel;
    Object.assign(cancel.style, buttonStyle);
    const choose = document.createElement('button');
    choose.type = 'button';
    choose.textContent = labels.choose;
    Object.assign(choose.style, buttonStyle, {
      background: '#2f6f4f',
      color: '#ffffff',
      border: '1px solid #2f6f4f',
    });

    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(value);
    };

    choose.addEventListener('click', () => input.click());
    cancel.addEventListener('click', () => finish(null));
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file === undefined) return;
      const read = options.read ?? ((chosen: File) => chosen.text());
      read(file).then(
        (text) => finish(text),
        () => finish(null),
      );
    });

    buttons.appendChild(cancel);
    buttons.appendChild(choose);
    panel.appendChild(title);
    panel.appendChild(buttons);
    panel.appendChild(input);
    overlay.appendChild(panel);
    mount.appendChild(overlay);
  });
}

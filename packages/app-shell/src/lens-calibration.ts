import type {ShellLocale} from './app-config.js';

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
 */
export type LensCalibrationAppState = '' | 'open' | 'closed' | 'unavailable' | 'blocked';

export interface LensCalibrationWindow {
  readonly closed: boolean;
  focus?(): void;
}

/** Everything the launcher needs from the browser, so the decisions can be tested without one. */
export interface LensCalibrationHost {
  /** The calibration app's URL on this origin, or `null` when the page has no such origin. */
  resolveUrl(): string | null;
  /** Whether the host actually serves it. A packaged build may carry no calibration app. */
  isServed(url: string): Promise<boolean>;
  openWindow(url: string, name: string): LensCalibrationWindow | null;
  /** Resolves to the chosen file's text, or `null` when the operator gave up. */
  chooseTextFile(): Promise<string | null>;
}

export class LensCalibrationLauncher {
  private readonly host: LensCalibrationHost;
  private window: LensCalibrationWindow | null = null;
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
  public async open(): Promise<LensCalibrationAppState> {
    if (this.window !== null && !this.window.closed) {
      this.window.focus?.();
      return this.settle('open');
    }
    const url = this.host.resolveUrl();
    if (url === null || !(await this.host.isServed(url).catch(() => false))) {
      return this.settle('unavailable');
    }
    const opened = this.host.openWindow(url, windowName);
    this.window = opened;
    return this.settle(opened === null ? 'blocked' : 'open');
  }

  /** The state as of now. A window the operator closed reads `closed` without another block call. */
  public state(): LensCalibrationAppState {
    if (this.lastState === 'open' && (this.window === null || this.window.closed)) {
      this.lastState = 'closed';
    }
    return this.lastState;
  }

  public isOpen(): boolean {
    return this.state() === 'open';
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

const chooserLabels: Readonly<Record<ShellLocale, ChooserLabels>> = {
  en: {
    title: 'Choose the lens calibration profile (JSON) for this camera.',
    choose: 'Choose file',
    cancel: 'Cancel'
  },
  ja: {
    title: 'このカメラのレンズ校正プロファイル（JSON）を選んでください。',
    choose: 'ファイルを選ぶ',
    cancel: 'やめる'
  }
};

export interface FileChooserOptions {
  readonly document: Document;
  readonly mount: HTMLElement;
  readonly locale: ShellLocale;
}

/**
 * Shows a small dialog whose button opens the browser's file picker.
 *
 * A block cannot open the picker by itself: it runs on the VM's frame timer, and a browser opens a
 * file dialog only from the operator's own click. The dialog supplies that click. Closing the picker
 * without a file keeps the dialog up, so the operator decides to give up rather than the browser.
 */
export function chooseTextFileWithDialog(options: FileChooserOptions): Promise<string | null> {
  const {document, mount, locale} = options;
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
      fontFamily: 'system-ui, sans-serif'
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
      gap: '16px'
    });

    const title = document.createElement('p');
    title.textContent = labels.title;
    Object.assign(title.style, {margin: '0', lineHeight: '1.5', fontSize: '16px'});

    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('accept', '.json,application/json');
    input.hidden = true;

    const buttons = document.createElement('div');
    Object.assign(buttons.style, {display: 'flex', gap: '8px', justifyContent: 'flex-end'});
    // Sized for an operator at a venue PC, not for a form: the stage is scaled to the window and the
    // browser's default button is a few pixels tall beside it.
    const buttonStyle = {font: 'inherit', fontSize: '16px', padding: '8px 16px', borderRadius: '6px'};
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
      border: '1px solid #2f6f4f'
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
      file.text().then(
        (text) => finish(text),
        () => finish(null)
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

/**
 * A full-screen panel that shows one QR code with a caption and operator buttons.
 *
 * The apps are stage-only projects, so the pairing extension's "show on this sprite" has nowhere to
 * draw. The panel shows the part it renders as an image instead. It sits over the whole window on
 * white, because the white margin around a code is part of the symbol, and it keeps the image square
 * and scaled without smoothing so a projector or a phone camera sees crisp modules.
 *
 * Buttons do not run anything. A press is counted and its label kept, and the SB3 script that owns
 * the exchange decides what the press means. That keeps the pairing flow in one place — the script
 * — instead of splitting it between blocks and callbacks.
 */

export interface QrPanelHost {
  readonly document: Document | null;
}

export interface QrPanel {
  /** Shows or replaces the panel. Refuses anything but an image data URI and reports whether it showed. */
  show(image: string, caption: string, buttons: readonly string[]): boolean;
  hide(): void;
  /** Increases on every press, so a script can tell two presses of the same button apart. */
  presses(): number;
  lastButton(): string;
  isShown(): boolean;
  dispose(): void;
}

const imagePattern = /^data:image\/(?:svg\+xml|png)[;,]/;

/** Splits a `|`-separated label list, dropping blanks so a trailing separator adds no button. */
export function parseButtonLabels(value: string): string[] {
  return value
    .split('|')
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
}

interface Mounted {
  readonly root: HTMLElement;
  readonly image: HTMLImageElement;
  readonly caption: HTMLElement;
  readonly buttons: HTMLElement;
}

export function createQrPanel(host: QrPanelHost): QrPanel {
  let mounted: Mounted | null = null;
  let pressCount = 0;
  let last = '';
  let renderedButtons = '';

  function mount(document: Document): Mounted {
    if (mounted !== null) return mounted;
    const root = document.createElement('div');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    Object.assign(root.style, {
      position: 'fixed',
      inset: '0',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '16px',
      background: '#ffffff',
      color: '#111111',
      zIndex: '1000',
      fontFamily: 'system-ui, sans-serif',
    });

    const image = document.createElement('img');
    image.alt = '';
    Object.assign(image.style, {
      width: 'min(78vmin, 78vw)',
      height: 'min(78vmin, 78vw)',
      objectFit: 'contain',
      imageRendering: 'pixelated',
    });

    const caption = document.createElement('p');
    Object.assign(caption.style, {
      margin: '0',
      fontSize: '20px',
      lineHeight: '1.4',
      textAlign: 'center',
      maxWidth: '90vw',
    });

    const buttons = document.createElement('div');
    Object.assign(buttons.style, {
      display: 'flex',
      gap: '12px',
      flexWrap: 'wrap',
    });

    root.appendChild(image);
    root.appendChild(caption);
    root.appendChild(buttons);
    document.body.appendChild(root);
    mounted = { root, image, caption, buttons };
    return mounted;
  }

  function renderButtons(
    document: Document,
    parts: Mounted,
    labels: readonly string[],
  ): void {
    // Rebuilt only when the set changes. Replacing a button under the operator's pointer between
    // mousedown and mouseup would swallow the click that advances to the next part.
    const key = labels.join('|');
    if (key === renderedButtons) return;
    renderedButtons = key;
    for (const child of [...parts.buttons.children]) child.remove();
    for (const label of labels) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      Object.assign(button.style, {
        font: 'inherit',
        fontSize: '18px',
        padding: '10px 20px',
        borderRadius: '8px',
      });
      button.addEventListener('click', () => {
        pressCount += 1;
        last = label;
      });
      parts.buttons.appendChild(button);
    }
  }

  return {
    show(image, caption, buttons) {
      const document = host.document;
      if (document === null || !imagePattern.test(image)) return false;
      const parts = mount(document);
      parts.image.src = image;
      parts.caption.textContent = caption;
      renderButtons(document, parts, buttons);
      return true;
    },
    hide() {
      mounted?.root.remove();
      mounted = null;
      renderedButtons = '';
    },
    presses: () => pressCount,
    lastButton: () => last,
    isShown: () => mounted !== null,
    dispose() {
      this.hide();
    },
  };
}

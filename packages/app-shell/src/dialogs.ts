/**
 * Small modal dialogs an SB3 script waits on: a confirmation and a numeric form.
 *
 * They sit above everything the apps put on screen, including the full-screen time pattern, because
 * the operator is asked for a decision or a measurement while the pattern may still be up.
 */

export interface DialogHost {
  readonly document: Document | null;
}

/** Above the time pattern overlay, which takes the top of the 32-bit range for itself. */
const DIALOG_Z_INDEX = '2147483600';

function overlay(document: Document): {root: HTMLElement; panel: HTMLElement} {
  const root = document.createElement('div');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  Object.assign(root.style, {
    position: 'fixed',
    inset: '0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0, 0, 0, 0.6)',
    zIndex: DIALOG_Z_INDEX,
    fontFamily: 'system-ui, sans-serif'
  });
  const panel = document.createElement('div');
  Object.assign(panel.style, {
    background: '#ffffff',
    color: '#1f2933',
    borderRadius: '8px',
    padding: '20px 24px',
    maxWidth: 'min(560px, 92vw)',
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
    fontSize: '16px',
    lineHeight: '1.5'
  });
  root.appendChild(panel);
  document.body.appendChild(root);
  return {root, panel};
}

function button(document: Document, label: string, primary: boolean): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  Object.assign(element.style, {
    font: 'inherit',
    padding: '8px 16px',
    borderRadius: '6px',
    ...(primary ? {background: '#2f6f4f', color: '#ffffff', border: '1px solid #2f6f4f'} : {})
  });
  return element;
}

function paragraph(document: Document, text: string): HTMLElement {
  const element = document.createElement('p');
  element.textContent = text;
  Object.assign(element.style, {margin: '0', whiteSpace: 'pre-wrap'});
  return element;
}

/** Resolves true only on the confirm button. Closing any other way is a refusal. */
export function confirmWithDialog(
  host: DialogHost,
  message: string,
  confirmLabel: string,
  cancelLabel: string
): Promise<boolean> {
  const document = host.document;
  if (document === null) return Promise.resolve(false);
  return new Promise((resolve) => {
    const {root, panel} = overlay(document);
    const buttons = document.createElement('div');
    Object.assign(buttons.style, {display: 'flex', gap: '8px', justifyContent: 'flex-end'});
    const cancel = button(document, cancelLabel, false);
    const confirm = button(document, confirmLabel, true);
    const finish = (value: boolean) => {
      root.remove();
      resolve(value);
    };
    cancel.addEventListener('click', () => finish(false));
    confirm.addEventListener('click', () => finish(true));
    buttons.appendChild(cancel);
    buttons.appendChild(confirm);
    panel.appendChild(paragraph(document, message));
    panel.appendChild(buttons);
  });
}

export interface FieldLayout {
  readonly labels: readonly string[];
  /** The separator that followed each field, '' after the last. */
  readonly separators: readonly string[];
}

/**
 * Splits a field specification on `,` and `;`, remembering which separator came where.
 *
 * The answer is written back with the same separators, so a script that asks for
 * `tl x,tl y;tr x,tr y` receives `0,0;1.6,0` and can hand it on without rebuilding it.
 */
export function parseFieldLayout(spec: string): FieldLayout {
  const labels: string[] = [];
  const separators: string[] = [];
  let current = '';
  for (const character of spec) {
    if (character === ',' || character === ';') {
      labels.push(current.trim());
      separators.push(character);
      current = '';
      continue;
    }
    current += character;
  }
  labels.push(current.trim());
  separators.push('');
  return {labels, separators};
}

export function joinWithLayout(layout: FieldLayout, values: readonly string[]): string {
  return values.map((value, index) => `${value}${layout.separators[index] ?? ''}`).join('');
}

/** Values of a previous answer in the same layout, or empty strings where there are none. */
export function defaultsFor(layout: FieldLayout, defaults: string): string[] {
  const values = parseFieldLayout(defaults).labels;
  return layout.labels.map((_, index) => values[index] ?? '');
}

/**
 * Asks for one finite number per field. Resolves the answer in the specification's layout, or null
 * when the operator cancels. The accept button stays disabled until every field holds a number, so
 * a half-filled measurement cannot reach the script.
 */
export function askNumbersWithDialog(
  host: DialogHost,
  title: string,
  spec: string,
  defaults: string,
  labels: {readonly accept: string; readonly cancel: string}
): Promise<string | null> {
  const document = host.document;
  if (document === null) return Promise.resolve(null);
  const layout = parseFieldLayout(spec);
  const initial = defaultsFor(layout, defaults);
  return new Promise((resolve) => {
    const {root, panel} = overlay(document);
    panel.appendChild(paragraph(document, title));

    const grid = document.createElement('div');
    Object.assign(grid.style, {
      display: 'grid',
      gridTemplateColumns: 'auto 1fr',
      gap: '6px 12px',
      alignItems: 'center'
    });
    const inputs = layout.labels.map((labelText, index) => {
      const label = document.createElement('label');
      label.textContent = labelText;
      const input = document.createElement('input');
      input.type = 'number';
      input.setAttribute('step', 'any');
      input.value = initial[index] ?? '';
      Object.assign(input.style, {font: 'inherit', padding: '4px 6px'});
      grid.appendChild(label);
      grid.appendChild(input);
      return input;
    });
    panel.appendChild(grid);

    const buttons = document.createElement('div');
    Object.assign(buttons.style, {display: 'flex', gap: '8px', justifyContent: 'flex-end'});
    const cancel = button(document, labels.cancel, false);
    const accept = button(document, labels.accept, true);
    const values = () => inputs.map((input) => String(input.value).trim());
    const complete = () => values().every((value) => value !== '' && Number.isFinite(Number(value)));
    const refresh = () => {
      accept.disabled = !complete();
    };
    for (const input of inputs) input.addEventListener('input', refresh);
    refresh();

    const finish = (value: string | null) => {
      root.remove();
      resolve(value);
    };
    cancel.addEventListener('click', () => finish(null));
    accept.addEventListener('click', () => {
      if (!complete()) return;
      finish(joinWithLayout(layout, values()));
    });
    buttons.appendChild(cancel);
    buttons.appendChild(accept);
    panel.appendChild(buttons);
  });
}

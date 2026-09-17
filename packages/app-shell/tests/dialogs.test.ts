import {describe, expect, it} from 'vitest';

import {
  askNumbersWithDialog,
  confirmWithDialog,
  defaultsFor,
  joinWithLayout,
  parseFieldLayout
} from '../src/dialogs.js';
import {fakeDocument, findByText, type FakeElement} from './fake-dom.js';

function inputsOf(element: FakeElement): FakeElement[] {
  return [
    ...(element.tagName === 'input' ? [element] : []),
    ...element.children.flatMap((child) => inputsOf(child))
  ];
}

describe('field layout', () => {
  it('keeps the separators so the answer has the shape that was asked for', () => {
    const layout = parseFieldLayout('tl x,tl y;tr x,tr y');
    expect(layout.labels).toEqual(['tl x', 'tl y', 'tr x', 'tr y']);
    expect(joinWithLayout(layout, ['0', '0', '1.6', '0.01'])).toBe('0,0;1.6,0.01');
  });

  it('fills defaults by position and leaves the rest empty', () => {
    expect(defaultsFor(parseFieldLayout('a,b;c'), '1,2')).toEqual(['1', '2', '']);
  });
});

describe('confirmWithDialog', () => {
  it('resolves true only from the confirm button', async () => {
    const document = fakeDocument();
    const body = document.body as unknown as FakeElement;
    const accepted = confirmWithDialog({document}, 'Flashes. Continue?', '表示する', 'やめる');
    findByText(body, '表示する')[0]?.click();
    await expect(accepted).resolves.toBe(true);
    expect(body.children).toHaveLength(0);

    const refused = confirmWithDialog({document}, 'Flashes. Continue?', '表示する', 'やめる');
    findByText(body, 'やめる')[0]?.click();
    await expect(refused).resolves.toBe(false);
  });

  it('refuses without a document', async () => {
    await expect(confirmWithDialog({document: null}, 'x', 'y', 'z')).resolves.toBe(false);
  });
});

describe('askNumbersWithDialog', () => {
  const labels = {accept: '決定', cancel: 'やめる'};

  it('keeps accept disabled until every field is a number, then answers in layout', async () => {
    const document = fakeDocument();
    const body = document.body as unknown as FakeElement;
    const answer = askNumbersWithDialog({document}, 'corners', 'x,y;z', '0.5', labels);
    const accept = findByText(body, '決定')[0];
    expect(accept?.disabled).toBe(true);

    const [x, y, z] = inputsOf(body);
    expect(x?.value).toBe('0.5');
    (y as unknown as {value: string}).value = '1.25';
    (z as unknown as {value: string}).value = 'abc';
    accept?.click();
    expect(body.children).toHaveLength(1);

    (z as unknown as {value: string}).value = '-2';
    accept?.click();
    await expect(answer).resolves.toBe('0.5,1.25;-2');
    expect(body.children).toHaveLength(0);
  });

  it('answers null when cancelled', async () => {
    const document = fakeDocument();
    const body = document.body as unknown as FakeElement;
    const answer = askNumbersWithDialog({document}, 'corners', 'x', '', labels);
    findByText(body, 'やめる')[0]?.click();
    await expect(answer).resolves.toBeNull();
  });
});

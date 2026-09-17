import { describe, expect, it } from 'vitest';

import { createQrPanel, parseButtonLabels } from '../src/qr-panel.js';
import { fakeDocument, findByText } from './fake-dom.js';
import type { FakeElement } from './fake-dom.js';

const svg = 'data:image/svg+xml;base64,PHN2Zy8+';

function panel() {
  const document = fakeDocument();
  const body = document.body as unknown as FakeElement;
  return { qr: createQrPanel({ document }), body };
}

describe('parseButtonLabels', () => {
  it('splits on | and drops blank labels', () => {
    expect(parseButtonLabels('次のQR| やめる |')).toEqual(['次のQR', 'やめる']);
    expect(parseButtonLabels('')).toEqual([]);
  });
});

describe('createQrPanel', () => {
  it('shows an image data URI with its caption and buttons', () => {
    const { qr, body } = panel();

    expect(qr.show(svg, 'Offer 1 / 2', ['次のQR', 'やめる'])).toBe(true);

    expect(qr.isShown()).toBe(true);
    expect(body.children).toHaveLength(1);
    expect(findByText(body, 'Offer 1 / 2')).toHaveLength(1);
    expect(findByText(body, '次のQR')).toHaveLength(1);
  });

  it('refuses anything that is not an image data URI', () => {
    const { qr, body } = panel();

    expect(qr.show('https://example.com/qr.svg', '', [])).toBe(false);
    expect(qr.show('javascript:alert(1)', '', [])).toBe(false);
    expect(body.children).toHaveLength(0);
  });

  it('replaces the image in place and keeps the same buttons', () => {
    const { qr, body } = panel();
    qr.show(svg, 'Offer 1 / 2', ['次のQR']);
    const button = findByText(body, '次のQR')[0];

    qr.show('data:image/png;base64,AAAA', 'Offer 2 / 2', ['次のQR']);

    expect(body.children).toHaveLength(1);
    expect(findByText(body, 'Offer 2 / 2')).toHaveLength(1);
    expect(findByText(body, '次のQR')[0]).toBe(button);
  });

  it('counts every press and keeps the label pressed last', () => {
    const { qr, body } = panel();
    qr.show(svg, '', ['次のQR', 'やめる']);

    findByText(body, '次のQR')[0]?.click();
    findByText(body, '次のQR')[0]?.click();
    findByText(body, 'やめる')[0]?.click();

    expect(qr.presses()).toBe(3);
    expect(qr.lastButton()).toBe('やめる');
  });

  it('removes itself on hide and can be shown again', () => {
    const { qr, body } = panel();
    qr.show(svg, '', ['やめる']);

    qr.hide();
    expect(qr.isShown()).toBe(false);
    expect(body.children).toHaveLength(0);

    qr.show(svg, '', ['やめる']);
    expect(findByText(body, 'やめる')).toHaveLength(1);
  });
});

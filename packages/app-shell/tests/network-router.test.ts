import { describe, expect, it } from 'vitest';

import { NetworkRouter, type WebRtcQueuePort } from '../src/network-router.js';

function envelope(
  type: string,
  peer: string,
  payload: unknown,
  channel = 'default',
): string {
  return JSON.stringify({
    version: 1,
    id: `${type}-${Math.random()}`,
    seq: 1,
    from: 'x',
    channel,
    type,
    payload,
    timestamp: 0,
    peer,
  });
}

function setup(messages: string[], now = { value: 1000 }) {
  const queue: WebRtcQueuePort = {
    messageCount: () => messages.length,
    nextMessage: () => messages.shift() ?? '',
  };
  let loaded = true;
  const router = new NetworkRouter({
    webrtc: () => (loaded ? queue : null),
    nowMs: () => now.value,
  });
  return { router, messages, now, unload: () => (loaded = false) };
}

describe('NetworkRouter', () => {
  it('drains the whole queue in one call', () => {
    const { router, messages } = setup([
      envelope('latest-data', 'camera-1', { sequence: 1 }, 'pose'),
      envelope('twrmc-sync-start', 'fusion', {}),
      envelope('latest-data', 'camera-1', { sequence: 2 }, 'pose'),
    ]);
    expect(router.pump()).toBe(3);
    expect(messages).toHaveLength(0);
  });

  it('keeps only the newest latest-data payload per channel and peer, and counts them all', () => {
    const { router } = setup([
      envelope('latest-data', 'camera-1', { sequence: 1 }, 'pose'),
      envelope('latest-data', 'camera-2', { sequence: 7 }, 'pose'),
      envelope('latest-data', 'camera-1', { sequence: 2 }, 'pose'),
    ]);
    router.pump();
    expect(router.latestPayload('pose', 'camera-1')).toBe('{"sequence":2}');
    expect(router.latestCount('pose', 'camera-1')).toBe(2);
    expect(router.latestPayload('pose', 'camera-2')).toBe('{"sequence":7}');
    expect(router.latestPeers('pose')).toEqual(['camera-1', 'camera-2']);
    expect(router.queuedCount()).toBe(0);
  });

  it('keeps every other message in arrival order', () => {
    const first = envelope('twrmc-link-test', 'fusion', { n: 1 });
    const second = envelope('twrmc-sync-start', 'fusion', { n: 2 });
    const { router } = setup([
      first,
      envelope('latest-data', 'camera-1', {}, 'pose'),
      second,
    ]);
    router.pump();
    expect(router.queuedCount()).toBe(2);
    expect(router.next()).toBe(first);
    expect(router.next()).toBe(second);
    expect(router.next()).toBe('');
  });

  it('reports how old the newest payload is, and -1 before any arrives', () => {
    const now = { value: 1000 };
    const { router, messages } = setup([], now);
    expect(router.latestAgeMs('pose', 'camera-1')).toBe(-1);
    messages.push(envelope('latest-data', 'camera-1', {}, 'pose'));
    router.pump();
    now.value = 1250;
    expect(router.latestAgeMs('pose', 'camera-1')).toBe(250);
  });

  it('bounds the control queue and counts what it had to drop', () => {
    const messages = Array.from({ length: 205 }, (_, index) =>
      envelope('event', 'fusion', { index }),
    );
    const { router } = setup(messages);
    router.pump();
    expect(router.queuedCount()).toBe(200);
    expect(router.droppedCount()).toBe(5);
    expect(JSON.parse(router.next()).payload).toEqual({ index: 5 });
  });

  it('passes an unparseable message through rather than losing it, and does nothing without WebRTC', () => {
    const { router, unload, messages } = setup(['not json']);
    router.pump();
    expect(router.next()).toBe('not json');
    unload();
    messages.push(envelope('event', 'fusion', {}));
    expect(router.pump()).toBe(0);
    expect(messages).toHaveLength(1);
  });
});

describe('createScratchNetworkRouterHost', () => {
  it('finds the WebRTC queue blocks inside a static bundle and on their own', async () => {
    const { createScratchNetworkRouterHost } =
      await import('../src/network-router.js');
    const scratch =
      (
        globalThis as {
          Scratch?: { vm?: { runtime?: Record<string, unknown> } };
        }
      ).Scratch ?? {};
    (globalThis as Record<string, unknown>)['Scratch'] = scratch;
    const messages = ['a', 'b'];
    for (const prefix of [
      'realtimemotioncapturefusionapp_kubohiroyawebrtc__',
      'kubohiroyawebrtc_',
    ]) {
      messages.splice(0, messages.length, 'a', 'b');
      scratch.vm = {
        runtime: {
          _primitives: {
            [`${prefix}messageCount`]: () => messages.length,
            [`${prefix}nextMessage`]: () => messages.shift() ?? '',
            [`${prefix}lastMessage`]: () => 'ignored',
          },
        },
      };
      const host = createScratchNetworkRouterHost();
      expect(host.webrtc()?.messageCount()).toBe(2);
      expect(host.webrtc()?.nextMessage()).toBe('a');
    }
    scratch.vm = { runtime: { _primitives: {} } };
    expect(createScratchNetworkRouterHost().webrtc()).toBeNull();
  });
});

import {describe, expect, it} from 'vitest';

import {Pose3dServiceClient, type ClientClock, type ServicePort} from '../src/client.js';
import {LIMITS} from '../src/contracts.js';
import {Pose3dService} from '../src/service.js';
import {configuration, frame} from './fixtures.js';

/** A clock whose timers only fire when the test advances it. */
function manualClock() {
  let now = 0;
  const timers = new Map<number, {at: number; callback: () => void}>();
  let next = 1;
  const clock: ClientClock = {
    nowMs: () => now,
    setTimeout: (callback, ms) => {
      const id = next++;
      timers.set(id, {at: now + ms, callback});
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    }
  };
  const advance = async (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.callback();
      }
    }
    await flush();
  };
  return {clock, advance};
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The real service behind an asynchronous in-process port, standing in for the Worker. */
function servicePort(options: {mutate?: (message: unknown) => unknown} = {}) {
  const service = new Pose3dService();
  let listener: (message: unknown) => void = () => undefined;
  let failure: (reason: string) => void = () => undefined;
  const sent: string[] = [];
  const port: ServicePort = {
    post: (message) => {
      sent.push(message.type);
      queueMicrotask(() => {
        const reply = service.handle(JSON.parse(JSON.stringify(message)));
        if (reply !== null) listener(options.mutate ? options.mutate(reply) : reply);
      });
    },
    onMessage: (next) => {
      listener = next;
    },
    onFailure: (next) => {
      failure = next;
    },
    close: () => undefined
  };
  return {port, sent, fail: (reason: string) => failure(reason)};
}

async function configured(implementation: Parameters<typeof configuration>[0] = 'stub-normal', mutate?: (message: unknown) => unknown) {
  const {clock, advance} = manualClock();
  const {port, sent, fail} = servicePort(mutate ? {mutate} : {});
  const client = new Pose3dServiceClient(port, clock);
  await client.configure(configuration(implementation));
  return {client, advance, sent, fail};
}

const send = (client: Pose3dServiceClient, sequence: number, age = 10) => {
  client.sendFrame('camera-1', JSON.stringify(frame('camera-1', 'cal-1', sequence)), age);
  client.sendFrame('camera-2', JSON.stringify(frame('camera-2', 'cal-2', sequence)), age);
};

describe('Pose3dServiceClient', () => {
  it('configures, forwards frames and reports a validated 3D frame', async () => {
    const {client} = await configured();
    expect(client.status().state).toBe('ready');
    send(client, 1);
    await flush();
    await client.requestPose3d();
    expect(client.latestFrame()?.persons).toHaveLength(2);
    expect(client.status()).toMatchObject({state: 'ready', framesSent: 2, framesRejected: 0, persons: 2});
  });

  it('forwards the capture timestamp unchanged', async () => {
    const {client} = await configured();
    send(client, 7);
    await flush();
    await client.requestPose3d();
    expect(client.latestFrame()?.timestampUs).toBe(frame('camera-1', 'cal-1', 7).captureTimestampUs);
  });

  it('does not forward a repeat, a stale frame, an invalid frame or another calibration', async () => {
    const {client, sent} = await configured();
    send(client, 1);
    send(client, 1);
    client.sendFrame('camera-1', JSON.stringify(frame('camera-1', 'cal-1', 2)), LIMITS.maxFrameAgeMs + 1);
    client.sendFrame('camera-1', '{"schema":"twrmc/pose-frame-2d"}', 0);
    client.sendFrame('camera-2', JSON.stringify(frame('camera-2', 'cal-1', 3)), 0);
    expect(sent.filter((type) => type === 'frame2d')).toHaveLength(2);
    expect(client.status()).toMatchObject({framesSent: 2, framesStale: 1, framesInvalid: 2});
  });

  it('withholds the 3D frame after a timeout, and recovers when answers return', async () => {
    const {client, advance} = await configured('stub-timeout');
    send(client, 1);
    const waiting = client.requestPose3d();
    await advance(LIMITS.requestTimeoutMs);
    await waiting;
    expect(client.latestFrame()).toBeUndefined();
    expect(client.status()).toMatchObject({state: 'degraded', errorCode: 'timeout', consecutiveTimeouts: 1});
  });

  it('withholds the 3D frame when the answer breaks the contract', async () => {
    const {client} = await configured('stub-invalid');
    send(client, 1);
    await flush();
    await client.requestPose3d();
    expect(client.latestFrame()).toBeUndefined();
    expect(client.status()).toMatchObject({state: 'degraded', errorCode: 'invalid-response'});
  });

  it('clears the last good frame once a later answer is invalid', async () => {
    let corrupt = false;
    const {client} = await configured('stub-normal', (reply) => {
      const message = reply as {type: string; payload: {persons?: unknown[]} | null};
      return corrupt && message.type === 'pose3d' && message.payload ? {...message, payload: {...message.payload, persons: 'none'}} : reply;
    });
    send(client, 1);
    await flush();
    await client.requestPose3d();
    expect(client.latestFrame()).toBeDefined();
    corrupt = true;
    await client.requestPose3d();
    expect(client.latestFrame()).toBeUndefined();
  });

  it('refuses a configuration before sending it and stops on a worker failure', async () => {
    const {clock} = manualClock();
    const {port, sent, fail} = servicePort();
    const client = new Pose3dServiceClient(port, clock);
    await client.configure({...configuration(), cameras: []});
    expect(sent).toEqual([]);
    expect(client.status()).toMatchObject({state: 'error', errorCode: 'invalid-payload'});
    await client.configure(configuration());
    fail('boom');
    expect(client.status()).toMatchObject({state: 'error', errorCode: 'worker-failed'});
  });

  it('times out a configuration nobody answers', async () => {
    const {clock, advance} = manualClock();
    const port: ServicePort = {post: () => undefined, onMessage: () => undefined, onFailure: () => undefined, close: () => undefined};
    const client = new Pose3dServiceClient(port, clock);
    const waiting = client.configure(configuration());
    await advance(LIMITS.configureTimeoutMs);
    await waiting;
    expect(client.status()).toMatchObject({state: 'error', errorCode: 'timeout'});
  });
});

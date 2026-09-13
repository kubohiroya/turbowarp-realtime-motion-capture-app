import {mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  acquireRunLock,
  findPortHolder,
  type AcquireRunLockOptions,
  type RunLockRecord
} from '../src/run-lock.ts';

let directory: string;
let clock: number;

const alive = new Set<number>();
const boundPorts = new Set<number>();

function environment(overrides: Partial<AcquireRunLockOptions> = {}) {
  return {
    directory,
    now: () => new Date(clock),
    isProcessAlive: (pid: number) => alive.has(pid),
    isPortBound: async (port: number) => boundPorts.has(port),
    ...overrides
  };
}

/** Starts a host: it holds the lock, its process runs, and its port is bound. */
async function startHost(app: string, port: number, pid: number) {
  alive.add(pid);
  boundPorts.add(port);
  const result = await acquireRunLock({...environment(), app, port, pid});
  if (!result.acquired) throw new Error(`${app} could not take its lock`);
  return result.lock;
}

async function writeRawLock(app: string, contents: string) {
  await writeFile(join(directory, `${app}.lock`), contents);
}

async function lockFiles() {
  return (await readdir(directory)).filter((name) => name.endsWith('.lock')).sort();
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'multiview-pose-run-lock-'));
  clock = Date.UTC(2026, 0, 1, 9, 0, 0);
  alive.clear();
  boundPorts.clear();
});

afterEach(async () => {
  await rm(directory, {force: true, recursive: true});
});

describe('acquireRunLock', () => {
  it('records what the host is', async () => {
    alive.add(100);
    const result = await acquireRunLock({...environment(), app: 'camera-app', port: 49711, pid: 100});

    expect(result.acquired).toBe(true);
    expect(result.acquired && result.lock.record).toEqual({
      app: 'camera-app',
      port: 49711,
      origin: 'http://127.0.0.1:49711',
      pid: 100,
      startedAt: '2026-01-01T09:00:00.000Z'
    });
    expect(await lockFiles()).toEqual(['camera-app.lock']);
  });

  it('writes the record as readable JSON without a token', async () => {
    await startHost('camera-app', 49711, 100);
    const contents = await readFile(join(directory, 'camera-app.lock'), 'utf8');
    const record = JSON.parse(contents) as RunLockRecord & {token?: string};

    expect(record.app).toBe('camera-app');
    expect(record.token).toBeUndefined();
    expect(contents.endsWith('\n')).toBe(true);
  });

  it('creates the lock directory when it does not exist yet', async () => {
    alive.add(100);
    const nested = join(directory, 'nested', 'runtime');
    const result = await acquireRunLock({
      ...environment({directory: nested}),
      app: 'camera-app',
      port: 49711,
      pid: 100
    });

    expect(result.acquired).toBe(true);
  });

  it('refuses to start a second instance of the same application', async () => {
    await startHost('camera-app', 49711, 100);

    const second = await acquireRunLock({...environment(), app: 'camera-app', port: 49711, pid: 200});

    expect(second.acquired).toBe(false);
    expect(second.acquired === false && second.holder).toMatchObject({pid: 100, app: 'camera-app'});
  });

  it('replaces a lock whose process is gone', async () => {
    await startHost('camera-app', 49711, 100);
    alive.delete(100);
    boundPorts.delete(49711);

    alive.add(200);
    const second = await acquireRunLock({...environment(), app: 'camera-app', port: 49711, pid: 200});

    expect(second.acquired).toBe(true);
    expect(second.acquired && second.lock.record.pid).toBe(200);
  });

  it('replaces a lock whose port is free, even when the process id is reused', async () => {
    await startHost('camera-app', 49711, 100);
    boundPorts.delete(49711);

    const second = await acquireRunLock({...environment(), app: 'camera-app', port: 49711, pid: 100});

    expect(second.acquired).toBe(true);
  });

  it('replaces a lock that cannot be parsed', async () => {
    await writeRawLock('camera-app', 'not json');
    alive.add(200);

    const result = await acquireRunLock({...environment(), app: 'camera-app', port: 49711, pid: 200});

    expect(result.acquired).toBe(true);
  });

  it('replaces a lock that is missing a field', async () => {
    await writeRawLock('camera-app', JSON.stringify({app: 'camera-app', pid: 100}));
    alive.add(200);

    const result = await acquireRunLock({...environment(), app: 'camera-app', port: 49711, pid: 200});

    expect(result.acquired).toBe(true);
  });

  it('rejects an application id that would escape the lock directory', async () => {
    await expect(
      acquireRunLock({...environment(), app: '../escape', port: 49711, pid: 100})
    ).rejects.toThrow(/Unsafe application id/);
  });
});

describe('release', () => {
  it('removes the lock', async () => {
    const lock = await startHost('camera-app', 49711, 100);
    await lock.release();

    expect(await lockFiles()).toEqual([]);
  });

  it('leaves a lock another host has taken over', async () => {
    const first = await startHost('camera-app', 49711, 100);
    alive.delete(100);
    boundPorts.delete(49711);
    await startHost('camera-app', 49711, 200);

    await first.release();

    expect(await lockFiles()).toEqual(['camera-app.lock']);
    const record = JSON.parse(await readFile(join(directory, 'camera-app.lock'), 'utf8')) as RunLockRecord;
    expect(record.pid).toBe(200);
  });

  it('is safe to call twice', async () => {
    const lock = await startHost('camera-app', 49711, 100);
    await lock.release();
    await expect(lock.release()).resolves.toBeUndefined();
  });
});

describe('findPortHolder', () => {
  it('names the other application holding the port', async () => {
    await startHost('fusion-app', 49711, 300);

    const holder = await findPortHolder({...environment(), port: 49711, app: 'camera-app'});

    expect(holder.kind).toBe('application');
    expect(holder.kind !== 'unknown' && holder.record).toMatchObject({app: 'fusion-app', pid: 300});
  });

  it('reports the asking application as itself', async () => {
    await startHost('camera-app', 49711, 100);

    const holder = await findPortHolder({...environment(), port: 49711, app: 'camera-app'});

    expect(holder.kind).toBe('self');
  });

  it('reports an unrelated program when no lock claims the port', async () => {
    boundPorts.add(49711);

    const holder = await findPortHolder({...environment(), port: 49711, app: 'camera-app'});

    expect(holder).toEqual({kind: 'unknown'});
  });

  it('does not attribute the port to an application whose run has ended', async () => {
    await startHost('fusion-app', 49711, 300);
    alive.delete(300);

    const holder = await findPortHolder({...environment(), port: 49711, app: 'camera-app'});

    expect(holder).toEqual({kind: 'unknown'});
    expect(await lockFiles()).toEqual([]);
  });

  it('ignores an application holding a different port', async () => {
    await startHost('fusion-app', 49712, 300);

    const holder = await findPortHolder({...environment(), port: 49711, app: 'camera-app'});

    expect(holder).toEqual({kind: 'unknown'});
    expect(await lockFiles()).toEqual(['fusion-app.lock']);
  });

  it('finds the holder among several running applications', async () => {
    await startHost('camera-app', 49711, 100);
    await startHost('fusion-app', 49712, 300);

    const holder = await findPortHolder({...environment(), port: 49712, app: 'camera-app'});

    expect(holder.kind !== 'unknown' && holder.record.app).toBe('fusion-app');
  });

  it('removes an unreadable lock while scanning', async () => {
    await writeRawLock('camera-app', '{');

    const holder = await findPortHolder({...environment(), port: 49711, app: 'fusion-app'});

    expect(holder).toEqual({kind: 'unknown'});
    expect(await lockFiles()).toEqual([]);
  });

  it('ignores files that are not locks', async () => {
    await writeFile(join(directory, 'notes.txt'), 'ignored');
    await startHost('fusion-app', 49711, 300);

    const holder = await findPortHolder({...environment(), port: 49711, app: 'camera-app'});

    expect(holder.kind).toBe('application');
  });

  it('reports an unrelated program when the lock directory does not exist', async () => {
    const holder = await findPortHolder({
      ...environment({directory: join(directory, 'missing')}),
      port: 49711
    });

    expect(holder).toEqual({kind: 'unknown'});
  });
});

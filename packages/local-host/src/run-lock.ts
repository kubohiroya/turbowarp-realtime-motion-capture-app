import { createServer } from 'node:net';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';

/**
 * Run locks that say exactly which application holds a loopback port.
 *
 * "Port in use" alone does not tell an operator what to do next: returning to an already running
 * window, fixing a duplicated port assignment, and stopping an unrelated program are three different
 * actions. A running host therefore records what it is, and a host that cannot bind reads those
 * records rather than guessing. When no record claims the port, the answer stays "some other
 * program" — naming one of our applications without a record to prove it would be the guess this
 * mechanism exists to remove.
 */
export interface RunLockRecord {
  readonly app: string;
  readonly port: number;
  readonly origin: string;
  readonly pid: number;
  readonly startedAt: string;
}

export interface RunLockEnvironment {
  /** Directory holding one `<app>.lock` per running host. */
  readonly directory: string | URL;
  readonly pid?: number;
  readonly now?: () => Date;
  /** Whether a process id is still running. */
  readonly isProcessAlive?: (pid: number) => boolean;
  /** Whether something is listening on a loopback port. */
  readonly isPortBound?: (port: number) => Promise<boolean>;
}

export interface AcquireRunLockOptions extends RunLockEnvironment {
  readonly app: string;
  readonly port: number;
}

export interface RunLock {
  readonly record: RunLockRecord;
  /** Removes the lock, unless another host has already replaced it. */
  release(): Promise<void>;
}

export type AcquireRunLockResult =
  | { readonly acquired: true; readonly lock: RunLock }
  | { readonly acquired: false; readonly holder: RunLockRecord };

export type PortHolder =
  | { readonly kind: 'self'; readonly record: RunLockRecord }
  | { readonly kind: 'application'; readonly record: RunLockRecord }
  | { readonly kind: 'unknown' };

const lockSuffix = '.lock';
/** Matches the application ids this repository uses, and keeps a lock name inside one path segment. */
const appPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // A live process owned by another user answers EPERM rather than ESRCH.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function defaultIsPortBound(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code === 'EADDRINUSE');
    });
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve(false));
    });
  });
}

function lockUrl(directory: string | URL, app: string): URL {
  if (!appPattern.test(app))
    throw new TypeError(`Unsafe application id for a run lock: ${app}`);
  const base =
    typeof directory === 'string' ? new URL(`file://${directory}/`) : directory;
  return new URL(`${app}${lockSuffix}`, base);
}

function parseRecord(contents: string): RunLockRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { app, port, origin, pid, startedAt } =
    parsed as Partial<RunLockRecord>;
  if (
    typeof app !== 'string' ||
    typeof origin !== 'string' ||
    typeof startedAt !== 'string' ||
    typeof port !== 'number' ||
    typeof pid !== 'number' ||
    !Number.isSafeInteger(port) ||
    !Number.isSafeInteger(pid)
  ) {
    return null;
  }
  return { app, port, origin, pid, startedAt };
}

/**
 * A lock counts as live only when its process is running *and* its port is bound.
 *
 * A process id on its own is not enough because ids are reused, and a bound port on its own is not
 * enough because an unrelated program may have taken it after a crash. Requiring both turns a
 * leftover file from a previous run into a stale lock instead of a false "already running".
 */
async function isLive(
  record: RunLockRecord,
  environment: RunLockEnvironment,
): Promise<boolean> {
  const isProcessAlive = environment.isProcessAlive ?? defaultIsProcessAlive;
  const isPortBound = environment.isPortBound ?? defaultIsPortBound;
  if (!isProcessAlive(record.pid)) return false;
  return await isPortBound(record.port);
}

async function readLock(url: URL): Promise<RunLockRecord | null> {
  const contents = await readFile(url, 'utf8').catch(() => null);
  if (contents === null) return null;
  return parseRecord(contents);
}

/** Takes the lock for one application, replacing a lock left behind by a previous run. */
export async function acquireRunLock(
  options: AcquireRunLockOptions,
): Promise<AcquireRunLockResult> {
  const { app, port } = options;
  const url = lockUrl(options.directory, app);
  const now = options.now ?? (() => new Date());
  const record: RunLockRecord = {
    app,
    port,
    origin: `http://127.0.0.1:${port}`,
    pid: options.pid ?? process.pid,
    startedAt: now().toISOString(),
  };
  const contents = `${JSON.stringify(record, null, 2)}\n`;

  await mkdir(new URL('./', url), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(url, contents, { flag: 'wx' });
      return { acquired: true, lock: createLock(url, record) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const existing = await readLock(url);
    if (existing !== null && (await isLive(existing, options))) {
      return { acquired: false, holder: existing };
    }
    await rm(url, { force: true });
  }
  throw new Error(`Could not take the run lock for ${app}.`);
}

function createLock(url: URL, record: RunLockRecord): RunLock {
  return {
    record,
    async release() {
      // Only remove our own record: a host that replaced a stale lock owns the file now.
      const current = await readLock(url);
      if (current !== null && current.pid !== record.pid) return;
      await rm(url, { force: true });
    },
  };
}

export interface FindPortHolderOptions extends RunLockEnvironment {
  readonly port: number;
  /** The application asking, so its own lock is reported as `self`. */
  readonly app?: string;
}

/**
 * Names the application holding a port, or reports that no application of ours claims it.
 *
 * Stale locks are removed while scanning, so a crashed run cannot keep accusing itself.
 */
export async function findPortHolder(
  options: FindPortHolderOptions,
): Promise<PortHolder> {
  const base =
    typeof options.directory === 'string'
      ? new URL(`file://${options.directory}/`)
      : options.directory;
  const names = await readdir(base).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.endsWith(lockSuffix)) continue;
    const url = new URL(name, base);
    const record = await readLock(url);
    if (record === null) {
      await rm(url, { force: true });
      continue;
    }
    if (record.port !== options.port) continue;
    if (!(await isLive(record, options))) {
      await rm(url, { force: true });
      continue;
    }
    return {
      kind: record.app === options.app ? 'self' : 'application',
      record,
    };
  }
  return { kind: 'unknown' };
}

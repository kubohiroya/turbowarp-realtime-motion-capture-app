import {createServer} from 'node:net';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {startLocalHost, type StartedLocalHost} from '../src/host.ts';

/**
 * A watcher that never opens its watch, standing in for an operating system that drops the write.
 *
 * On macOS a write made while a watch is still being registered is never reported, which is exactly
 * what the host's startup re-reads exist to survive. That drop cannot be provoked on demand, so the
 * watch is left unopened instead: nothing here can publish except a re-read of the file.
 */
vi.mock('@kubohiroya/turbowarp-local-preview', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kubohiroya/turbowarp-local-preview')>();
  return {
    ...actual,
    createStableSourceWatcher: (options: Parameters<typeof actual.createStableSourceWatcher>[0]) => {
      const watcher = actual.createStableSourceWatcher(options);
      return {
        sourcePath: watcher.sourcePath,
        start: () => undefined,
        publishNow: () => watcher.publishNow(),
        close: () => watcher.close()
      };
    }
  };
});

const playerHtml = '<!doctype html><title>player</title><body>packaged player';

let directory: string;
let running: StartedLocalHost[] = [];

async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      const {port} = address;
      server.close(() => resolve(port));
    });
  });
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'multiview-pose-recheck-'));
});

afterEach(async () => {
  await Promise.all(running.map((host) => host.stop()));
  running = [];
});

describe('startup re-reads', () => {
  it('publishes an edit the watch never reported', async () => {
    const path = join(directory, 'show.yaml');
    await writeFile(path, 'performers: 1');
    const result = await startLocalHost({
      app: 'camera-app',
      title: 'Camera App',
      port: await freePort(),
      lockDirectory: join(directory, 'run'),
      player: {html: playerHtml},
      dsl: {projectRoot: directory, path}
    });
    if (!result.started) throw new Error('did not start');
    running.push(result.host);
    expect(result.host.dsl()).toMatchObject({source: 'performers: 1'});

    await writeFile(path, 'performers: 2');

    const deadline = Date.now() + 4000;
    while (result.host.dsl()?.source !== 'performers: 2' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(result.host.dsl()).toMatchObject({source: 'performers: 2'});
  });

  it('stops re-reading once the host is stopped', async () => {
    const path = join(directory, 'show.yaml');
    await writeFile(path, 'performers: 1');
    const result = await startLocalHost({
      app: 'camera-app',
      title: 'Camera App',
      port: await freePort(),
      lockDirectory: join(directory, 'run'),
      player: {html: playerHtml},
      dsl: {projectRoot: directory, path}
    });
    if (!result.started) throw new Error('did not start');

    await result.host.stop();
    await writeFile(path, 'performers: 2');
    await new Promise((resolve) => setTimeout(resolve, 2500));

    expect(result.host.dsl()).toMatchObject({source: 'performers: 1'});
  });
});

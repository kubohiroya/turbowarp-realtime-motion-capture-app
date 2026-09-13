import {createServer, type Server} from 'node:net';

import {afterEach, describe, expect, it} from 'vitest';

import {defaultIsPortBound, defaultIsProcessAlive} from '../src/run-lock.ts';

/**
 * The other suite injects both probes, so these cover the real ones.
 *
 * They are the whole mechanism: if `defaultIsPortBound` were wrong, every liveness answer would be
 * wrong with it, and a stale lock would either be honoured forever or cleared while a host was
 * running.
 */
let servers: Server[] = [];

function listen(port = 0): Promise<number> {
  const server = createServer();
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no port assigned'));
        return;
      }
      resolve(address.port);
    });
  });
}

afterEach(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  servers = [];
});

describe('defaultIsPortBound', () => {
  it('reports a port something is listening on', async () => {
    const port = await listen();
    await expect(defaultIsPortBound(port)).resolves.toBe(true);
  });

  it('reports a free port, and leaves it free', async () => {
    const port = await listen();
    await new Promise<void>((resolve) => servers[0]?.close(() => resolve()));
    servers = [];

    await expect(defaultIsPortBound(port)).resolves.toBe(false);
    await expect(listen(port)).resolves.toBe(port);
  });
});

describe('defaultIsProcessAlive', () => {
  it('reports this process as alive', () => {
    expect(defaultIsProcessAlive(process.pid)).toBe(true);
  });

  it('reports a process id that is not running', () => {
    // Chosen above the usual pid_max so the id is almost certainly unused.
    expect(defaultIsProcessAlive(0x7ffffffe)).toBe(false);
  });
});

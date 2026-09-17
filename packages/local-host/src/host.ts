import { readFile } from 'node:fs/promises';

import {
  createLoopbackPreviewHost,
  createStableSourceWatcher,
  type LoopbackPreviewHost,
  type StableSourceWatcher,
} from '@kubohiroya/turbowarp-local-preview';

import {
  acquireRunLock,
  findPortHolder,
  type RunLock,
  type RunLockEnvironment,
  type RunLockRecord,
} from './run-lock.ts';

/** Path the packaged player is served from. The root redirects here so either URL works. */
export const playerPath = '/app';

/**
 * Path the lens calibration app is served from, next to the application on the same origin.
 *
 * Same origin is the point. The calibration app saves the profile it solves to browser storage, and
 * the camera app reads it back from there; storage is scoped to the origin, so a calibration app
 * opened from anywhere else would save into a store the camera app cannot see.
 */
export const lensCalibrationPath = '/lens-calibration';

export interface DslSource {
  /** Directory the watcher is allowed to watch inside. */
  readonly projectRoot: string;
  readonly path: string;
}

export interface LocalHostOptions {
  readonly app: string;
  readonly title: string;
  /** Fixed port. Part of the origin, so it decides which stored data the app reaches. */
  readonly port: number;
  readonly lockDirectory: string;
  /** The packaged player, as a file to read or as markup already in hand. */
  readonly player: { readonly path: string } | { readonly html: string };
  /** The packaged lens calibration app. Absent when the build carried none; the route then 404s. */
  readonly lensCalibrationPlayer?:
    { readonly path: string } | { readonly html: string };
  readonly dsl?: DslSource;
  readonly onError?: (error: unknown) => void;
  /** Test seam for process and port liveness. */
  readonly runLock?: Omit<RunLockEnvironment, 'directory'>;
}

export interface DslPublication {
  readonly name: string;
  readonly contentHash: string;
  readonly source: string;
}

export interface StartedLocalHost {
  /** Authenticated URL of the player. */
  readonly url: string;
  readonly origin: string;
  readonly port: number;
  readonly lock: RunLockRecord;
  /** The DSL currently published, or `null` when none has been read yet. */
  dsl(): DslPublication | null;
  stop(): Promise<void>;
}

export type LocalHostFailure =
  | { readonly reason: 'player-missing'; readonly path: string }
  | { readonly reason: 'already-running'; readonly holder: RunLockRecord }
  | {
      readonly reason: 'port-held-by-application';
      readonly holder: RunLockRecord;
    }
  | { readonly reason: 'port-unavailable'; readonly port: number };

export type LocalHostResult =
  | { readonly started: true; readonly host: StartedLocalHost }
  | ({ readonly started: false } & LocalHostFailure);

function isAddressInUse(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EADDRINUSE';
}

/** Sends the browser from the host root to the player, keeping the token in the query. */
function redirectScript(): string {
  return `location.replace(${JSON.stringify(playerPath)} + location.search);`;
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

async function readPlayer(
  player: LocalHostOptions['player'],
): Promise<{ html: string } | { missing: string }> {
  if ('html' in player) return { html: player.html };
  const html = await readFile(player.path, 'utf8').catch(() => null);
  return html === null ? { missing: player.path } : { html };
}

/**
 * Starts the venue host for one application.
 *
 * The order matters. The run lock is taken before the port so a second copy of the same application
 * is refused by the lock rather than by a race on the socket, and a port that cannot be bound is
 * attributed to a named application only when a lock proves it. Nothing falls back to a different
 * port: the port is part of the origin, so moving it would silently hide the venue's stored
 * calibration rather than fix anything.
 */
export async function startLocalHost(
  options: LocalHostOptions,
): Promise<LocalHostResult> {
  const player = await readPlayer(options.player);
  if ('missing' in player)
    return { started: false, reason: 'player-missing', path: player.missing };
  const lensCalibration =
    options.lensCalibrationPlayer === undefined
      ? null
      : await readPlayer(options.lensCalibrationPlayer);
  // A companion that was asked for and cannot be read is a broken build, not an optional extra.
  if (lensCalibration !== null && 'missing' in lensCalibration) {
    return {
      started: false,
      reason: 'player-missing',
      path: lensCalibration.missing,
    };
  }

  const lockEnvironment = {
    directory: options.lockDirectory,
    ...options.runLock,
  };
  const acquired = await acquireRunLock({
    ...lockEnvironment,
    app: options.app,
    port: options.port,
  });
  if (!acquired.acquired) {
    return {
      started: false,
      reason: 'already-running',
      holder: acquired.holder,
    };
  }

  try {
    return await serve(
      options,
      player.html,
      lensCalibration?.html ?? null,
      acquired.lock,
    );
  } catch (error) {
    await acquired.lock.release();
    if (!isAddressInUse(error)) throw error;
    const holder = await findPortHolder({
      ...lockEnvironment,
      port: options.port,
      app: options.app,
    });
    if (holder.kind === 'application') {
      return {
        started: false,
        reason: 'port-held-by-application',
        holder: holder.record,
      };
    }
    return { started: false, reason: 'port-unavailable', port: options.port };
  }
}

async function serve(
  options: LocalHostOptions,
  html: string,
  lensCalibrationHtml: string | null,
  lock: RunLock,
): Promise<LocalHostResult> {
  let published: DslPublication | null = null;
  let host: LoopbackPreviewHost | undefined;

  host = await createLoopbackPreviewHost({
    title: options.title,
    port: options.port,
    clientScript: redirectScript(),
    routes: {
      [playerPath]: () => htmlResponse(html),
      ...(lensCalibrationHtml === null
        ? {}
        : { [lensCalibrationPath]: () => htmlResponse(lensCalibrationHtml) }),
    },
    /**
     * The host does not flush the event stream until it writes, so a page that connects before any
     * DSL change would not see the connection open at all. Emitting here both opens the stream and
     * hands the page whatever is already published.
     */
    onConnect: () => {
      host?.emit(
        'dsl',
        published === null
          ? { state: 'none' }
          : { state: 'published', ...published },
      );
    },
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });

  const watcher =
    options.dsl === undefined
      ? null
      : startWatcher(options.dsl, options, (next) => {
          published = next;
          host?.emit('dsl', { state: 'published', ...next });
        });
  await watcher
    ?.publishNow()
    .catch((error: unknown) => options.onError?.(error));

  const origin = new URL(host.url).origin;
  return {
    started: true,
    host: {
      url: `${origin}${playerPath}?token=${host.token}`,
      origin,
      port: options.port,
      lock: lock.record,
      dsl: () => published,
      async stop() {
        await watcher?.close();
        await host?.close();
        await lock.release();
      },
    },
  };
}

function startWatcher(
  dsl: DslSource,
  options: LocalHostOptions,
  onPublication: (publication: DslPublication) => void,
): StableSourceWatcher {
  const watcher = createStableSourceWatcher<string, string, string>({
    projectRoot: dsl.projectRoot,
    sourcePath: dsl.path,
    onPublication: (publication) => {
      onPublication({
        name:
          publication.sourcePath.split('/').at(-1) ?? publication.sourcePath,
        contentHash: publication.contentHash,
        source: publication.parsed,
      });
    },
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  watcher.start();
  return watcher;
}

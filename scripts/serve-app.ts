/**
 * Runs one application's venue host from the source tree, with the player last built.
 *
 * The same host the venue binary runs, on the same port from `config/local-host.json`, so what a PC
 * has saved for that application — lens calibrations above all — is there. It exists for a
 * measurement build, which should not have to be compiled into a binary to be tried; anything after
 * the application's name is passed to the host as the binary would receive it (`--no-open`, …).
 *
 *   pnpm run serve:app -- camera-app
 */

import { readFile } from 'node:fs/promises';

import { runLocalHostCli } from '../packages/local-host/src/cli.ts';
import { readJson, type LocalHostConfig } from './repository-config.ts';

const [app, ...rest] = process.argv
  .slice(2)
  .filter((argument) => argument !== '--');
const config = await readJson<LocalHostConfig>('config/local-host.json');
const entry = app === undefined ? undefined : config.apps[app];
if (app === undefined || entry === undefined) {
  console.error(
    `Usage: pnpm run serve:app -- <${Object.keys(config.apps).join('|')}> [--no-open]`,
  );
  process.exit(1);
}

const dist = new URL(`../apps/${app}/dist/`, import.meta.url);
const player = await readFile(
  new URL(`${app}-player.html`, dist),
  'utf8',
).catch(() => null);
if (player === null) {
  console.error(
    `${app}: no player yet. Run \`pnpm run build:measurement\` (or \`pnpm run build:player\`) first.`,
  );
  process.exit(1);
}
const lensCalibrationPlayer = await readFile(
  new URL(`${app}-lens-calibration-player.html`, dist),
  'utf8',
).catch(() => undefined);

const outcome = await runLocalHostCli({
  app,
  title: entry.title,
  port: entry.port,
  player,
  ...(lensCalibrationPlayer === undefined ? {} : { lensCalibrationPlayer }),
  argv: rest,
});
process.exitCode = outcome.code;

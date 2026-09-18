/**
 * Builds the applications as measurement builds, for timing them on real hardware.
 *
 * A measurement needs DEBUG_POSE_REPLAY's recording, which every distributed build leaves off. This
 * builds the same three applications with `TWRMC_APP_FLAGS` set, so the recording menus appear, and
 * stops there: the players land where `build:player` puts them, and `serve:app` or `build:binary`
 * runs them on their usual ports — the ports matter, because the lens calibrations a PC has saved
 * belong to them.
 *
 *   pnpm run build:measurement                      # debugPoseReplayV1,external3dServiceV1
 *   TWRMC_APP_FLAGS=debugPoseReplayV1 pnpm run build:measurement
 *
 * A measurement build is never committed; `pnpm run build` without the variable puts things back.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseAppFlags } from '../packages/app-shell/src/app-config.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const flags = parseAppFlags(
  process.env['TWRMC_APP_FLAGS'] ?? 'debugPoseReplayV1,external3dServiceV1',
);
if (flags.length === 0) {
  console.error(
    'TWRMC_APP_FLAGS names no flag, so this would build the distributed applications. Leave it unset for the default.',
  );
  process.exit(1);
}
const env = { ...process.env, TWRMC_APP_FLAGS: flags.join(',') };

function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${args.join(' ')} exited with ${code}`)),
    );
  });
}

console.log(`Measurement build with ${flags.join(', ')}.`);
await run('pnpm', [
  '--config.verify-deps-before-run=false',
  '--filter',
  './packages/*',
  'run',
  'build',
]);
await run('node', [
  '--experimental-strip-types',
  'scripts/pin-embedded-extensions.ts',
  '--write',
]);
await run('pnpm', [
  '--config.verify-deps-before-run=false',
  '--filter',
  './apps/*',
  'run',
  'build',
]);
await run('node', ['--experimental-strip-types', 'scripts/build-player.ts']);

console.log(
  [
    '',
    `Measurement players built (${flags.join(', ')}):`,
    '  apps/camera-app/dist/camera-app-player.html',
    '  apps/fusion-app/dist/fusion-app-player.html',
    '  apps/local-app/dist/local-app-player.html',
    '',
    'Run one on its usual port:  pnpm run serve:app -- camera-app',
    'Put things back afterwards:  pnpm run build',
  ].join('\n'),
);

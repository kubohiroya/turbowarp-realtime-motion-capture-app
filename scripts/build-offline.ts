/**
 * Builds the applications to run pose estimation without the internet.
 *
 * The distributed applications load the MoveNet model from TF Hub (`TWRMC_POSE_MODEL` unset). This
 * builds the same applications with the pinned model given to them instead, fetched first if it is
 * not already in models/:
 *
 * - `local` (the default here): the venue host serves the model beside the player.
 *   `serve:app` and `build:binary` pick it up from the marker the app shell's build leaves.
 * - `embedded`: the model travels inside the app shell, about 10 MB more per SB3, and needs no host.
 *
 *   pnpm run build:offline                            # TWRMC_POSE_MODEL=local
 *   TWRMC_POSE_MODEL=embedded pnpm run build:offline
 *
 * Like a measurement build, it rewrites the embedded extension pins, so it is never committed;
 * `pnpm run build:workspaces && pnpm run pin:extensions` puts them back.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { poseModelModeOf } from '../packages/app-shell/pose-model-files.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const mode = poseModelModeOf(process.env['TWRMC_POSE_MODEL'] ?? 'local');
if (mode === 'hub') {
  console.error(
    'TWRMC_POSE_MODEL=hub is the ordinary build; use `pnpm run build` for it.',
  );
  process.exit(1);
}
const env = { ...process.env, TWRMC_POSE_MODEL: mode };

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

console.log(
  `Offline build with the MoveNet model ${mode === 'local' ? 'served by the venue host' : 'embedded in the app shell'}.`,
);
await run('node', [
  '--experimental-strip-types',
  'scripts/fetch-pose-model.ts',
]);
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
    `Offline players built (TWRMC_POSE_MODEL=${mode}).`,
    mode === 'local'
      ? 'Run one on its usual port, model included:  pnpm run serve:app -- camera-app'
      : 'The players carry the model; open one anywhere.',
    mode === 'local'
      ? 'Or build the venue binaries, model included:  pnpm run build:binary'
      : '',
    'Put the pins back afterwards:  pnpm run build:workspaces && pnpm run pin:extensions',
  ]
    .filter((line) => line !== undefined)
    .join('\n'),
);

/**
 * Downloads the pinned MoveNet MultiPose Lightning model from TF Hub into models/<id>/.
 *
 * Each file is checked against the size and SHA-256 in config/pose-model.json before it is written,
 * so a changed or truncated download never lands. Files already there and correct are kept, which
 * makes a second run cost nothing. `--check` only checks what is there, without the network.
 *
 *   pnpm run fetch:pose-model
 *   pnpm run fetch:pose-model -- --check
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';

import {
  fileProblem,
  poseModelDirectory,
  readPoseModelPin,
} from '../packages/app-shell/pose-model-files.ts';

const checkOnly = process.argv.includes('--check');
const pin = await readPoseModelPin();
const directory = poseModelDirectory(pin);
await mkdir(directory, { recursive: true });

const problems: string[] = [];
for (const file of pin.files) {
  const target = new URL(file.name, directory);
  const existing = await readFile(target).then(
    (buffer) => new Uint8Array(buffer),
    () => null,
  );
  if (fileProblem(file, existing) === null) {
    console.log(`${file.name}: as pinned`);
    continue;
  }
  if (checkOnly) {
    problems.push(fileProblem(file, existing) ?? file.name);
    continue;
  }
  const response = await fetch(`${pin.source}/${file.name}?tfjs-format=file`);
  if (!response.ok) {
    problems.push(`${file.name}: TF Hub answered ${response.status}`);
    continue;
  }
  const downloaded = new Uint8Array(await response.arrayBuffer());
  const problem = fileProblem(file, downloaded);
  if (problem !== null) {
    problems.push(`downloaded ${problem}`);
    continue;
  }
  await writeFile(target, downloaded);
  console.log(`${file.name}: downloaded (${downloaded.byteLength} bytes)`);
}

if (problems.length > 0) {
  console.error(problems.map((problem) => `- ${problem}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`${pin.id} is in ${directory.pathname}`);
}

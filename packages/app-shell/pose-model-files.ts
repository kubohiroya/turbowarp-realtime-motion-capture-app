/**
 * The pinned MoveNet model on disk: where it lives, and whether what is there is what was pinned.
 *
 * Node only. The app shell's build reads it to carry the model inside itself, the scripts read it to
 * fetch the model and to have the venue host serve it. The model is not committed: like the
 * extension bundles, it is reproduced from a pin — `config/pose-model.json` — and checked file by
 * file against the SHA-256 recorded there.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export interface PoseModelFilePin {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface PoseModelPin {
  readonly id: string;
  /** TF Hub's address for the model; each file is `<source>/<name>?tfjs-format=file`. */
  readonly source: string;
  readonly license: string;
  readonly files: readonly PoseModelFilePin[];
}

/** How a build gives the model to the pose pipeline. */
export type PoseModelMode = 'hub' | 'local' | 'embedded';

export const poseModelModes: readonly PoseModelMode[] = [
  'hub',
  'local',
  'embedded',
];

export const repositoryRoot = new URL('../../', import.meta.url);

export async function readPoseModelPin(): Promise<PoseModelPin> {
  return JSON.parse(
    await readFile(new URL('config/pose-model.json', repositoryRoot), 'utf8'),
  ) as PoseModelPin;
}

/** Where `fetch:pose-model` puts the model. Ignored by Git. */
export function poseModelDirectory(pin: PoseModelPin): URL {
  return new URL(`models/${pin.id}/`, repositoryRoot);
}

/** The path the venue host serves the model under, and the app shell asks for it at. */
export function poseModelRoute(pin: PoseModelPin): string {
  return `/models/${pin.id}/`;
}

/**
 * `TWRMC_POSE_MODEL` from the environment. Unset means TF Hub, as every build did before; an unknown
 * value stops the build rather than quietly producing one that needs the internet.
 */
export function poseModelModeOf(value: string | undefined): PoseModelMode {
  const mode = (value ?? '').trim();
  if (mode === '') return 'hub';
  if ((poseModelModes as readonly string[]).includes(mode)) {
    return mode as PoseModelMode;
  }
  throw new Error(
    `TWRMC_POSE_MODEL must be one of ${poseModelModes.join(', ')}, not ${JSON.stringify(mode)}.`,
  );
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** What is wrong with one file's bytes, or null when they are the pinned ones. */
export function fileProblem(
  file: PoseModelFilePin,
  bytes: Uint8Array | null,
): string | null {
  if (bytes === null) return `${file.name} is missing`;
  if (bytes.byteLength !== file.bytes) {
    return `${file.name} is ${bytes.byteLength} bytes, not ${file.bytes}`;
  }
  const digest = sha256Of(bytes);
  if (digest !== file.sha256) {
    return `${file.name} has SHA-256 ${digest}, not ${file.sha256}`;
  }
  return null;
}

/** Reads every pinned file and checks it. Throws, naming each problem, unless all are as pinned. */
export async function readPinnedPoseModel(
  pin: PoseModelPin,
): Promise<ReadonlyMap<string, Uint8Array>> {
  const directory = poseModelDirectory(pin);
  const files = new Map<string, Uint8Array>();
  const problems: string[] = [];
  for (const file of pin.files) {
    const bytes = await readFile(new URL(file.name, directory)).then(
      (buffer) => new Uint8Array(buffer),
      () => null,
    );
    const problem = fileProblem(file, bytes);
    if (problem !== null) problems.push(problem);
    else if (bytes !== null) files.set(file.name, bytes);
  }
  if (problems.length > 0) {
    throw new Error(
      `The pose model in ${directory.pathname} is not the pinned one: ${problems.join('; ')}. Run \`pnpm run fetch:pose-model\`.`,
    );
  }
  return files;
}

/**
 * The mode the app shell of one application was last built with, from the marker its build leaves
 * in packages/app-shell/dist/<app>/. Hub when there is no marker, as for a shell built before there
 * was a choice.
 */
export async function builtPoseModelMode(app: string): Promise<PoseModelMode> {
  const marker = await readFile(
    new URL(`packages/app-shell/dist/${app}/pose-model.json`, repositoryRoot),
    'utf8',
  ).catch(() => null);
  if (marker === null) return 'hub';
  return poseModelModeOf((JSON.parse(marker) as { mode?: string }).mode);
}

/**
 * The files the venue host serves for an application whose shell was built with
 * `TWRMC_POSE_MODEL=local`, route to path on disk; undefined for any other build. Checks the model
 * against its pin first, so a host never serves a model other than the pinned one.
 */
export async function servedPoseModelFiles(
  app: string,
): Promise<Readonly<Record<string, string>> | undefined> {
  if ((await builtPoseModelMode(app)) !== 'local') return undefined;
  const pin = await readPoseModelPin();
  await readPinnedPoseModel(pin);
  const directory = poseModelDirectory(pin);
  return Object.fromEntries(
    pin.files.map((file) => [
      `${poseModelRoute(pin)}${file.name}`,
      fileURLToPath(new URL(file.name, directory)),
    ]),
  );
}

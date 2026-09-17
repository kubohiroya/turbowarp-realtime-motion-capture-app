import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { formatJson, readJson, repositoryRoot } from './repository-config.ts';

/**
 * Collects the SB3 each application builds into the distribution page's download directory.
 *
 * The page offers the same archives the applications publish; it does not build a second variant of
 * them. `apps/<app>/dist/<app>.sb3` stays the build output, and `public/downloads/release.json`
 * records what the page is serving, so a downloaded file can be checked against it.
 */
interface AppMode {
  readonly id: string;
  readonly sb3: string;
}

const config = await readJson<{ modes: readonly AppMode[] }>('config/app.json');
const downloads = new URL('public/downloads/', repositoryRoot);
await rm(downloads, { recursive: true, force: true });
await mkdir(downloads, { recursive: true });

const entries = [];
for (const mode of config.modes) {
  const app = mode.sb3.replace(/\.sb3$/, '');
  const source = new URL(`apps/${app}/dist/${mode.sb3}`, repositoryRoot);
  let bytes: Buffer;
  try {
    bytes = await readFile(source);
  } catch {
    throw new Error(
      `${mode.sb3} is missing; run pnpm run build:workspaces first.`,
    );
  }
  await writeFile(new URL(mode.sb3, downloads), bytes);
  entries.push({
    mode: mode.id,
    file: mode.sb3,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
  });
}

await writeFile(
  new URL('release.json', downloads),
  formatJson({ formatVersion: 1, apps: entries }),
);
console.log(`Prepared ${entries.length} downloads for the distribution page.`);

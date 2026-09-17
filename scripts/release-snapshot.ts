import {readdir, readFile, writeFile} from 'node:fs/promises';

import {
  createDeterministicSb3,
  createSb3ReleaseSnapshot,
  verifySb3ReleaseSnapshot
} from '@kubohiroya/sb3-toolchain';

import {formatJson, readJson, repositoryRoot} from './repository-config.ts';

interface ReleaseSnapshot {
  formatVersion: number;
  state: string;
  sourceIdentity: string;
  artifact: {filename: string; sha256: string; size: number};
}

const writeMode = process.argv.includes('--write');
const applications = ['camera-app', 'fusion-app', 'local-app'];

/**
 * Records what a release SB3 is, without keeping the SB3 in Git.
 *
 * The built archives are 6 MB each because the pinned contract extension embeds OpenCV, so
 * committing them costs more every time a source line changes. The snapshot keeps what review and CI
 * actually need: the identity of every expanded source file, and the SHA-256 and size of the archive
 * those files produce. Verification rebuilds twice, so a non-deterministic build still fails here.
 */
async function readSourceFiles(directory: URL, prefix = ''): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      const nested = await readSourceFiles(new URL(`${entry.name}/`, directory), `${name}/`);
      for (const [path, contents] of nested) files.set(path, contents);
      continue;
    }
    files.set(name, await readFile(new URL(entry.name, directory)));
  }
  return new Map([...files].sort(([left], [right]) => left.localeCompare(right)));
}

const failures: string[] = [];

for (const application of applications) {
  const sourceDirectory = new URL(`apps/${application}/source/`, repositoryRoot);
  const snapshotUrl = new URL(`apps/${application}/release.json`, repositoryRoot);
  const sourceFiles = await readSourceFiles(sourceDirectory);
  const createSb3 = () => createDeterministicSb3(sourceDirectory.pathname);
  const filename = `${application}.sb3`;

  if (writeMode) {
    const {metadata} = await createSb3ReleaseSnapshot({
      artifact: {filename},
      createSb3,
      sourceFiles
    });
    await writeFile(snapshotUrl, formatJson(metadata));
    console.log(`${application}: recorded sha256-${(metadata as ReleaseSnapshot).artifact.sha256}`);
    continue;
  }

  const metadata = await readJson<ReleaseSnapshot>(snapshotUrl);
  try {
    const verified = (await verifySb3ReleaseSnapshot({
      createSb3,
      metadata,
      sourceFiles
    })) as ReleaseSnapshot;
    console.log(
      `${application}: sha256-${verified.artifact.sha256} (${verified.artifact.size} bytes)`
    );
  } catch (error) {
    failures.push(`${application}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  console.error('Run `pnpm run snapshot` after an intentional source change.');
  process.exitCode = 1;
}

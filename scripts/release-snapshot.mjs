import {readdir, readFile, writeFile} from 'node:fs/promises';

import {
  createDeterministicSb3,
  createSb3ReleaseSnapshot,
  verifySb3ReleaseSnapshot
} from '@kubohiroya/sb3-toolchain';

const repositoryRoot = new URL('../', import.meta.url);
const writeMode = process.argv.includes('--write');
const applications = ['camera-app', 'fusion-app'];

/**
 * Records what a release SB3 is, without keeping the SB3 in Git.
 *
 * The built archives are 6 MB each because the pinned contract extension embeds OpenCV, so
 * committing them costs more every time a source line changes. The snapshot keeps what review and CI
 * actually need: the identity of every expanded source file, and the SHA-256 and size of the archive
 * those files produce. Verification rebuilds twice, so a non-deterministic build still fails here.
 */
async function readSourceFiles(directory, prefix = '') {
  const files = new Map();
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      for (const [path, contents] of await readSourceFiles(
        new URL(`${entry.name}/`, directory),
        `${name}/`
      )) {
        files.set(path, contents);
      }
      continue;
    }
    files.set(name, await readFile(new URL(entry.name, directory)));
  }
  return new Map([...files].sort(([left], [right]) => left.localeCompare(right)));
}

const failures = [];

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
    await writeFile(snapshotUrl, `${JSON.stringify(metadata, null, 2)}\n`);
    console.log(`${application}: recorded sha256-${metadata.artifact.sha256}`);
    continue;
  }

  const metadata = JSON.parse(await readFile(snapshotUrl, 'utf8'));
  try {
    const verified = await verifySb3ReleaseSnapshot({createSb3, metadata, sourceFiles});
    console.log(`${application}: sha256-${verified.artifact.sha256} (${verified.artifact.size} bytes)`);
  } catch (error) {
    failures.push(`${application}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  console.error('Run `pnpm run snapshot` after an intentional source change.');
  process.exitCode = 1;
}

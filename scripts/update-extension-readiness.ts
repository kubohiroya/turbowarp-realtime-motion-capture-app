import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

import {
  formatJson,
  readJson,
  repositoryRoot,
  type AppExtensions,
  type EmbeddedExtensions,
  type ExtensionManifest,
  type ExtensionManifestBlock,
  type ExtensionRequirements,
  type ReadinessExtension,
} from './repository-config.ts';

const checkOnly = process.argv.includes('--check');
const requirements = await readJson<ExtensionRequirements>(
  'config/extension-requirements.json',
);
const applications = await readJson<AppExtensions>(
  'config/app-extensions.json',
);

if (requirements.schemaVersion !== 1) {
  throw new Error(
    `Unsupported requirements schemaVersion: ${requirements.schemaVersion}`,
  );
}

/** Collects the artifact actually embedded in an SB3, so the inventory cannot drift from the pin. */
const pinned = new Map<
  string,
  { app: string; version: string; path: string }
>();
for (const { app } of applications.apps) {
  const embedded = await readJson<EmbeddedExtensions>(
    new URL(`apps/${app}/source/embedded-extensions.json`, repositoryRoot),
  );
  for (const entry of embedded.extensions) {
    if (entry.source?.provider !== 'npm') continue;
    const previous = pinned.get(entry.id);
    if (previous !== undefined && previous.version !== entry.source.version) {
      throw new Error(
        `${entry.id} is pinned to two versions: ${previous.version} and ${entry.source.version}`,
      );
    }
    pinned.set(entry.id, {
      app,
      version: entry.source.version,
      path: entry.path,
    });
  }
}

const cdn = (pkg: string, version: string, path: string): string =>
  `https://cdn.jsdelivr.net/npm/${pkg}@${version}/${path}`;

const extensions: ReadinessExtension[] = [];
for (const requirement of requirements.extensions) {
  const pin = pinned.get(requirement.extensionId);
  if (pin === undefined) {
    throw new Error(
      `${requirement.role} is required but no application embeds ${requirement.extensionId}`,
    );
  }
  const sourceDirectory = new URL(`apps/${pin.app}/source/`, repositoryRoot);
  const javascript = await readFile(new URL(pin.path, sourceDirectory));
  const manifest = await readJson<ExtensionManifest>(
    new URL(
      `apps/${pin.app}/node_modules/${requirement.package}/${requirement.manifestPath}`,
      repositoryRoot,
    ),
  );
  const published = new Map<string, ExtensionManifestBlock>(
    manifest.blocks.map((block) => [block.opcode, block]),
  );

  const blockContracts: Record<
    string,
    { blockType: string; arguments: Record<string, string> }
  > = {};
  const requiredOperations = requirement.requiredOperations.map(
    ({ capability, opcode }) => {
      const block = published.get(opcode);
      if (block !== undefined) {
        blockContracts[opcode] = {
          blockType: block.blockType.toLowerCase(),
          arguments: Object.fromEntries(
            [...block.arguments]
              .sort((left, right) => left.id.localeCompare(right.id))
              .map(({ id, type }) => [id, type.toLowerCase()]),
          ),
        };
      }
      return {
        capability,
        opcode,
        availability: block === undefined ? 'missing' : 'ready',
      };
    },
  );

  extensions.push({
    role: requirement.role,
    repository: requirement.repository,
    package: requirement.package,
    version: pin.version,
    extensionId: requirement.extensionId,
    artifact: cdn(requirement.package, pin.version, requirement.artifactPath),
    manifest: cdn(requirement.package, pin.version, requirement.manifestPath),
    sha256: createHash('sha256').update(javascript).digest('hex'),
    status: requirement.status,
    embeddedIn: applications.apps
      .filter(({ extensions: members }) =>
        members.some(({ id }) => id === requirement.extensionId),
      )
      .map(({ app }) => app),
    requiredOperations,
    blockContracts,
    gaps: requirement.gaps,
  });
}

const inventory = {
  schemaVersion: 1,
  generatedFrom: 'config/extension-requirements.json',
  reviewedOn: requirements.reviewedOn,
  epic: requirements.epic,
  issue: requirements.issue,
  policy: requirements.policy,
  extensions,
  readinessGates: requirements.readinessGates,
};

const target = new URL('config/extension-readiness.json', repositoryRoot);
const contents = formatJson(inventory);
const existing = await readFile(target, 'utf8').catch(() => null);
if (existing === contents) {
  console.log('config/extension-readiness.json is up to date.');
} else if (checkOnly) {
  console.error(
    'config/extension-readiness.json is out of date. Run `pnpm run update:readiness`.',
  );
  process.exitCode = 1;
} else {
  await writeFile(target, contents);
  console.log(
    `Regenerated the readiness inventory (${extensions.length} extensions).`,
  );
}

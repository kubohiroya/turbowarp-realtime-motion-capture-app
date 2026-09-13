import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';

const repositoryRoot = new URL('../', import.meta.url);
const checkOnly = process.argv.includes('--check');
const requirements = JSON.parse(
  await readFile(new URL('config/extension-requirements.json', repositoryRoot), 'utf8')
);
const applications = JSON.parse(
  await readFile(new URL('config/app-extensions.json', repositoryRoot), 'utf8')
);

if (requirements.schemaVersion !== 1) {
  throw new Error(`Unsupported requirements schemaVersion: ${requirements.schemaVersion}`);
}

/** Collects the artifact actually embedded in an SB3, so the inventory cannot drift from the pin. */
const pinned = new Map();
for (const {app} of applications.apps) {
  const embedded = JSON.parse(
    await readFile(new URL(`apps/${app}/source/embedded-extensions.json`, repositoryRoot), 'utf8')
  );
  for (const entry of embedded.extensions) {
    if (entry.source?.provider !== 'npm') continue;
    const previous = pinned.get(entry.id);
    if (previous !== undefined && previous.version !== entry.source.version) {
      throw new Error(`${entry.id} is pinned to two versions: ${previous.version} and ${entry.source.version}`);
    }
    pinned.set(entry.id, {app, version: entry.source.version, path: entry.path});
  }
}

const cdn = (pkg, version, path) => `https://cdn.jsdelivr.net/npm/${pkg}@${version}/${path}`;

const extensions = [];
for (const requirement of requirements.extensions) {
  const pin = pinned.get(requirement.extensionId);
  if (pin === undefined) {
    throw new Error(`${requirement.role} is required but no application embeds ${requirement.extensionId}`);
  }
  const sourceDirectory = new URL(`apps/${pin.app}/source/`, repositoryRoot);
  const javascript = await readFile(new URL(pin.path, sourceDirectory));
  const manifest = JSON.parse(
    await readFile(new URL(`extensions/${requirement.extensionId}.manifest.json`, sourceDirectory), 'utf8')
  );
  const published = new Map(manifest.blocks.map((block) => [block.opcode, block]));

  const blockContracts = {};
  const requiredOperations = requirement.requiredOperations.map(({capability, opcode}) => {
    const block = published.get(opcode);
    if (block !== undefined) {
      blockContracts[opcode] = {
        blockType: block.blockType.toLowerCase(),
        arguments: Object.fromEntries(
          [...block.arguments]
            .sort((left, right) => left.id.localeCompare(right.id))
            .map(({id, type}) => [id, type.toLowerCase()])
        )
      };
    }
    return {capability, opcode, availability: block === undefined ? 'missing' : 'ready'};
  });

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
      .filter(({extensions: members}) => members.some(({id}) => id === requirement.extensionId))
      .map(({app}) => app),
    requiredOperations,
    blockContracts,
    gaps: requirement.gaps
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
  readinessGates: requirements.readinessGates
};

const target = new URL('config/extension-readiness.json', repositoryRoot);
const contents = `${JSON.stringify(inventory, null, 2)}\n`;
const existing = await readFile(target, 'utf8').catch(() => null);
if (existing === contents) {
  console.log('config/extension-readiness.json is up to date.');
} else if (checkOnly) {
  console.error('config/extension-readiness.json is out of date. Run `pnpm run update:readiness`.');
  process.exitCode = 1;
} else {
  await writeFile(target, contents);
  console.log(`Regenerated the readiness inventory (${extensions.length} extensions).`);
}

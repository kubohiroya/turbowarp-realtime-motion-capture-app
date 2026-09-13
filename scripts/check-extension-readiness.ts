import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';

import {tryParseExtensionApiManifest} from '@kubohiroya/sb3-toolchain';

interface BlockContract {
  blockType: string;
  arguments: Record<string, string>;
  result: string;
}

interface RequiredOperation {
  capability: string;
  opcode: string | null;
  availability: 'ready' | 'runtime-api-only' | 'missing';
}

interface Extension {
  role: string;
  repository: string;
  package: string;
  version: string | null;
  extensionId: string;
  artifact: string | null;
  manifest: string | null;
  sha256: string | null;
  status: 'ready' | 'ready-with-dependency' | 'partial' | 'missing';
  trackingIssues: string[];
  requiredOperations: RequiredOperation[];
  blockContracts?: Record<string, BlockContract>;
  desiredBlockContracts?: Record<string, BlockContract>;
  runtimeApi?: Record<string, unknown>;
  gaps?: string[];
}

interface LocalImplementationCandidate {
  repository: string;
  branch: string;
  commit: string;
  trackingIssue: string;
  published: boolean;
  verification: string;
  note?: string;
}

interface ReadinessInventory {
  schemaVersion: number;
  reviewedOn: string;
  epic: string;
  issue: string;
  policy: Record<string, string | boolean>;
  localImplementationCandidates?: LocalImplementationCandidate[];
  extensions: Extension[];
  readinessGates: Record<string, string[]>;
}

const inventoryUrl = new URL('../config/extension-readiness.json', import.meta.url);
const inventory = JSON.parse(await readFile(inventoryUrl, 'utf8')) as ReadinessInventory;
const errors: string[] = [];

const duplicateValues = <T,>(values: T[]): T[] =>
  [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
const normalizeRecord = (record: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));

if (inventory.schemaVersion !== 1) {
  errors.push(`Unsupported schemaVersion: ${inventory.schemaVersion}`);
}

const uniqueFields = ['role', 'repository', 'package', 'extensionId'] as const;
for (const field of uniqueFields) {
  for (const value of duplicateValues(inventory.extensions.map((extension) => extension[field]))) {
    errors.push(`Duplicate ${field}: ${value}`);
  }
}

const roles = new Set(inventory.extensions.map((extension) => extension.role));
const repositories = new Set(inventory.extensions.map((extension) => extension.repository));
for (const [gate, requiredRoles] of Object.entries(inventory.readinessGates)) {
  for (const role of requiredRoles) {
    if (!roles.has(role)) errors.push(`Gate ${gate} references unknown role: ${role}`);
  }
}

const candidateRepositories = inventory.localImplementationCandidates?.map(({repository}) => repository) ?? [];
for (const repository of duplicateValues(candidateRepositories)) {
  errors.push(`Duplicate local implementation candidate: ${repository}`);
}
for (const candidate of inventory.localImplementationCandidates ?? []) {
  if (!repositories.has(candidate.repository)) {
    errors.push(`Local implementation candidate references unknown repository: ${candidate.repository}`);
  }
  if (!/^[a-f0-9]{40}$/.test(candidate.commit)) {
    errors.push(`Local implementation candidate has an invalid commit: ${candidate.repository}`);
  }
  if (candidate.published !== false) {
    errors.push(`Local implementation candidate must remain unpublished: ${candidate.repository}`);
  }
}

for (const extension of inventory.extensions) {
  if (extension.version !== null && !/^\d+\.\d+\.\d+$/.test(extension.version)) {
    errors.push(`${extension.role} does not use an exact semver version`);
  }
  if ((extension.artifact === null) !== (extension.sha256 === null)) {
    errors.push(`${extension.role} must provide artifact and sha256 together`);
  }
  if (extension.status === 'ready' && extension.manifest === null) {
    errors.push(`${extension.role} cannot be ready without a published manifest`);
  }
  if (extension.sha256 !== null && !/^[a-f0-9]{64}$/.test(extension.sha256)) {
    errors.push(`${extension.role} has an invalid sha256`);
  }

  const operationCapabilities = extension.requiredOperations.map(({capability}) => capability);
  for (const capability of duplicateValues(operationCapabilities)) {
    errors.push(`${extension.role} has duplicate capability: ${capability}`);
  }

  for (const operation of extension.requiredOperations) {
    if (operation.availability !== 'ready') continue;
    if (operation.opcode === null || !extension.blockContracts?.[operation.opcode]) {
      errors.push(`${extension.role}/${operation.opcode} is ready but has no block contract`);
    }
  }
}

if (process.argv.includes('--verify-network')) {
  for (const extension of inventory.extensions) {
    if (extension.artifact === null) continue;
    const response = await fetch(extension.artifact);
    if (!response.ok) {
      errors.push(`${extension.role} artifact returned HTTP ${response.status}`);
      continue;
    }
    const digest = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
    if (digest !== extension.sha256) {
      errors.push(`${extension.role} artifact sha256 mismatch: ${digest}`);
    }

    if (extension.manifest === null) continue;
    const manifestResponse = await fetch(extension.manifest);
    if (!manifestResponse.ok) {
      errors.push(`${extension.role} manifest returned HTTP ${manifestResponse.status}`);
      continue;
    }
    const parsed = tryParseExtensionApiManifest(Buffer.from(await manifestResponse.arrayBuffer()), {
      expectedId: extension.extensionId
    });
    if (parsed.manifest === null) {
      errors.push(`${extension.role} manifest is invalid: ${parsed.error}`);
      continue;
    }
    const manifest = parsed.manifest;
    for (const operation of extension.requiredOperations) {
      if (operation.availability !== 'ready' || operation.opcode === null) continue;
      const opcode = operation.opcode;
      const published = manifest.blocks.find((block) => block.opcode === opcode);
      if (!published) {
        errors.push(`${extension.role}/${opcode} is absent from the published manifest`);
        continue;
      }
      const expected = extension.blockContracts?.[opcode];
      if (expected === undefined) continue;
      if (published.blockType.toLowerCase() !== expected.blockType) {
        errors.push(`${extension.role}/${opcode} block type does not match the published manifest`);
      }
      const publishedArguments: Record<string, string> = Object.fromEntries(
        published.arguments.map(({id, type}) => [id, type.toLowerCase()])
      );
      if (JSON.stringify(normalizeRecord(publishedArguments)) !== JSON.stringify(normalizeRecord(expected.arguments))) {
        errors.push(`${extension.role}/${opcode} arguments do not match the published manifest`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `Extension readiness inventory is valid (${inventory.extensions.length} extensions, ${Object.keys(inventory.readinessGates).length} gates).`
  );
}

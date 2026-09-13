import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';

const inventoryUrl = new URL('../config/extension-readiness.json', import.meta.url);
const inventory = JSON.parse(await readFile(inventoryUrl, 'utf8'));
const errors = [];

const duplicateValues = (values) =>
  [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
const normalizeRecord = (record) =>
  Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));

if (inventory.schemaVersion !== 1) {
  errors.push(`Unsupported schemaVersion: ${inventory.schemaVersion}`);
}

for (const field of ['role', 'repository', 'package', 'extensionId']) {
  for (const value of duplicateValues(inventory.extensions.map((extension) => extension[field]))) {
    errors.push(`Duplicate ${field}: ${value}`);
  }
}

const roles = new Set(inventory.extensions.map((extension) => extension.role));
for (const [gate, requiredRoles] of Object.entries(inventory.readinessGates)) {
  for (const role of requiredRoles) {
    if (!roles.has(role)) errors.push(`Gate ${gate} references unknown role: ${role}`);
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
    if (operation.availability === 'ready' && !extension.blockContracts?.[operation.opcode]) {
      errors.push(`${extension.role}/${operation.opcode} is ready but has no block contract`);
    }
  }
}

if (process.argv.includes('--verify-network')) {
  for (const extension of inventory.extensions.filter(({artifact}) => artifact !== null)) {
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
    const manifest = await manifestResponse.json();
    if (manifest.id !== extension.extensionId) {
      errors.push(`${extension.role} manifest ID mismatch: ${manifest.id}`);
    }
    for (const operation of extension.requiredOperations.filter(({availability}) => availability === 'ready')) {
      const published = manifest.blocks?.find(({opcode}) => opcode === operation.opcode);
      const expected = extension.blockContracts[operation.opcode];
      if (!published) {
        errors.push(`${extension.role}/${operation.opcode} is absent from the published manifest`);
        continue;
      }
      if (published.blockType.toLowerCase() !== expected.blockType) {
        errors.push(`${extension.role}/${operation.opcode} block type does not match the published manifest`);
      }
      const publishedArguments = Object.fromEntries(
        published.arguments.map(({id, type}) => [id, type.toLowerCase()])
      );
      if (JSON.stringify(normalizeRecord(publishedArguments)) !== JSON.stringify(normalizeRecord(expected.arguments))) {
        errors.push(`${extension.role}/${operation.opcode} arguments do not match the published manifest`);
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

import {readFile} from 'node:fs/promises';

import {repositoryFiles} from './repository-files.ts';

const files = await repositoryFiles();
const required = [
  'apps/camera-app/source/project.source.json',
  'apps/fusion-app/source/project.source.json',
  'config/extension-readiness.json'
];
for (const file of required) {
  if (!files.includes(file)) throw new Error(`Required repository file is missing: ${file}`);
}
for (const file of files.filter((candidate) => candidate.endsWith('.json'))) {
  const contents = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  try {
    JSON.parse(contents);
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const forbidden = files.filter((file) => file.endsWith('.local.json') || file.includes('/local/'));
if (forbidden.length > 0) throw new Error(`Local configuration is tracked: ${forbidden.join(', ')}`);
console.log(`Repository structure is valid (${files.length} tracked files).`);

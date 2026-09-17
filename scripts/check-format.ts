import { readFile } from 'node:fs/promises';

import { repositoryRoot } from './repository-config.ts';
import { repositoryFiles } from './repository-files.ts';

const errors: string[] = [];
for (const file of await repositoryFiles()) {
  if (!/\.(?:json|md|mjs|ts|ya?ml)$/.test(file)) continue;
  const contents = await readFile(new URL(file, repositoryRoot), 'utf8');
  if (contents.includes('\r')) errors.push(`${file}: contains CR line endings`);
  if (!contents.endsWith('\n')) errors.push(`${file}: has no trailing newline`);
  if (contents.split('\n').some((line) => /[ \t]+$/.test(line))) {
    errors.push(`${file}: contains trailing whitespace`);
  }
}
if (errors.length > 0) throw new Error(errors.join('\n'));
console.log('Text formatting is valid.');

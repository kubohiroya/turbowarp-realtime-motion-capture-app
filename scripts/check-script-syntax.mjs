import {execFileSync} from 'node:child_process';

import {repositoryFiles} from './repository-files.mjs';

for (const file of (await repositoryFiles()).filter((candidate) => candidate.endsWith('.mjs'))) {
  execFileSync(process.execPath, ['--check', file], {stdio: 'inherit'});
}
console.log('Node.js script syntax is valid.');

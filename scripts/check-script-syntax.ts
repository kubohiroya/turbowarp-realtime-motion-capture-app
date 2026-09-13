import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';

import {repositoryFiles} from './repository-files.ts';

// `tsc` accepts syntax that Node.js cannot erase at run time (enum, namespace,
// parameter properties). These scripts are executed directly by Node.js, so
// every tracked TypeScript file must survive strip-only type erasure.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name !== 'ExperimentalWarning') console.warn(warning);
});

const errors: string[] = [];
for (const file of (await repositoryFiles()).filter((candidate) => candidate.endsWith('.ts'))) {
  const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  try {
    stripTypeScriptTypes(source, {mode: 'strip'});
  } catch (error) {
    errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (errors.length > 0) throw new Error(errors.join('\n'));
console.log('Node.js script syntax is valid.');

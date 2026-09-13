import {mkdir, writeFile} from 'node:fs/promises';

import {protocolSchemas} from '../dist/src/schemas.js';

const outputDirectory = new URL('../schemas/', import.meta.url);
await mkdir(outputDirectory, {recursive: true});
for (const [filename, schema] of Object.entries(protocolSchemas)) {
  await writeFile(new URL(filename, outputDirectory), `${JSON.stringify(schema, null, 2)}\n`);
}

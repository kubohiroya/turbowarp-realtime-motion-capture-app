import {mkdir} from 'node:fs/promises';

import {repositoryRoot} from './repository-config.ts';

const applications = ['camera-app', 'fusion-app'];
const application = process.argv[2];
if (application === undefined || !applications.includes(application)) {
  throw new Error(`Unknown application: ${application ?? ''}`);
}

const sourceUrl = new URL(`apps/${application}/source/`, repositoryRoot);
await Promise.all([
  mkdir(new URL('assets/', sourceUrl), {recursive: true}),
  mkdir(new URL('extensions/', sourceUrl), {recursive: true})
]);

import {mkdir} from 'node:fs/promises';

const applications = ['camera-app', 'fusion-app'] as const;

const application = process.argv[2];
if (application === undefined || !(applications as readonly string[]).includes(application)) {
  throw new Error(`Unknown application: ${application ?? ''}`);
}

const sourceUrl = new URL(`../apps/${application}/source/`, import.meta.url);
await Promise.all([
  mkdir(new URL('assets/', sourceUrl), {recursive: true}),
  mkdir(new URL('extensions/', sourceUrl), {recursive: true})
]);

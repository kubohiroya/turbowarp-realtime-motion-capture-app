import {readFile} from 'node:fs/promises';

import {createDeterministicSb3} from '@kubohiroya/sb3-toolchain';

const repositoryRoot = new URL('../', import.meta.url);
const declaration = JSON.parse(
  await readFile(new URL('config/app-extensions.json', repositoryRoot), 'utf8')
);
const errors = [];

/**
 * The static bundle inlines member sources in declaration order and introduces each one with a
 * `loadComponent("<id>", ...)` call. Reading those offsets back out of the generated bundle is the
 * offline proof that the app shell still writes the contract feature flags before the contract
 * extension is evaluated. Without that order every feature silently stays disabled.
 */
for (const {app, bundle, extensions} of declaration.apps) {
  const sourceDirectory = new URL(`apps/${app}/source/`, repositoryRoot);
  const {bundlePlans} = await createDeterministicSb3(sourceDirectory.pathname);
  const plan = bundlePlans.find((candidate) => candidate.bundle.id === bundle.id);
  if (plan === undefined) {
    errors.push(`${app}: the build produced no bundle named ${bundle.id}`);
    continue;
  }

  const declaredIds = extensions.map(({id}) => id);
  if (plan.bundle.members.join(' ') !== declaredIds.join(' ')) {
    errors.push(`${app}: bundle members ${plan.bundle.members.join(', ')} do not match the declaration`);
    continue;
  }

  const source = Buffer.from(plan.contents).toString('utf8');
  const offsets = declaredIds.map((id) => [id, source.indexOf(`loadComponent("${id}"`)]);
  for (const [id, offset] of offsets) {
    if (offset < 0) errors.push(`${app}: the bundle never evaluates member ${id}`);
  }
  const evaluated = offsets.filter(([, offset]) => offset >= 0);
  const ordered = [...evaluated].sort((left, right) => left[1] - right[1]);
  if (ordered.map(([id]) => id).join(' ') !== evaluated.map(([id]) => id).join(' ')) {
    errors.push(`${app}: members are evaluated as ${ordered.map(([id]) => id).join(', ')}`);
  }

  const flagOffset = source.indexOf('__TWMP_FEATURE_FLAGS__');
  const contractOffset = source.indexOf('loadComponent("kubohiroyamultiviewpose"');
  if (flagOffset < 0) {
    errors.push(`${app}: the bundle never writes the contract feature flags`);
  } else if (contractOffset >= 0 && flagOffset > contractOffset) {
    errors.push(`${app}: the feature flags are written after the contract extension is evaluated`);
  }
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Bundle member order is correct for ${declaration.apps.length} applications.`);
}

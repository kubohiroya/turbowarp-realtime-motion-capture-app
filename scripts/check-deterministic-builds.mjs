import {createHash} from 'node:crypto';

import {createDeterministicSb3} from '@kubohiroya/sb3-toolchain';

const applications = ['camera-app', 'fusion-app'];

for (const application of applications) {
  const sourceDirectory = new URL(`../apps/${application}/source/`, import.meta.url);
  const first = await createDeterministicSb3(sourceDirectory.pathname);
  const second = await createDeterministicSb3(sourceDirectory.pathname);
  const firstBytes = Buffer.from(first.archive);
  const secondBytes = Buffer.from(second.archive);
  if (!firstBytes.equals(secondBytes)) {
    throw new Error(`${application} did not produce a deterministic SB3 archive.`);
  }
  const digest = createHash('sha256').update(firstBytes).digest('hex');
  console.log(`${application}: sha256-${digest}`);
}

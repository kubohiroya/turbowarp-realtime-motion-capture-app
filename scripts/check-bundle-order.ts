import { createDeterministicSb3 } from '@kubohiroya/sb3-toolchain';

import {
  readJson,
  repositoryRoot,
  type AppExtensions,
} from './repository-config.ts';

interface BundlePlan {
  bundle: { id: string; members: string[] };
  contents: Uint8Array;
}

const declaration = await readJson<AppExtensions>('config/app-extensions.json');
const errors: string[] = [];

/**
 * The static bundle inlines member sources in declaration order and introduces each one with a
 * `loadComponent("<id>", ...)` call. Reading those offsets back out of the generated bundle is the
 * offline proof that the app shell still writes the contract feature flags before the contract
 * extension is evaluated. Without that order every feature silently stays disabled.
 */
for (const { app, bundle, extensions } of declaration.apps) {
  const sourceDirectory = new URL(`apps/${app}/source/`, repositoryRoot);
  const { bundlePlans } = (await createDeterministicSb3(
    sourceDirectory.pathname,
  )) as {
    bundlePlans: BundlePlan[];
  };
  const plan = bundlePlans.find(
    (candidate) => candidate.bundle.id === bundle.id,
  );
  if (plan === undefined) {
    errors.push(`${app}: the build produced no bundle named ${bundle.id}`);
    continue;
  }

  const declaredIds = extensions.map(({ id }) => id);
  if (plan.bundle.members.join(' ') !== declaredIds.join(' ')) {
    errors.push(
      `${app}: bundle members ${plan.bundle.members.join(', ')} do not match the declaration`,
    );
    continue;
  }

  const source = Buffer.from(plan.contents).toString('utf8');
  const offsets: Array<[string, number]> = declaredIds.map((id) => [
    id,
    source.indexOf(`loadComponent("${id}"`),
  ]);
  for (const [id, offset] of offsets) {
    if (offset < 0)
      errors.push(`${app}: the bundle never evaluates member ${id}`);
  }
  const evaluated = offsets.filter(([, offset]) => offset >= 0);
  const ordered = [...evaluated].sort((left, right) => left[1] - right[1]);
  if (
    ordered.map(([id]) => id).join(' ') !==
    evaluated.map(([id]) => id).join(' ')
  ) {
    errors.push(
      `${app}: members are evaluated as ${ordered.map(([id]) => id).join(', ')}`,
    );
  }

  /**
   * Each flag-reading member freezes its flags while it is evaluated, so the shell's write of that
   * global has to come first. The shell writes all of them in one place; each is checked on its own
   * so a member added later without its global being written is caught by name.
   */
  const flagReaders: ReadonlyArray<readonly [string, string]> = [
    ['__TWMP_FEATURE_FLAGS__', 'kubohiroyarealtimemotioncapture'],
    ['__TWQP_FEATURE_FLAGS__', 'kubohiroyawebrtcqrcodepairing'],
    ['__TWTSS_FEATURE_FLAGS__', 'kubohiroyatimespacesync'],
  ];
  for (const [global, member] of flagReaders) {
    const memberOffset = source.indexOf(`loadComponent("${member}"`);
    if (memberOffset < 0) continue;
    const flagOffset = source.indexOf(global);
    if (flagOffset < 0 || flagOffset > memberOffset) {
      errors.push(
        `${app}: ${global} is not written before ${member} is evaluated`,
      );
    }
  }
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `Bundle member order is correct for ${declaration.apps.length} applications.`,
  );
}

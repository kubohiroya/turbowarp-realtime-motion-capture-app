import {readFile, writeFile} from 'node:fs/promises';

import Packager from '@turbowarp/packager';

import {readJson, repositoryRoot, type LocalHostConfig} from './repository-config.ts';

const config = await readJson<LocalHostConfig>('config/local-host.json');
const failures: string[] = [];

/**
 * Builds the self-contained player each venue host serves.
 *
 * The packager removes an embedded extension that is not listed in `options.extensions`, and it does
 * so silently: the page opens, the VM starts, the project loads, and no extension exists. The only
 * signal is size, so the extensions the loader found are passed back in and the output is measured
 * against what those extensions must contribute.
 */
for (const app of Object.keys(config.apps)) {
  const sb3Url = new URL(`apps/${app}/dist/${app}.sb3`, repositoryRoot);
  const sb3 = await readFile(sb3Url).catch(() => null);
  if (sb3 === null) {
    failures.push(`${app}: build the SB3 first (apps/${app}/dist/${app}.sb3 is missing)`);
    continue;
  }

  const project = await Packager.loadProject(sb3);
  const extensions = project.analysis.extensions;
  if (extensions.length === 0) {
    failures.push(`${app}: the SB3 embeds no extension, so the app would have no blocks`);
    continue;
  }

  const packager = new Packager.Packager();
  packager.project = project;
  packager.options.target = 'html';
  packager.options.autoplay = true;
  // Without this the extensions are dropped without a word.
  packager.options.extensions = [...extensions];

  const {data} = await packager.package();

  /**
   * The packager base64-encodes what it inlines, so an output that kept the extensions cannot be
   * smaller than the project plus those extensions. A stripped build lands far below this floor.
   */
  const embeddedBytes = extensions.reduce((total, extension) => total + extension.length, 0);
  const floor = sb3.byteLength + embeddedBytes;
  if (data.byteLength < floor) {
    failures.push(
      `${app}: the player is ${data.byteLength} bytes, below the ${floor} needed to carry its extensions`
    );
    continue;
  }

  const target = new URL(`apps/${app}/dist/${app}-player.html`, repositoryRoot);
  await writeFile(target, data);
  console.log(
    `${app}: ${(data.byteLength / 1048576).toFixed(1)} MB player with ${extensions.length} extension(s)`
  );
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exitCode = 1;
}

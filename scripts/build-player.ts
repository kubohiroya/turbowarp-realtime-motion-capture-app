import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

import Packager from '@turbowarp/packager';

import {
  readJson,
  repositoryRoot,
  type LocalHostConfig,
} from './repository-config.ts';

const config = await readJson<LocalHostConfig>('config/local-host.json');
const failures: string[] = [];

/**
 * Packages one SB3 into the self-contained player a venue host serves.
 *
 * The packager removes an embedded extension that is not listed in `options.extensions`, and it does
 * so silently: the page opens, the VM starts, the project loads, and no extension exists. The only
 * signal is size, so the extensions the loader found are passed back in and the output is measured
 * against what those extensions must contribute.
 */
async function packagePlayer(
  label: string,
  sb3: Buffer,
  target: URL,
): Promise<boolean> {
  const project = await Packager.loadProject(sb3);
  const extensions = project.analysis.extensions;
  if (extensions.length === 0) {
    failures.push(
      `${label}: the SB3 embeds no extension, so the app would have no blocks`,
    );
    return false;
  }

  const packager = new Packager.Packager();
  packager.project = project;
  packager.options.target = 'html';
  packager.options.autoplay = true;
  // Without this the extensions are dropped without a word.
  packager.options.extensions = [...extensions];

  const { data } = await packager.package();

  /**
   * The packager base64-encodes what it inlines, so an output that kept the extensions cannot be
   * smaller than the project plus those extensions. A stripped build lands far below this floor.
   */
  const embeddedBytes = extensions.reduce(
    (total, extension) => total + extension.length,
    0,
  );
  const floor = sb3.byteLength + embeddedBytes;
  if (data.byteLength < floor) {
    failures.push(
      `${label}: the player is ${data.byteLength} bytes, below the ${floor} needed to carry its extensions`,
    );
    return false;
  }

  await writeFile(target, data);
  console.log(
    `${label}: ${(data.byteLength / 1048576).toFixed(1)} MB player with ${extensions.length} extension(s)`,
  );
  return true;
}

for (const [app, { lensCalibration }] of Object.entries(config.apps)) {
  const sb3Url = new URL(`apps/${app}/dist/${app}.sb3`, repositoryRoot);
  const sb3 = await readFile(sb3Url).catch(() => null);
  if (sb3 === null) {
    failures.push(
      `${app}: build the SB3 first (apps/${app}/dist/${app}.sb3 is missing)`,
    );
    continue;
  }
  await packagePlayer(
    app,
    sb3,
    new URL(`apps/${app}/dist/${app}-player.html`, repositoryRoot),
  );

  if (lensCalibration === undefined) continue;
  /**
   * The lens calibration app is built in its own repository and has no published artifact yet, so
   * its SB3 is placed by hand. Its absence is not a failure: the camera app then reports that no
   * calibration app is available and offers the profile file instead. The digest is printed so a
   * venue build can be traced to the SB3 it carried.
   */
  const calibrationSb3 = await readFile(
    new URL(lensCalibration.sb3, repositoryRoot),
  ).catch(() => null);
  if (calibrationSb3 === null) {
    console.warn(
      `${app}: no lens calibration SB3 at ${lensCalibration.sb3} (build it in ${lensCalibration.repository}); skipped`,
    );
    continue;
  }
  const digest = createHash('sha256').update(calibrationSb3).digest('hex');
  console.log(`${app}: lens calibration SB3 sha256 ${digest}`);
  await packagePlayer(
    `${app} lens calibration`,
    calibrationSb3,
    new URL(
      `apps/${app}/dist/${app}-lens-calibration-player.html`,
      repositoryRoot,
    ),
  );
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exitCode = 1;
}

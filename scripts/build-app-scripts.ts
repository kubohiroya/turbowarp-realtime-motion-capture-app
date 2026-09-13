import {readFile, writeFile} from 'node:fs/promises';

import {buildBlocks, type Script} from '../packages/sb3-script/src/blocks.ts';

import {cameraAppScripts} from './app-scripts/camera-app.ts';
import {fusionAppScripts} from './app-scripts/fusion-app.ts';
import {formatJson, readJson, repositoryRoot, type ProjectSource} from './repository-config.ts';

const writeTracked = process.argv.includes('--write');
const applications: ReadonlyArray<readonly [string, readonly Script[]]> = [
  ['camera-app', cameraAppScripts],
  ['fusion-app', fusionAppScripts]
];

interface StageTarget {
  isStage?: boolean;
  blocks: Record<string, unknown>;
}

const differences: string[] = [];

/**
 * Writes each application's scripts into its expanded SB3 source.
 *
 * The authored form in `scripts/app-scripts/` is the one a reviewer reads; the flat block map is
 * generated, because a diff of linked block ids says nothing about what changed.
 */
for (const [app, scripts] of applications) {
  const projectUrl = new URL(`apps/${app}/source/project.source.json`, repositoryRoot);
  const project = await readJson<ProjectSource & {targets: StageTarget[]}>(projectUrl);
  const stage = project.targets.find((target) => target.isStage === true);
  if (stage === undefined) throw new Error(`${app} has no stage target.`);

  stage.blocks = buildBlocks(scripts);
  const contents = formatJson(project);
  const existing = await readFile(projectUrl, 'utf8').catch(() => null);
  if (existing === contents) continue;
  if (!writeTracked) {
    differences.push(`apps/${app}/source/project.source.json is out of date`);
    continue;
  }
  await writeFile(projectUrl, contents);
}

if (differences.length > 0) {
  console.error(differences.map((difference) => `- ${difference}`).join('\n'));
  console.error('Run `pnpm run build:scripts` after editing scripts/app-scripts.');
  process.exitCode = 1;
} else {
  console.log(`Application scripts match scripts/app-scripts (${applications.length} applications).`);
}

import {readFile, writeFile} from 'node:fs/promises';

import {buildBlocks} from '../packages/sb3-script/src/blocks.ts';

import {cameraAppScripts, cameraAppStageData} from './app-scripts/camera-app.ts';
import {fusionAppScripts, fusionAppStageData} from './app-scripts/fusion-app.ts';
import {localAppScripts, localAppStageData} from './app-scripts/local-app.ts';
import {formatJson, readJson, repositoryRoot, type ProjectSource} from './repository-config.ts';

const writeTracked = process.argv.includes('--write');
const applications = [
  {app: 'camera-app', scripts: cameraAppScripts, stageData: cameraAppStageData},
  {app: 'fusion-app', scripts: fusionAppScripts, stageData: fusionAppStageData},
  {app: 'local-app', scripts: localAppScripts, stageData: localAppStageData}
] as const;

interface StageTarget {
  isStage?: boolean;
  blocks: Record<string, unknown>;
  variables: Record<string, unknown>;
  lists?: Record<string, unknown>;
  broadcasts: Record<string, unknown>;
}

const differences: string[] = [];

/**
 * Writes each application's scripts into its expanded SB3 source.
 *
 * The authored form in `scripts/app-scripts/` is the one a reviewer reads; the flat block map is
 * generated, because a diff of linked block ids says nothing about what changed.
 */
for (const {app, scripts, ...application} of applications) {
  const projectUrl = new URL(`apps/${app}/source/project.source.json`, repositoryRoot);
  const project = await readJson<ProjectSource & {targets: StageTarget[]}>(projectUrl);
  const stage = project.targets.find((target) => target.isStage === true);
  if (stage === undefined) throw new Error(`${app} has no stage target.`);

  stage.blocks = buildBlocks(scripts);
  if ('stageData' in application) {
    stage.variables = application.stageData.variables;
    stage.broadcasts = application.stageData.broadcasts;
    if ('lists' in application.stageData) stage.lists = application.stageData.lists;
  }
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

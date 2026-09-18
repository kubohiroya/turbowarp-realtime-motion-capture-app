import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Plugin } from 'vite';

import {
  poseModelModeOf,
  poseModelRoute,
  readPinnedPoseModel,
  readPoseModelPin,
} from './pose-model-files.js';

const moduleId = 'virtual:twrmc-pose-model';
const resolvedId = `\0${moduleId}`;

/**
 * Decides at build time where the app shell tells the pose pipeline to find the MoveNet model.
 *
 * `TWRMC_POSE_MODEL` chooses:
 *
 * - `hub` (or unset): nothing is given, and the extension loads the model from TF Hub.
 * - `local`: the model is served by the application's own venue host, under
 *   `/models/<id>/`. The build writes `pose-model.json` beside the shell saying so, and
 *   `serve:app` and `build:binary` read it to serve the model files with the player.
 * - `embedded`: the model is carried inside the shell, 9.7 MB of it, and handed over from memory.
 *
 * `local` and `embedded` read the model from models/<id>/, checked against config/pose-model.json;
 * a build that cannot find the pinned model stops.
 */
export function poseModel(): Plugin {
  const mode = poseModelModeOf(process.env['TWRMC_POSE_MODEL']);
  let outDir = '';
  return {
    name: 'twrmc-pose-model',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    resolveId(source) {
      return source === moduleId ? resolvedId : null;
    },
    async load(id) {
      if (id !== resolvedId) return null;
      const pin = await readPoseModelPin();
      if (mode === 'hub') return `export default ${JSON.stringify({ mode })};`;
      if (mode === 'local') {
        const url = `${poseModelRoute(pin)}model.json`;
        return `export default ${JSON.stringify({ mode, url })};`;
      }
      const files = await readPinnedPoseModel(pin);
      const modelJson = JSON.parse(
        new TextDecoder().decode(files.get('model.json')),
      ) as { weightsManifest: { paths: string[] }[] };
      const weights = modelJson.weightsManifest
        .flatMap((group) => group.paths)
        .map((path) => {
          const bytes = files.get(path);
          if (bytes === undefined) {
            throw new Error(`model.json names ${path}, which is not pinned.`);
          }
          return Buffer.from(bytes).toString('base64');
        });
      return `export default ${JSON.stringify({ mode, modelJson, weights })};`;
    },
    // Written beside the shell after the build rather than emitted into it: the extension plugin
    // allows the bundle one output, the shell itself.
    async closeBundle() {
      await writeFile(
        resolve(outDir, 'pose-model.json'),
        `${JSON.stringify({ mode }, null, 2)}\n`,
      );
    },
  };
}

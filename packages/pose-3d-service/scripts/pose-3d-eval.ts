/**
 * The evaluation tool for the 3D service (#34, stage 2).
 *
 * Three commands, and they compose: `synthesize` writes a session, `replay` runs one through an
 * implementation and writes what came back, `evaluate` does both and prints the figures. Sessions and
 * answers are files so a venue recording and a synthetic scene are handled the same way, and so a
 * figure in an issue can be reproduced from the file it came from.
 *
 *   node --experimental-strip-types packages/pose-3d-service/scripts/pose-3d-eval.ts evaluate \
 *     --cameras 4 --persons 3 --seconds 10 --implementation stub-normal
 */

import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {evaluate, formatMetrics} from '../src/metrics.ts';
import {replaySession} from '../src/replay.ts';
import {parseSession, serializeSession, type Session} from '../src/session.ts';
import {generateScene, DEFAULT_SCENE} from '../src/synthetic.ts';
import {IMPLEMENTATIONS, type ImplementationId} from '../src/contracts.ts';

const usage = `Usage:
  pose-3d-eval synthesize [--out <file>] [--seed n] [--cameras n] [--persons n] [--seconds n]
                          [--frame-rate n] [--noise-px n] [--occlusion-rate n] [--identity-switch-rate n]
  pose-3d-eval replay --session <file> [--implementation ${IMPLEMENTATIONS.join('|')}] [--out <file>]
  pose-3d-eval evaluate [--session <file>] [--implementation ...] [--json] [same scene options]

Without --session, evaluate generates a scene with the options given.`;

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0];
  const options = parseArguments(argv.slice(1));
  if (command === undefined || command === '--help' || command === 'help') {
    console.log(usage);
    return command === undefined ? 1 : 0;
  }
  if (!['synthesize', 'replay', 'evaluate'].includes(command)) {
    console.error(`Unknown command ${command}.\n\n${usage}`);
    return 1;
  }

  if (command === 'synthesize') {
    const {session} = generateScene(sceneOptions(options));
    await write(options['out'] ?? 'pose-3d-session.json', serializeSession(session));
    console.log(`${session.events.length} events, ${session.truth?.length ?? 0} truth frames: ${options['out'] ?? 'pose-3d-session.json'}`);
    return 0;
  }

  const session = options['session'] ? await readSession(options['session']) : generateScene(sceneOptions(options)).session;
  const implementation = readImplementation(options['implementation']);
  const replay = replaySession(session, implementation ? {implementation} : {});

  if (command === 'replay') {
    const target = options['out'] ?? 'pose-3d-answers.json';
    await write(target, JSON.stringify({producer: session.producer, implementation: implementation ?? session.configuration.implementation, answers: replay.answers}));
    console.log(`${replay.answers.length} answers, ${replay.errors.length} errors: ${target}`);
    return 0;
  }

  const metrics = evaluate(session, replay);
  console.log(options['json'] === '' ? JSON.stringify(metrics, null, 2) : `${session.producer}\n${formatMetrics(metrics)}`);
  return 0;
}

function sceneOptions(options: Record<string, string>): Parameters<typeof generateScene>[0] {
  const number = (name: string, key: keyof typeof DEFAULT_SCENE) =>
    options[name] === undefined ? undefined : {[key]: Number(options[name])};
  return {
    ...number('seed', 'seed'),
    ...number('cameras', 'cameras'),
    ...number('persons', 'persons'),
    ...number('seconds', 'seconds'),
    ...number('frame-rate', 'frameRate'),
    ...number('noise-px', 'noisePx'),
    ...number('occlusion-rate', 'occlusionRate'),
    ...number('identity-switch-rate', 'identitySwitchRate')
  };
}

function readImplementation(value: string | undefined): ImplementationId | undefined {
  if (value === undefined) return undefined;
  if (!IMPLEMENTATIONS.includes(value as ImplementationId)) {
    throw new Error(`Unknown implementation ${value}. One of: ${IMPLEMENTATIONS.join(', ')}`);
  }
  return value as ImplementationId;
}

async function readSession(path: string): Promise<Session> {
  const parsed = parseSession(await readFile(path, 'utf8'));
  if (!parsed.ok) throw new Error(`${path}: ${parsed.reason}`);
  return parsed.session;
}

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, `${text}\n`);
}

/** `--name value` and `--flag`, which is all this tool needs. */
function parseArguments(argv: readonly string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined || !argument.startsWith('--')) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      options[argument.slice(2)] = '';
      continue;
    }
    options[argument.slice(2)] = next;
    index += 1;
  }
  return options;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

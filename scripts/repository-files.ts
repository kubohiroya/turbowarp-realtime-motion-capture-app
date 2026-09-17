import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);

/** Every file Git would consider part of the repository, tracked or newly added but not ignored. */
export async function repositoryFiles(): Promise<string[]> {
  const { stdout } = await executeFile('git', [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
  ]);
  return stdout.trim().split('\n').filter(Boolean).sort();
}

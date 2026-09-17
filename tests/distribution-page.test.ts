import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import config from '../config/app.json';
import { featureFlags } from '../config/feature-flags.ts';

const root = new URL('../', import.meta.url);
const englishModes: Readonly<
  Record<string, { label: string; description: string }>
> = config.en.modes;

describe('distribution page configuration', () => {
  it('offers one mode per application in the repository', async () => {
    const apps = (
      await readdir(new URL('apps/', root), { withFileTypes: true })
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(
      config.modes.map((mode) => mode.sb3.replace(/\.sb3$/, '')).sort(),
    ).toEqual(apps);
  });

  it('names the SB3 each application actually builds', async () => {
    for (const mode of config.modes) {
      const app = mode.sb3.replace(/\.sb3$/, '');
      const manifest = await readFile(
        new URL(`apps/${app}/package.json`, root),
        'utf8',
      );
      expect(manifest).toContain(`dist/${mode.sb3}`);
    }
  });

  it('translates every mode for the English page', () => {
    for (const mode of config.modes) {
      expect(englishModes[mode.id]?.label).toBeTruthy();
      expect(englishModes[mode.id]?.description).toBeTruthy();
    }
  });

  it('leaves every page feature flag off', () => {
    expect(Object.values(featureFlags).every((value) => value === false)).toBe(
      true,
    );
  });
});

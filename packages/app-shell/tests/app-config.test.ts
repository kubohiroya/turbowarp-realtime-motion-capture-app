import {describe, expect, it} from 'vitest';

import {validateAppConfig, type AppShellAppConfig} from '../src/app-config.js';
import {cameraAppConfig} from '../src/apps/camera.js';
import {fusionAppConfig} from '../src/apps/fusion.js';
import {featureFlagNames, resolveFeatureFlags} from '../src/feature-flags.js';

const shippedConfigs: readonly AppShellAppConfig[] = [cameraAppConfig, fusionAppConfig];

describe('shipped application configurations', () => {
  it('use valid extension IDs', () => {
    for (const config of shippedConfigs) expect(validateAppConfig(config)).toBe(config);
  });

  it('request only flags the contract extension defines', () => {
    for (const config of shippedConfigs) {
      expect(() => resolveFeatureFlags(config.featureFlags)).not.toThrow();
      for (const flag of config.featureFlags) expect(featureFlagNames).toContain(flag);
    }
  });

  it('keep the two shells under distinct extension IDs', () => {
    expect(cameraAppConfig.id).not.toBe(fusionAppConfig.id);
  });

});

describe('validateAppConfig', () => {
  it('rejects an extension ID TurboWarp cannot use', () => {
    expect(() => validateAppConfig({...cameraAppConfig, id: 'Camera-Shell'})).toThrow(/Extension ID/);
  });

});

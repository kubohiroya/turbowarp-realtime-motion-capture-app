import { describe, expect, it } from 'vitest';

import { fileProblem, poseModelModeOf, sha256Of } from '../pose-model-files.js';
import {
  installPoseModel,
  poseModelGlobalKey,
  poseModelGlobalValue,
} from '../src/pose-model.js';

const base64Of = (bytes: readonly number[]) =>
  btoa(String.fromCharCode(...bytes));

describe('the MoveNet model the build hands over', () => {
  it('leaves TF Hub in charge for an ordinary build', () => {
    const target: Record<string, unknown> = {};
    installPoseModel({ mode: 'hub' }, target, '?token=abc');
    expect(target).toEqual({});
  });

  it('points at the venue host, with the token the page was opened with', () => {
    expect(
      poseModelGlobalValue(
        { mode: 'local', url: '/models/movenet/model.json' },
        '?token=a%2Fb+c',
      ),
    ).toEqual({ url: '/models/movenet/model.json?token=a%2Fb%20c' });
    expect(
      poseModelGlobalValue(
        { mode: 'local', url: '/models/movenet/model.json' },
        '',
      ),
    ).toEqual({ url: '/models/movenet/model.json' });
  });

  it('decodes a model carried in the shell into the shards the extension takes', () => {
    const modelJson = { weightsManifest: [] };
    const target: Record<string, unknown> = {};
    installPoseModel(
      {
        mode: 'embedded',
        modelJson,
        weights: [base64Of([0, 1, 255]), base64Of([65, 66])],
      },
      target,
      '',
    );
    const value = target[poseModelGlobalKey] as {
      modelJson: unknown;
      weights: Uint8Array[];
    };
    expect(value.modelJson).toBe(modelJson);
    expect(value.weights.map((shard) => [...shard])).toEqual([
      [0, 1, 255],
      [65, 66],
    ]);
  });
});

describe('the build setting and the pinned files', () => {
  it('reads TWRMC_POSE_MODEL and refuses anything unknown', () => {
    expect(poseModelModeOf(undefined)).toBe('hub');
    expect(poseModelModeOf(' ')).toBe('hub');
    expect(poseModelModeOf('local')).toBe('local');
    expect(poseModelModeOf('embedded')).toBe('embedded');
    expect(() => poseModelModeOf('offline')).toThrow(/TWRMC_POSE_MODEL/);
  });

  it('accepts only the pinned bytes', () => {
    const bytes = new TextEncoder().encode('model');
    const pin = { name: 'model.json', bytes: 5, sha256: sha256Of(bytes) };
    expect(fileProblem(pin, bytes)).toBeNull();
    expect(fileProblem(pin, null)).toMatch(/missing/);
    expect(fileProblem(pin, bytes.subarray(1))).toMatch(/4 bytes, not 5/);
    expect(fileProblem(pin, new TextEncoder().encode('MODEL'))).toMatch(
      /SHA-256/,
    );
  });
});

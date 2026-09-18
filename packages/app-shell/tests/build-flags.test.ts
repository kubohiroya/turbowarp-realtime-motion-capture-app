import { describe, expect, it } from 'vitest';

import { parseAppFlags, withAppFlags } from '../src/app-config.js';
import { cameraAppConfig } from '../src/apps/camera.js';
import { buildAppFlags } from '../src/build-flags.js';

describe('flags turned on by a measurement build', () => {
  it('reads a comma separated list, ignoring spaces, blanks and repeats', () => {
    expect(parseAppFlags('')).toEqual([]);
    expect(parseAppFlags(' debugPoseReplayV1 , ,debugPoseReplayV1')).toEqual([
      'debugPoseReplayV1',
    ]);
    expect(parseAppFlags('debugPoseReplayV1,external3dServiceV1')).toEqual([
      'debugPoseReplayV1',
      'external3dServiceV1',
    ]);
  });

  it('stops the build on a flag that does not exist, rather than measuring nothing', () => {
    expect(() => parseAppFlags('debugPoseReplay')).toThrow(
      /Unknown application flag debugPoseReplay/u,
    );
  });

  it('adds them to an application without touching its own configuration', () => {
    const measured = withAppFlags(cameraAppConfig, ['debugPoseReplayV1']);
    expect(measured.appFlags).toEqual(['debugPoseReplayV1']);
    expect(cameraAppConfig.appFlags).toBeUndefined();
    expect(withAppFlags(cameraAppConfig, [])).toBe(cameraAppConfig);
  });

  it('turns nothing on when the source runs as it is, as it does under the tests', () => {
    expect(buildAppFlags).toEqual([]);
  });
});

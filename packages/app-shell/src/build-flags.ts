import { parseAppFlags, type AppFlagName } from './app-config.js';

/**
 * Replaced at build time with `TWRMC_APP_FLAGS`, which is empty for every build but a measurement one.
 * Absent when the source runs untransformed, as it does under the tests.
 */
declare const __TWRMC_APP_FLAGS__: string | undefined;

/**
 * Flags turned on for this build rather than by the application's own configuration.
 *
 * A measurement on real hardware needs the recording that DEBUG_POSE_REPLAY provides, and the
 * distributed applications leave it off. Building with `TWRMC_APP_FLAGS=debugPoseReplayV1` turns it
 * on without editing any application's configuration, so a measurement build cannot be committed by
 * mistake: it is only ever the product of how it was built.
 */
export const buildAppFlags: readonly AppFlagName[] = parseAppFlags(
  typeof __TWRMC_APP_FLAGS__ === 'string' ? __TWRMC_APP_FLAGS__ : '',
);

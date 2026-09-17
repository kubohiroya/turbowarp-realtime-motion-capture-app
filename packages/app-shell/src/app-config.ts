import type {AppShellMessageLocales} from '@kubohiroya/turbowarp-app-shell';

import type {FeatureFlagName} from './feature-flags.js';

export type ShellLocale = 'en' | 'ja';

/**
 * One application's shell configuration.
 *
 * The title dialog and the application menu are not here: they come from the shared
 * `@kubohiroya/turbowarp-title-menu` extension, which sits next to this one in the SB3 bundle. This
 * package owns only what that extension does not provide — the startup feature flags, the loading
 * overlay, and the runtime message overlay.
 */
export interface AppShellAppConfig {
  /** TurboWarp extension ID in `[a-z0-9]+` form. */
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly author: string;
  readonly license: string;
  readonly docsURI: string;
  readonly blockIconURI: string;
  /** Flags this application needs from the pinned contract extension. */
  readonly featureFlags: readonly FeatureFlagName[];
  /** Heading for ordinary notices. Must not claim anything went wrong. */
  readonly noticeLocales: AppShellMessageLocales;
  /** Heading for a failure that stopped the application. */
  readonly errorLocales: AppShellMessageLocales;
  /**
   * Whether this application offers the lens calibration entry: opening the calibration app beside
   * it and choosing a profile file. Only the camera app owns a camera to calibrate.
   */
  readonly lensCalibration?: boolean;
  /**
   * Whether this application uses `turbowarp-time-space-sync` for optical time correspondence and
   * placement. The shell writes that extension's startup flags from this, before it is evaluated.
   */
  readonly timeSpaceSync?: boolean;
  /**
   * Application flags, fixed at startup and off unless listed. Unlike `featureFlags` they are not
   * handed to any extension: they only decide which paths this application's own scripts offer.
   */
  readonly appFlags?: readonly AppFlagName[];
}

export const appFlagNames = ['external3dServiceV1'] as const;
export type AppFlagName = (typeof appFlagNames)[number];

const idPattern = /^[a-z0-9]+$/;

/** Validates one application configuration before a build or a registration uses it. */
export function validateAppConfig(config: AppShellAppConfig): AppShellAppConfig {
  if (!idPattern.test(config.id)) {
    throw new TypeError(`Extension ID must match ${String(idPattern)}: ${config.id}`);
  }
  return config;
}

import type {AppShellAppConfig} from './app-config.js';
import {applyFeatureFlags, contractAlreadyLoaded} from './feature-flags.js';
import {createBrowserLensCalibrationHost, createScratchShellHost} from './host.js';
import {LensCalibrationLauncher} from './lens-calibration.js';
import {createMultiviewPoseShell} from './shell.js';
import {MultiviewPoseAppShellExtension} from './extension.js';

/**
 * Applies the contract feature flags and registers the app shell extension.
 *
 * The flag write happens before the extension instance exists so that it also precedes every later
 * bundle member. Import this module's caller as the first member of the SB3 extension bundle.
 *
 * The title dialog, the application menu, and DSL file storage come from
 * `@kubohiroya/turbowarp-title-menu`, which follows this extension in the same bundle.
 */
export function registerAppShell(config: AppShellAppConfig): void {
  const flags = applyFeatureFlags(config.featureFlags, {contractLoaded: contractAlreadyLoaded});
  const shell = createMultiviewPoseShell(config, createScratchShellHost());
  const lensCalibration =
    config.lensCalibration === true
      ? new LensCalibrationLauncher(createBrowserLensCalibrationHost(shell.locale))
      : null;
  Scratch.extensions.register(
    new MultiviewPoseAppShellExtension(config, shell, flags, lensCalibration)
  );
}

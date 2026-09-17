import type {AppShellAppConfig} from './app-config.js';
import {applyFeatureFlags, contractAlreadyLoaded} from './feature-flags.js';
import {createBrowserLensCalibrationHost, createScratchShellHost} from './host.js';
import {LensCalibrationLauncher} from './lens-calibration.js';
import {createScratchNetworkRouterHost, NetworkRouter} from './network-router.js';
import {createQrPanel} from './qr-panel.js';
import {CameraGrid, createScratchCameraGridHost} from './camera-grid.js';
import {browserStorage, createSettingsStore} from './settings.js';
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
  const flags = applyFeatureFlags(config.featureFlags, {
    contractLoaded: contractAlreadyLoaded,
    timeSpaceSync: config.timeSpaceSync === true
  });
  const shell = createMultiviewPoseShell(config, createScratchShellHost());
  const qrPanel = createQrPanel({document: typeof document === 'undefined' ? null : document});
  // The stop sign ends every exchange the pairing extension owns, so nothing is left for a panel to
  // show; leaving it up would cover the stage with a code nobody can use.
  Scratch.vm?.runtime?.on?.('PROJECT_STOP_ALL', () => qrPanel.hide());
  Scratch.extensions.register(
    new MultiviewPoseAppShellExtension(config, shell, flags, {
      qrPanel,
      dialogs: {document: typeof document === 'undefined' ? null : document},
      network: new NetworkRouter(createScratchNetworkRouterHost()),
      settings: createSettingsStore(`twrmc.${config.id}`, browserStorage),
      ...(config.cameraGrid === true ? {cameraGrid: createCameraGrid()} : {}),
      ...(config.lensCalibration === true
        ? {lensCalibration: new LensCalibrationLauncher(createBrowserLensCalibrationHost(shell.locale))}
        : {})
    })
  );
}

/** The grid releases its cameras with the project, as Camera Source releases its own. */
function createCameraGrid(): CameraGrid {
  const grid = new CameraGrid(createScratchCameraGridHost());
  Scratch.vm?.runtime?.on?.('PROJECT_STOP_ALL', () => void grid.stopAll());
  return grid;
}

/**
 * Startup-fixed feature flags owned by `@kubohiroya/turbowarp-realtime-motion-capture`.
 *
 * That extension freezes its flag set while its module body runs, so the value has to exist on the
 * global object before its source is evaluated. Inside a static extension bundle the member order in
 * `embedded-extensions.json` decides evaluation order, which is why the app shell is always member
 * one and the contract extension follows it.
 */
export const featureFlagNames = [
  'qrCourierPairing',
  'webgpuMoveNetMultiPose',
  'protocolV1Codec',
  'cameraCalibrationV1',
  'avatarRetargetV1',
  'frameSyncPatternV1',
  'poseFusion3D',
  'glowStickMarkers'
] as const;

export type FeatureFlagName = (typeof featureFlagNames)[number];

export type FeatureFlagSet = Readonly<Record<FeatureFlagName, boolean>>;

export const featureFlagGlobalKey = '__TWMP_FEATURE_FLAGS__';

/**
 * Startup flags read by `@kubohiroya/turbowarp-webrtc-qrcode-pairing`.
 *
 * That extension, like the contract extension, reads its flag once while its module body runs, so
 * the shell writes it in the same place and for the same reason. Its one flag follows this app's
 * `qrCourierPairing`: an application either pairs by QR or it does not, and two switches for one
 * path would let them disagree.
 */
export const pairingFlagGlobalKey = '__TWQP_FEATURE_FLAGS__';

/**
 * Startup flags read by `@kubohiroya/turbowarp-time-space-sync`.
 *
 * Time correspondence and placement are one step in these apps — the same projected pattern serves
 * both — so both flags follow the application's single `timeSpaceSync` setting.
 */
export const timeSpaceSyncFlagGlobalKey = '__TWTSS_FEATURE_FLAGS__';

/** The runtime key the contract extension registers itself under once it has read the flags. */
export const contractRuntimeKey = 'ext_kubohiroyarealtimemotioncapture';

export type FeatureFlagApplicationState = 'applied' | 'replaced' | 'too-late';

export interface FeatureFlagApplication {
  readonly flags: FeatureFlagSet;
  readonly state: FeatureFlagApplicationState;
}

const knownNames: ReadonlySet<string> = new Set(featureFlagNames);

/** Builds the complete flag set. Every name the app does not request stays explicitly `false`. */
export function resolveFeatureFlags(enabled: readonly string[]): FeatureFlagSet {
  const unknown = enabled.filter((name) => !knownNames.has(name));
  if (unknown.length > 0) {
    throw new TypeError(`Unknown realtime motion capture app feature flags: ${unknown.join(', ')}`);
  }
  const requested = new Set(enabled);
  return Object.freeze(
    Object.fromEntries(featureFlagNames.map((name) => [name, requested.has(name)]))
  ) as FeatureFlagSet;
}

export interface ApplyFeatureFlagsOptions {
  readonly target?: Record<string, unknown>;
  /** Enables the time-space-sync extension's optical time and placement blocks. */
  readonly timeSpaceSync?: boolean;
  /** Reports whether the contract extension has already been evaluated. */
  readonly contractLoaded?: () => boolean;
}

/**
 * Writes the flag set to the global the contract extension reads.
 *
 * A `too-late` result means the contract extension was evaluated first and has already frozen its
 * own flags. The write still happens so a later reload observes the intended set, but the running
 * session is reported as misconfigured instead of silently running with everything disabled.
 */
export function applyFeatureFlags(
  enabled: readonly string[],
  options: ApplyFeatureFlagsOptions = {}
): FeatureFlagApplication {
  const flags = resolveFeatureFlags(enabled);
  const target = options.target ?? (globalThis as unknown as Record<string, unknown>);
  const previous = target[featureFlagGlobalKey];
  target[featureFlagGlobalKey] = flags;
  target[pairingFlagGlobalKey] = Object.freeze({qrCodePairing: flags.qrCourierPairing});
  const timeSpaceSync = options.timeSpaceSync === true;
  target[timeSpaceSyncFlagGlobalKey] = Object.freeze({
    opticalTimeSyncV1: timeSpaceSync,
    placementSolveV1: timeSpaceSync
  });
  if (options.contractLoaded?.() === true) return {flags, state: 'too-late'};
  return {flags, state: previous === undefined ? 'applied' : 'replaced'};
}

/** Default probe: the contract extension stores itself on the VM runtime when it registers. */
export function contractAlreadyLoaded(): boolean {
  const runtime = (globalThis as {Scratch?: {vm?: {runtime?: Record<string, unknown>}}}).Scratch?.vm
    ?.runtime;
  return runtime !== undefined && runtime[contractRuntimeKey] !== undefined;
}

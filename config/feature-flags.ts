// SPDX-License-Identifier: MPL-2.0
// Read once when the distribution page starts. Turning a flag ON does not implement a runtime.
//
// These are the distribution page's own flags. The flags the SB3s fix at startup live elsewhere and
// are not read here: the pinned contract extension's flags in
// `packages/app-shell/src/feature-flags.ts`, and each application's own flags in
// `packages/app-shell/src/app-config.ts`.
export const featureFlags = Object.freeze({
  /** Embed the TurboWarp player in the page instead of offering the SB3 for download. */
  embeddedPlayer: false,
});

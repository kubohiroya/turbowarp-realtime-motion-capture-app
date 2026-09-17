import {describe, expect, it} from 'vitest';

import {
  applyFeatureFlags,
  featureFlagGlobalKey,
  featureFlagNames,
  pairingFlagGlobalKey,
  resolveFeatureFlags
} from '../src/feature-flags.js';

describe('resolveFeatureFlags', () => {
  it('returns every known flag with the unrequested ones explicitly disabled', () => {
    const flags = resolveFeatureFlags(['protocolV1Codec']);
    expect(Object.keys(flags).sort()).toEqual([...featureFlagNames].sort());
    expect(flags.protocolV1Codec).toBe(true);
    expect(flags.poseFusion3D).toBe(false);
  });

  it('rejects a flag the contract extension does not define', () => {
    expect(() => resolveFeatureFlags(['poseFusion2D'])).toThrow(/Unknown/);
  });
});

describe('applyFeatureFlags', () => {
  it('writes the flags to the global the contract extension reads', () => {
    const target: Record<string, unknown> = {};
    const result = applyFeatureFlags(['protocolV1Codec'], {target});
    expect(result.state).toBe('applied');
    expect(target[featureFlagGlobalKey]).toBe(result.flags);
  });

  it('writes the QR pairing flag from qrCourierPairing, and writes it off as well as on', () => {
    const on: Record<string, unknown> = {};
    const off: Record<string, unknown> = {};
    applyFeatureFlags(['qrCourierPairing'], {target: on});
    applyFeatureFlags(['protocolV1Codec'], {target: off});
    expect(on[pairingFlagGlobalKey]).toEqual({qrCodePairing: true});
    expect(off[pairingFlagGlobalKey]).toEqual({qrCodePairing: false});
  });

  it('reports a replaced set so a second shell in one bundle is visible', () => {
    const target: Record<string, unknown> = {[featureFlagGlobalKey]: {}};
    expect(applyFeatureFlags([], {target}).state).toBe('replaced');
  });

  it('reports too-late when the contract extension already froze its own flags', () => {
    const target: Record<string, unknown> = {};
    const result = applyFeatureFlags(['protocolV1Codec'], {
      target,
      contractLoaded: () => true
    });
    expect(result.state).toBe('too-late');
    expect(target[featureFlagGlobalKey]).toBe(result.flags);
  });
});

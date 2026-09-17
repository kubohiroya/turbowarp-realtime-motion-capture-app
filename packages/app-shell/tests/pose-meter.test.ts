import { describe, expect, it } from 'vitest';

import { PoseMeter } from '../src/pose-meter.js';

function meter() {
  const clock = { nowMs: 0, pageTimeUs: 1_000_000_000 };
  return {
    clock,
    meter: new PoseMeter({
      nowMs: () => clock.nowMs,
      pageTimeUs: () => clock.pageTimeUs,
    }),
  };
}

const status = (fields: Record<string, unknown>) =>
  JSON.stringify({
    state: 'ready',
    error: '',
    frameTimeSource: 'capture',
    persons: 1,
    ...fields,
  });

describe('PoseMeter', () => {
  it('measures each camera over one-second windows, and the round and capture spread across cameras', () => {
    const { clock, meter: m } = meter();
    // Two cameras taking turns; each inference 20 ms, a round every 50 ms.
    for (let round = 0; round <= 20; round += 1) {
      clock.nowMs = round * 50;
      clock.pageTimeUs = 1_000_000_000 + round * 50_000;
      m.record(
        'cam-1',
        status({
          inferences: round,
          skippedFrames: 0,
          lastInferenceMs: 20.04,
          captureTimestampUs: clock.pageTimeUs - 60_000,
          persons: 2,
        }),
      );
      m.record(
        'cam-2',
        status({
          inferences: round,
          skippedFrames: round,
          lastInferenceMs: 18,
          captureTimestampUs: clock.pageTimeUs - 45_000,
        }),
      );
      m.endCycle();
    }
    const measurement = m.measurement();
    expect(measurement.cycleMs).toBe(50);
    expect(measurement.captureSpreadMs).toBe(15);
    expect(measurement.cameras).toEqual([
      {
        cameraId: 'cam-1',
        state: 'ready',
        error: '',
        inferenceMs: 20,
        inferenceFps: 20,
        skippedFps: 0,
        captureToResultMs: 60,
        frameTimeSource: 'capture',
        persons: 2,
      },
      {
        cameraId: 'cam-2',
        state: 'ready',
        error: '',
        inferenceMs: 18,
        inferenceFps: 20,
        skippedFps: 20,
        captureToResultMs: 45,
        frameTimeSource: 'capture',
        persons: 1,
      },
    ]);
    expect(m.summary()).toBe(
      '1周50ms 撮影時刻のばらつき15ms — cam-1: 推論20ms 20fps 撮影→結果60ms 2人 / cam-2: 推論18ms 20fps 撮影→結果45ms 1人',
    );
  });

  it('keeps the delay of a frame until a new one is inferred, and names a presentation time', () => {
    const { clock, meter: m } = meter();
    m.record(
      'cam-1',
      status({
        inferences: 1,
        captureTimestampUs: 999_900_000,
        frameTimeSource: 'presentation',
      }),
    );
    clock.pageTimeUs += 500_000;
    // The same frame again: the camera gave its turn away, so the delay is not its age now.
    m.record(
      'cam-1',
      status({
        inferences: 1,
        captureTimestampUs: 999_900_000,
        frameTimeSource: 'presentation',
      }),
    );
    expect(m.measurement().cameras[0]?.captureToResultMs).toBe(100);
    expect(m.summary()).toContain('（撮影時刻なし・表示時刻で代用）');
  });

  it('ignores text that is not a status, reports errors, and forgets on reset', () => {
    const { meter: m } = meter();
    m.record('cam-1', '');
    m.record('cam-1', 'not json');
    m.record('cam-1', '[1]');
    expect(m.summary()).toBe('');
    m.record(
      'cam-1',
      status({ state: 'error', error: 'inference-failed: lost device' }),
    );
    expect(m.summary()).toContain(
      'cam-1: エラー inference-failed: lost device',
    );
    m.reset();
    expect(m.measurement()).toEqual({
      cameras: [],
      cycleMs: 0,
      captureSpreadMs: 0,
    });
  });

  it('reports how old a frame is from its capture time, and -1 for anything else', () => {
    const { clock, meter: m } = meter();
    expect(
      m.frameAgeMs(
        JSON.stringify({ captureTimestampUs: clock.pageTimeUs - 120_500 }),
      ),
    ).toBe(120.5);
    expect(m.frameAgeMs('')).toBe(-1);
    expect(m.frameAgeMs('{"captureTimestampUs":0}')).toBe(-1);
    expect(m.frameAgeMs('not json')).toBe(-1);
  });
});

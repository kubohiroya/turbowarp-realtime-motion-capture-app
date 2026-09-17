import { describe, expect, it, vi } from 'vitest';

import {
  PoseReplay,
  recordingFileName,
  type PoseReplayHost,
  type RecordingEntry,
} from '../src/pose-replay.js';

const configuration = {
  implementation: 'fusion-v0',
  referenceId: 'venue',
  cameras: [{ cameraId: 'cam-1' }, { cameraId: 'cam-2' }],
};

function frame(cameraId: string, captureTimestampUs: number, sequence = 0) {
  return JSON.stringify({
    schema: 'twrmc/pose-frame-2d',
    version: 1,
    cameraId,
    peerId: 'local',
    sequence,
    captureTimestampUs,
    frameWidth: 1280,
    frameHeight: 720,
    calibrationId: `cal-${cameraId}`,
    persons: [],
  });
}

function setup(
  options: {
    available?: boolean;
    files?: Record<string, string>;
    chosen?: string | null;
  } = {},
) {
  const clock = { us: 1_000_000_000 };
  const files = new Map(Object.entries(options.files ?? {}));
  const saved: Array<{ name: string; text: string }> = [];
  const host: PoseReplayHost = {
    pageTimeUs: () => clock.us,
    store: {
      available: () => options.available ?? true,
      list: async (): Promise<RecordingEntry[]> =>
        [...files.keys()].map((name) => ({
          name,
          bytes: files.get(name)?.length ?? 0,
          modifiedAt: '2026-09-18T04:00:00.000Z',
        })),
      read: async (name) => {
        const text = files.get(name);
        if (text === undefined)
          throw new Error(`録画 ${name} を読めません（404）。`);
        return text;
      },
      write: async (name, text) => {
        files.set(name, text);
      },
    },
    chooseFile: vi.fn(async () => options.chosen ?? null),
    saveFile: (name, text) => saved.push({ name, text }),
  };
  return { replay: new PoseReplay(host), clock, files, saved, host };
}

describe('recording', () => {
  it('records frames under the configuration they were estimated with', () => {
    const { replay } = setup();
    replay.startRecording(JSON.stringify(configuration));
    replay.recordFrame('cam-1', frame('cam-1', 1_000_000_000, 0));
    replay.recordFrame('cam-2', frame('cam-2', 1_000_010_000, 0));
    // The same frame again, because the camera had nothing new, is not recorded twice.
    replay.recordFrame('cam-2', frame('cam-2', 1_000_010_000, 0));
    replay.recordFrame('cam-1', frame('cam-1', 1_000_033_000, 1));
    replay.stopRecording();

    const session = JSON.parse(replay.recordingJson());
    expect(session).toMatchObject({
      schema: 'twrmc/pose-3d-session',
      version: 1,
      configuration,
    });
    expect(session.events).toHaveLength(3);
    expect(session.events[0]).toMatchObject({
      type: 'frame2d',
      cameraId: 'cam-1',
    });
    expect(replay.recordingStateName()).toBe('recorded');
    expect(replay.recordingSummary()).toContain('2台');
  });

  it('refuses to start without a configuration, because such a recording cannot be replayed', () => {
    const { replay } = setup();
    replay.startRecording('');
    expect(replay.recordingStateName()).toBe('idle');
    expect(replay.errorMessage()).toContain('設定');
    replay.recordFrame('cam-1', frame('cam-1', 1));
    expect(replay.recordingJson()).toBe('');
  });

  it('ignores anything that is not a frame with a capture time', () => {
    const { replay } = setup();
    replay.startRecording(JSON.stringify(configuration));
    replay.recordFrame('cam-1', '');
    replay.recordFrame('cam-1', 'not json');
    replay.recordFrame(
      'cam-1',
      JSON.stringify({ schema: 'twrmc/pose-frame-2d' }),
    );
    expect(replay.recordingJson()).toBe('');
    expect(replay.recordingSummary()).toContain('録画中: 0台');
  });
});

describe('recording limits', () => {
  it('keeps at most the asked frames a second, per camera', () => {
    const { replay } = setup();
    replay.startRecording(JSON.stringify(configuration), { fps: 10 });
    // 30 fps arriving, 10 fps asked for: one in three is kept, per camera.
    for (let index = 0; index < 30; index += 1) {
      const capture = 1_000_000_000 + index * 33_333;
      replay.recordFrame('cam-1', frame('cam-1', capture, index));
      replay.recordFrame('cam-2', frame('cam-2', capture, index));
    }
    const session = JSON.parse(replay.recordingJson());
    const perCamera = (cameraId: string) =>
      session.events.filter(
        (event: { cameraId: string }) => event.cameraId === cameraId,
      ).length;
    expect(perCamera('cam-1')).toBe(10);
    expect(perCamera('cam-2')).toBe(10);
    expect(replay.recordingSummary()).toContain('10fpsまで');
    expect(replay.recordingSummary()).toContain('間引き');
  });

  it('stops itself once the asked length has been recorded', () => {
    const { replay } = setup();
    replay.startRecording(JSON.stringify(configuration), { maxSeconds: 2 });
    for (let index = 0; index < 120; index += 1) {
      replay.recordFrame(
        'cam-1',
        frame('cam-1', 1_000_000_000 + index * 33_333, index),
      );
    }
    expect(replay.recordingStateName()).toBe('recorded');
    const session = JSON.parse(replay.recordingJson());
    expect(session.events).toHaveLength(61);
    const captures = session.events.map(
      (event: { frame: { captureTimestampUs: number } }) =>
        event.frame.captureTimestampUs,
    );
    expect(captures[captures.length - 1] - captures[0]).toBeLessThan(2_000_000);
    expect(replay.recordingSummary()).toContain('2秒まで');
  });

  it('records everything when no limit is asked for', () => {
    const { replay } = setup();
    replay.startRecording(JSON.stringify(configuration), {
      maxSeconds: 0,
      fps: -1,
    });
    for (let index = 0; index < 20; index += 1) {
      replay.recordFrame(
        'cam-1',
        frame('cam-1', 1_000_000_000 + index * 33_333, index),
      );
    }
    expect(JSON.parse(replay.recordingJson()).events).toHaveLength(20);
    expect(replay.recordingSummary()).not.toContain('指定');
  });

  it('judges the limits on the frames, not on the page clock', () => {
    const { replay, clock } = setup();
    replay.startRecording(JSON.stringify(configuration), {
      maxSeconds: 1,
      fps: 5,
    });
    // The page stalls between frames; what counts is when the frames were captured.
    for (let index = 0; index < 15; index += 1) {
      clock.us += 5_000_000;
      replay.recordFrame(
        'cam-1',
        frame('cam-1', 1_000_000_000 + index * 100_000, index),
      );
    }
    expect(replay.recordingStateName()).toBe('recorded');
    expect(JSON.parse(replay.recordingJson()).events).toHaveLength(5);
  });
});

describe('keeping and loading recordings', () => {
  it('writes to the venue host when one serves this page', async () => {
    const { replay, files } = setup();
    replay.startRecording(JSON.stringify(configuration));
    replay.recordFrame('cam-1', frame('cam-1', 1_000_000_000));
    await replay.save('Take 1');
    expect([...files.keys()]).toEqual(['Take-1.json']);
    expect(replay.errorMessage()).toBe('');
  });

  it('hands the operator a file when no host serves the page', async () => {
    const { replay, saved } = setup({ available: false });
    replay.startRecording(JSON.stringify(configuration));
    replay.recordFrame('cam-1', frame('cam-1', 1_000_000_000));
    await replay.save('');
    expect(saved[0]?.name).toBe('recording.json');
    expect(JSON.parse(saved[0]?.text ?? '{}').events).toHaveLength(1);
  });

  it('says why it could not save or load', async () => {
    const { replay } = setup();
    await replay.save('take-1');
    expect(replay.errorMessage()).toContain('保存できる録画がありません');
    await replay.load('missing');
    expect(replay.errorMessage()).toContain('missing.json');
  });

  it('lists what the host keeps, and nothing when it keeps none', async () => {
    const { replay } = setup({
      files: { 'take-1.json': '{}', 'take-2.json': '{}' },
    });
    expect((await replay.listRecordings()).map((entry) => entry.name)).toEqual([
      'take-1.json',
      'take-2.json',
    ]);
    const { replay: without } = setup({ available: false });
    expect(await without.listRecordings()).toEqual([]);
  });

  it('opens a file the operator chose when no name is given', async () => {
    const session = JSON.stringify({
      schema: 'twrmc/pose-3d-session',
      version: 1,
      producer: 'x',
      configuration,
      events: [
        {
          type: 'frame2d',
          atUs: 1,
          cameraId: 'cam-1',
          frame: JSON.parse(frame('cam-1', 1_000_000_000)),
        },
      ],
    });
    const { replay, host } = setup({ chosen: session });
    await replay.load('');
    expect(host.chooseFile).toHaveBeenCalled();
    expect(replay.loadedCamerasJson()).toBe('["cam-1"]');
    expect(replay.loadedConfigurationJson()).toBe(
      JSON.stringify(configuration),
    );
  });

  it('refuses a document it could not replay', () => {
    const { replay } = setup();
    replay.open('not json', 'x.json');
    expect(replay.errorMessage()).toContain('録画として読めません');
    replay.open(
      JSON.stringify({
        schema: 'twrmc/pose-3d-session',
        version: 1,
        configuration,
        events: [],
      }),
      'x.json',
    );
    expect(replay.errorMessage()).toContain('フレームがありません');
    replay.open(
      JSON.stringify({
        schema: 'twrmc/pose-3d-session',
        version: 1,
        events: [],
      }),
      'x.json',
    );
    expect(replay.errorMessage()).toContain('設定');
  });
});

describe('replaying', () => {
  const recorded = JSON.stringify({
    schema: 'twrmc/pose-3d-session',
    version: 1,
    producer: 'test',
    configuration,
    events: [
      {
        type: 'frame2d',
        atUs: 1,
        cameraId: 'cam-1',
        frame: JSON.parse(frame('cam-1', 5_000_000_000, 0)),
      },
      {
        type: 'frame2d',
        atUs: 2,
        cameraId: 'cam-2',
        frame: JSON.parse(frame('cam-2', 5_000_010_000, 0)),
      },
      {
        type: 'frame2d',
        atUs: 3,
        cameraId: 'cam-1',
        frame: JSON.parse(frame('cam-1', 5_000_100_000, 1)),
      },
    ],
  });

  it('hands out each frame when its moment comes, stamped onto the page clock', () => {
    const { replay, clock } = setup();
    replay.open(recorded, 'take-1.json');
    expect(replay.replayDurationMs()).toBe(100);
    replay.startReplay();
    const startedAt = clock.us;

    const first = JSON.parse(replay.frameFor('cam-1'));
    expect(first.sequence).toBe(0);
    // Re-stamped onto now, keeping the spacing: the first frame is the start of the recording.
    expect(first.captureTimestampUs).toBe(startedAt);
    expect(replay.frameFor('cam-1')).toBe('');
    expect(replay.frameFor('cam-2')).toBe('');

    clock.us += 10_000;
    expect(JSON.parse(replay.frameFor('cam-2')).captureTimestampUs).toBe(
      startedAt + 10_000,
    );

    clock.us += 90_000;
    const second = JSON.parse(replay.frameFor('cam-1'));
    expect(second.sequence).toBe(1);
    expect(second.captureTimestampUs).toBe(startedAt + 100_000);
    expect(replay.replayPositionMs()).toBe(100);
  });

  it('ends when the recording runs out, and says so without being asked for a frame', () => {
    const { replay, clock } = setup();
    replay.open(recorded, 'take-1.json');
    replay.startReplay();
    expect(replay.replayStateName()).toBe('playing');
    clock.us += 200_000;
    expect(replay.replayStateName()).toBe('ended');
    expect(replay.frameFor('cam-1')).toBe('');
  });

  it('plays nothing until a recording is loaded, and can be stopped part way', () => {
    const { replay, clock } = setup();
    replay.startReplay();
    expect(replay.replayStateName()).toBe('idle');
    expect(replay.errorMessage()).toContain('読み込まれていません');

    replay.open(recorded, 'take-1.json');
    replay.startReplay();
    clock.us += 20_000;
    replay.stopReplay();
    expect(replay.replayStateName()).toBe('ended');
    expect(replay.frameFor('cam-1')).toBe('');
    expect(replay.loadedSummary()).toContain('take-1.json');
  });
});

describe('recording names', () => {
  it('turns whatever the operator typed into a name the host accepts', () => {
    expect(recordingFileName('Take 1')).toBe('Take-1.json');
    expect(recordingFileName('take-1.json')).toBe('take-1.json');
    expect(recordingFileName('  ')).toBe('recording.json');
    expect(recordingFileName('../escape')).toBe('escape.json');
    expect(recordingFileName('a'.repeat(80)).length).toBeLessThanOrEqual(64);
  });
});

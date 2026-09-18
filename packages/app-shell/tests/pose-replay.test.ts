import { describe, expect, it, vi } from 'vitest';

import {
  PoseReplay,
  readLines,
  recordingFileName,
  recordingFileSource,
  textSource,
  workingFileName,
  type RecordingSource,
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
    /** Makes the host refuse every write after this many, as a full disk or a long take would. */
    failAfterWrites?: number;
  } = {},
) {
  const clock = { us: 1_000_000_000 };
  const files = new Map(Object.entries(options.files ?? {}));
  const saved: Array<{ name: string; text: string }> = [];
  let writes = 0;
  const refuseWhenAsked = () => {
    writes += 1;
    if (
      options.failAfterWrites !== undefined &&
      writes > options.failAfterWrites
    )
      throw new Error('録画 taking.jsonl が大きくなりすぎました。');
  };
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
      source: (name) => ({
        async open() {
          const text = files.get(name);
          if (text === undefined)
            throw new Error(`録画 ${name} を読めません（404）。`);
          return await textSource(text).open();
        },
      }),
      write: async (name, text) => {
        files.set(name, text);
      },
      start: async (name, line) => {
        refuseWhenAsked();
        files.set(name, line);
      },
      append: async (name, lines) => {
        refuseWhenAsked();
        files.set(name, `${files.get(name) ?? ''}${lines}`);
      },
      finish: async (name, to) => {
        refuseWhenAsked();
        files.set(to, files.get(name) ?? '');
        files.delete(name);
      },
    },
    chooseFile: vi.fn(async () =>
      options.chosen === undefined || options.chosen === null
        ? null
        : textSource(options.chosen),
    ),
    saveFile: (name, text) => saved.push({ name, text }),
  };
  const taking = () =>
    [...files.keys()].find((name) => name.startsWith('taking-')) ?? '';
  return { replay: new PoseReplay(host), clock, files, saved, host, taking };
}

/** Lets the writes in flight reach the host, as a turn of the event loop would. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The lines of a recording, as objects. */
function linesOf(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function framesOf(text: string): Array<Record<string, unknown>> {
  return linesOf(text).filter((line) => line['type'] === 'frame2d');
}

describe('recording', () => {
  it('records frames under the configuration they were estimated with', async () => {
    const { replay } = setup({ available: false });
    replay.startRecording(JSON.stringify(configuration));
    replay.recordFrame('cam-1', frame('cam-1', 1_000_000_000, 0));
    replay.recordFrame('cam-2', frame('cam-2', 1_000_010_000, 0));
    // The same frame again, because the camera had nothing new, is not recorded twice.
    replay.recordFrame('cam-2', frame('cam-2', 1_000_010_000, 0));
    replay.recordFrame('cam-1', frame('cam-1', 1_000_033_000, 1));
    replay.stopRecording();

    const lines = linesOf(replay.recordingText());
    expect(lines[0]).toMatchObject({
      type: 'header',
      schema: 'twrmc/pose-3d-session',
      version: 2,
      configuration,
    });
    expect(lines.slice(1)).toHaveLength(3);
    expect(lines[1]).toMatchObject({ type: 'frame2d', cameraId: 'cam-1' });
    expect(replay.recordingStateName()).toBe('recorded');
    expect(replay.recordingSummary()).toContain('2台');
  });

  it('refuses to start without a configuration, because such a recording cannot be replayed', async () => {
    const { replay } = setup({ available: false });
    replay.startRecording('');
    expect(replay.recordingStateName()).toBe('idle');
    expect(replay.errorMessage()).toContain('設定');
    replay.recordFrame('cam-1', frame('cam-1', 1));
    expect(replay.recordingText()).toBe('');
  });

  it('ignores anything that is not a frame with a capture time', async () => {
    const { replay } = setup({ available: false });
    replay.startRecording(JSON.stringify(configuration));
    replay.recordFrame('cam-1', '');
    replay.recordFrame('cam-1', 'not json');
    replay.recordFrame(
      'cam-1',
      JSON.stringify({ schema: 'twrmc/pose-frame-2d' }),
    );
    expect(replay.recordingText()).toBe('');
    expect(replay.recordingSummary()).toContain('録画中: 0台');
  });
});

describe('a recording written while it is taken', () => {
  it('opens the file with its header and adds the frames as they come', async () => {
    const { replay, files, taking } = setup();
    replay.startRecording(JSON.stringify(configuration));
    await settle();
    expect(taking()).toMatch(/^taking-.*\.jsonl\.gz$/u);
    expect(linesOf(files.get(taking()) ?? '')[0]).toMatchObject({
      type: 'header',
      version: 2,
    });

    // Lines go in batches; by forty frames the first batch has reached the host.
    for (let index = 0; index < 40; index += 1) {
      replay.recordFrame(
        'cam-1',
        frame('cam-1', 1_000_000_000 + index * 33_333, index),
      );
    }
    await settle();
    expect(framesOf(files.get(taking()) ?? '').length).toBeGreaterThanOrEqual(
      32,
    );

    replay.recordSpaceTime('cam-1', JSON.stringify({ status: 'measured' }));
    replay.stopRecording();
    await settle();
    const taken = files.get(taking()) ?? '';
    expect(framesOf(taken)).toHaveLength(40);
    expect(linesOf(taken).some((line) => line['type'] === 'spaceTime')).toBe(
      true,
    );
  });

  it('is kept under the operator’s name, compressed, when it is saved', async () => {
    const { replay, files } = setup();
    replay.startRecording(JSON.stringify(configuration));
    replay.recordFrame('cam-1', frame('cam-1', 1_000_000_000));
    replay.stopRecording();
    await replay.save('Take 1');
    expect([...files.keys()]).toEqual(['Take-1.jsonl.gz']);
    expect(replay.errorMessage()).toBe('');
  });

  it('is readable as far as it got when the take is interrupted', async () => {
    const { replay, files, taking } = setup();
    replay.startRecording(JSON.stringify(configuration));
    for (let index = 0; index < 40; index += 1) {
      replay.recordFrame(
        'cam-1',
        frame('cam-1', 1_000_000_000 + index * 33_333, index),
      );
    }
    await settle();
    // Nothing is saved: the page is closed. What reached the host is still a recording.
    const partial = `${files.get(taking()) ?? ''}{"type":"frame2d","atUs":`;
    const { replay: other } = setup();
    await other.open(partial, 'taking.jsonl');
    expect(other.errorMessage()).toBe('');
    expect(other.loadedCamerasJson()).toBe('["cam-1"]');
  });

  it('stops the take and says so when the host will not take any more', async () => {
    const { replay } = setup({ failAfterWrites: 1 });
    replay.startRecording(JSON.stringify(configuration));
    for (let index = 0; index < 40; index += 1) {
      replay.recordFrame(
        'cam-1',
        frame('cam-1', 1_000_000_000 + index * 33_333, index),
      );
    }
    await settle();
    expect(replay.errorMessage()).toContain('大きくなりすぎました');
    expect(replay.recordingStateName()).toBe('recorded');
  });
});

describe('recording limits', () => {
  it('keeps at most the asked frames a second, per camera', async () => {
    const { replay } = setup({ available: false });
    replay.startRecording(JSON.stringify(configuration), { fps: 10 });
    // 30 fps arriving, 10 fps asked for: one in three is kept, per camera.
    for (let index = 0; index < 30; index += 1) {
      const capture = 1_000_000_000 + index * 33_333;
      replay.recordFrame('cam-1', frame('cam-1', capture, index));
      replay.recordFrame('cam-2', frame('cam-2', capture, index));
    }
    const events = framesOf(replay.recordingText());
    const perCamera = (cameraId: string) =>
      events.filter((event) => event['cameraId'] === cameraId).length;
    expect(perCamera('cam-1')).toBe(10);
    expect(perCamera('cam-2')).toBe(10);
    expect(replay.recordingSummary()).toContain('10fpsまで');
    expect(replay.recordingSummary()).toContain('間引き');
  });

  it('stops itself once the asked length has been recorded', async () => {
    const { replay } = setup({ available: false });
    replay.startRecording(JSON.stringify(configuration), { maxSeconds: 2 });
    for (let index = 0; index < 120; index += 1) {
      replay.recordFrame(
        'cam-1',
        frame('cam-1', 1_000_000_000 + index * 33_333, index),
      );
    }
    expect(replay.recordingStateName()).toBe('recorded');
    const events = framesOf(replay.recordingText());
    expect(events).toHaveLength(61);
    const captures = events.map(
      (event) =>
        (event['frame'] as { captureTimestampUs: number }).captureTimestampUs,
    );
    expect(captures[captures.length - 1]! - captures[0]!).toBeLessThan(
      2_000_000,
    );
    expect(replay.recordingSummary()).toContain('2秒まで');
  });

  it('records everything when no limit is asked for', async () => {
    const { replay } = setup({ available: false });
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
    expect(framesOf(replay.recordingText())).toHaveLength(20);
    expect(replay.recordingSummary()).not.toContain('指定');
  });

  it('judges the limits on the frames, not on the page clock', async () => {
    const { replay, clock } = setup({ available: false });
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
    expect(framesOf(replay.recordingText())).toHaveLength(5);
  });
});

describe('keeping and loading recordings', () => {
  it('hands the operator a file, uncompressed, when no host serves the page', async () => {
    const { replay, saved } = setup({ available: false });
    replay.startRecording(JSON.stringify(configuration));
    replay.recordFrame('cam-1', frame('cam-1', 1_000_000_000));
    await replay.save('');
    expect(saved[0]?.name).toBe('recording.jsonl');
    expect(framesOf(saved[0]?.text ?? '')).toHaveLength(1);
  });

  it('says why it could not save or load', async () => {
    const { replay } = setup();
    await replay.save('take-1');
    expect(replay.errorMessage()).toContain('保存できる録画がありません');
    await replay.load('missing');
    expect(replay.errorMessage()).toContain('missing.jsonl.gz');
  });

  it('lists what the host keeps, and nothing when it keeps none', async () => {
    const { replay } = setup({
      files: { 'take-1.jsonl.gz': '{}', 'take-2.json': '{}' },
    });
    expect((await replay.listRecordings()).map((entry) => entry.name)).toEqual([
      'take-1.jsonl.gz',
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

  it('reads a recording taken as lines, with its measurements', async () => {
    const { replay } = setup();
    const text = [
      JSON.stringify({
        type: 'header',
        schema: 'twrmc/pose-3d-session',
        version: 2,
        producer: 'debug-pose-replay',
        configuration,
      }),
      JSON.stringify({
        type: 'spaceTime',
        cameraId: 'cam-1',
        payload: { status: 'measured' },
      }),
      JSON.stringify({
        type: 'frame2d',
        atUs: 1,
        cameraId: 'cam-1',
        frame: JSON.parse(frame('cam-1', 1_000_000_000)),
      }),
      JSON.stringify({
        type: 'frame2d',
        atUs: 2,
        cameraId: 'cam-2',
        frame: JSON.parse(frame('cam-2', 1_000_050_000)),
      }),
    ].join('\n');
    await replay.open(text, 'take-1.jsonl.gz');
    expect(replay.errorMessage()).toBe('');
    expect(replay.loadedCamerasJson()).toBe('["cam-1","cam-2"]');
    expect(replay.replayDurationMs()).toBe(50);
    expect(JSON.parse(replay.spaceTimePayloadJson('cam-1'))).toEqual({
      status: 'measured',
    });
  });

  it('unpacks a compressed recording the operator opened from disk', async () => {
    const text = [
      JSON.stringify({
        type: 'header',
        schema: 'twrmc/pose-3d-session',
        version: 2,
        producer: 'debug-pose-replay',
        configuration,
      }),
      JSON.stringify({
        type: 'frame2d',
        atUs: 1,
        cameraId: 'cam-1',
        frame: JSON.parse(frame('cam-1', 1_000_000_000)),
      }),
    ].join('\n');
    const gzip = new Blob([text])
      .stream()
      .pipeThrough(new CompressionStream('gzip'));
    const compressed = new File(
      [await new Response(gzip).blob()],
      'take-1.jsonl.gz',
    );
    const linesOf = async (source: RecordingSource) => {
      const lines: string[] = [];
      await readLines(source, (line) => lines.push(line));
      return lines.join('\n');
    };
    expect(await linesOf(await recordingFileSource(compressed))).toBe(text);
    // A recording that was never compressed opens the same way.
    expect(
      await linesOf(
        await recordingFileSource(new File([text], 'take-1.jsonl')),
      ),
    ).toBe(text);
  });

  it('refuses a document it could not replay', async () => {
    const { replay } = setup();
    await replay.open('not json', 'x.json');
    expect(replay.errorMessage()).toContain('録画として読めません');
    await replay.open(
      JSON.stringify({
        schema: 'twrmc/pose-3d-session',
        version: 1,
        configuration,
        events: [],
      }),
      'x.json',
    );
    expect(replay.errorMessage()).toContain('フレームがありません');
    await replay.open(
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

  it('hands out each frame when its moment comes, stamped onto the page clock', async () => {
    const { replay, clock } = setup();
    await replay.open(recorded, 'take-1.json');
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

  it('ends when the recording runs out, and says so without being asked for a frame', async () => {
    const { replay, clock } = setup();
    await replay.open(recorded, 'take-1.json');
    replay.startReplay();
    expect(replay.replayStateName()).toBe('playing');
    clock.us += 200_000;
    expect(replay.replayStateName()).toBe('ended');
    expect(replay.frameFor('cam-1')).toBe('');
  });

  it('plays nothing until a recording is loaded, and can be stopped part way', async () => {
    const { replay, clock } = setup();
    replay.startReplay();
    expect(replay.replayStateName()).toBe('idle');
    expect(replay.errorMessage()).toContain('読み込まれていません');

    await replay.open(recorded, 'take-1.json');
    replay.startReplay();
    clock.us += 20_000;
    replay.stopReplay();
    expect(replay.replayStateName()).toBe('ended');
    expect(replay.frameFor('cam-1')).toBe('');
    expect(replay.loadedSummary()).toContain('take-1.json');
  });
});

describe('replaying a long recording a window at a time', () => {
  /** Two cameras at ten frames a second for a minute, as lines: 1,200 frames. */
  function longRecording(seconds = 60): string {
    const lines = [
      JSON.stringify({
        type: 'header',
        schema: 'twrmc/pose-3d-session',
        version: 2,
        producer: 'test',
        configuration,
      }),
      JSON.stringify({
        type: 'spaceTime',
        cameraId: 'cam-1',
        payload: { status: 'measured' },
      }),
    ];
    for (let step = 0; step < seconds * 10; step += 1) {
      for (const cameraId of ['cam-1', 'cam-2']) {
        lines.push(
          JSON.stringify({
            type: 'frame2d',
            atUs: step,
            cameraId,
            frame: JSON.parse(
              frame(cameraId, 5_000_000_000 + step * 100_000, step),
            ),
          }),
        );
      }
    }
    return `${lines.join('\n')}\n`;
  }

  /** A source that hands the text out in small pieces, so lines are split across them. */
  function chunked(text: string): RecordingSource {
    return textSource(text, 997);
  }

  it('learns the recording by reading it once, without keeping its frames', async () => {
    const { replay } = setup();
    await replay.open(longRecording(), 'long.jsonl.gz');
    expect(replay.errorMessage()).toBe('');
    expect(replay.loadedSummary()).toBe(
      'long.jsonl.gz: cam-1, cam-2（1200フレーム / 59.9秒）',
    );
    expect(JSON.parse(replay.spaceTimePayloadJson('cam-1'))).toEqual({
      status: 'measured',
    });
    expect(replay.bufferedFrameCount()).toBe(0);
  });

  it('holds only a few seconds ahead of the replay, however long the recording is', async () => {
    const { replay, clock, host } = setup();
    host.chooseFile = vi.fn(async () => chunked(longRecording()));
    await replay.load('');
    replay.startReplay();
    await settle();

    // Three seconds ahead at twenty frames a second, and a piece of a chunk more: far from 1,200.
    const window = replay.bufferedFrameCount();
    expect(window).toBeGreaterThan(40);
    expect(window).toBeLessThan(100);

    const sequences: number[] = [];
    for (let second = 0; second < 59; second += 1) {
      for (let tenth = 0; tenth < 10; tenth += 1) {
        clock.us += 100_000;
        const next = replay.frameFor('cam-1');
        if (next !== '') sequences.push(JSON.parse(next).sequence);
        replay.frameFor('cam-2');
        await settle();
        expect(replay.bufferedFrameCount()).toBeLessThan(100);
      }
    }
    // Every frame of the camera came out once, in order, at its moment.
    expect(sequences.length).toBeGreaterThan(580);
    expect(sequences).toEqual(
      [...sequences].sort((left, right) => left - right),
    );
    expect(new Set(sequences).size).toBe(sequences.length);

    clock.us += 2_000_000;
    expect(replay.replayStateName()).toBe('ended');
    expect(replay.bufferedFrameCount()).toBe(0);
  });

  it('starts again from the beginning when it is started again', async () => {
    const { replay, clock } = setup();
    await replay.open(longRecording(5), 'short.jsonl.gz');
    replay.startReplay();
    await settle();
    clock.us += 2_000_000;
    expect(JSON.parse(replay.frameFor('cam-1')).sequence).toBe(20);

    replay.startReplay();
    await settle();
    expect(JSON.parse(replay.frameFor('cam-1')).sequence).toBe(0);
  });

  it('plays a recording whose stream broke off, as far as it got', async () => {
    const text = longRecording(10);
    const cut = text.slice(0, Math.floor(text.length / 2));
    const broken: RecordingSource = {
      async open() {
        let sent = false;
        return new ReadableStream<string>({
          pull(controller) {
            if (sent) {
              controller.error(new Error('the connection dropped'));
              return;
            }
            sent = true;
            controller.enqueue(cut);
          },
        });
      },
    };
    const { replay, clock, host } = setup();
    host.chooseFile = vi.fn(async () => broken);
    await replay.load('');
    expect(replay.errorMessage()).toBe('');
    const duration = replay.replayDurationMs();
    expect(duration).toBeGreaterThan(3_000);
    expect(duration).toBeLessThan(6_000);

    replay.startReplay();
    await settle();
    clock.us += 1_000_000;
    expect(replay.frameFor('cam-1')).not.toBe('');
  });
});

describe('recording names', () => {
  it('turns whatever the operator typed into a name the host accepts', async () => {
    expect(recordingFileName('Take 1')).toBe('Take-1.jsonl.gz');
    expect(recordingFileName('  ')).toBe('recording.jsonl.gz');
    expect(recordingFileName('../escape')).toBe('escape.jsonl.gz');
    expect(recordingFileName('a'.repeat(80)).length).toBeLessThanOrEqual(64);
  });

  it('keeps a name that already names a recording, so the host’s own list reads back', async () => {
    expect(recordingFileName('take-1.jsonl.gz')).toBe('take-1.jsonl.gz');
    expect(recordingFileName('take-1.jsonl')).toBe('take-1.jsonl');
    expect(recordingFileName('take-1.json')).toBe('take-1.json');
  });

  it('names a take being written after the time it started', async () => {
    expect(workingFileName(1_789_000_000_000_000)).toMatch(
      /^taking-\d{4}-\d{2}-\d{2}T[\d-]+\.jsonl\.gz$/u,
    );
  });
});

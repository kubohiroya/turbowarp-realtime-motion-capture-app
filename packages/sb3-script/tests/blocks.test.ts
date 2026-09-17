import { describe, expect, it } from 'vitest';

import {
  block,
  broadcast,
  buildBlocks,
  field,
  list,
  namedReference,
  number,
  reporter,
  script,
  text,
  variable,
  type NamedReference,
} from '../src/blocks.ts';
import {
  addToList,
  broadcastMessage,
  broadcastMessageAndWait,
  equals,
  forever,
  greaterThan,
  ifElse,
  ifThen,
  not,
  repeat,
  repeatUntil,
  setVariable,
  wait,
  whenBroadcastReceived,
  whenFlagClicked,
} from '../src/standard.ts';

describe('buildBlocks', () => {
  it('links a stack through next and parent', () => {
    const blocks = buildBlocks([
      script({ x: 40, y: 40 }, [
        block('event_whenflagclicked'),
        block('shell_showAppLoading'),
        block('shell_hideAppLoading'),
      ]),
    ]);

    expect(Object.keys(blocks)).toEqual(['s1b1', 's1b2', 's1b3']);
    expect(blocks['s1b1']).toMatchObject({
      parent: null,
      next: 's1b2',
      topLevel: true,
      x: 40,
      y: 40,
    });
    expect(blocks['s1b2']).toMatchObject({
      parent: 's1b1',
      next: 's1b3',
      topLevel: false,
    });
    expect(blocks['s1b3']).toMatchObject({ parent: 's1b2', next: null });
  });

  it('places only the first block of a script', () => {
    const blocks = buildBlocks([
      script({ x: 10, y: 20 }, [
        block('event_whenflagclicked'),
        block('shell_hideAppLoading'),
      ]),
    ]);

    expect(blocks['s1b1']).toHaveProperty('x', 10);
    expect(blocks['s1b2']).not.toHaveProperty('x');
  });

  it('numbers each script separately so an edit does not renumber the rest', () => {
    const blocks = buildBlocks([
      script({ x: 0, y: 0 }, [block('event_whenflagclicked')]),
      script({ x: 0, y: 200 }, [
        block('event_whenflagclicked'),
        block('shell_hideAppLoading'),
      ]),
    ]);

    expect(Object.keys(blocks)).toEqual(['s1b1', 's2b1', 's2b2']);
  });

  it('produces the same result every time, so the archive stays deterministic', () => {
    const build = () =>
      buildBlocks([
        script({ x: 0, y: 0 }, [
          block('event_whenflagclicked'),
          block('shell_showAppLoading', { LABEL: text('Starting') }),
        ]),
      ]);

    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });
});

describe('inputs', () => {
  it('writes a text literal as a shadow', () => {
    const blocks = buildBlocks([
      script({ x: 0, y: 0 }, [
        block('shell_showAppMessage', { MESSAGE: text('camera missing') }),
      ]),
    ]);

    expect(blocks['s1b1']?.inputs['MESSAGE']).toEqual([
      1,
      [10, 'camera missing'],
    ]);
  });

  it('writes a number literal as a number shadow', () => {
    const blocks = buildBlocks([
      script({ x: 0, y: 0 }, [
        block('shell_showAppLoadingProgress', { PERCENT: number(40) }),
      ]),
    ]);

    expect(blocks['s1b1']?.inputs['PERCENT']).toEqual([1, [4, '40']]);
  });

  it('places a reporter in a slot and keeps an empty shadow under it', () => {
    const blocks = buildBlocks([
      script({ x: 0, y: 0 }, [
        block('shell_showAppMessage', {
          MESSAGE: reporter(block('shell_lastDslError')),
        }),
      ]),
    ]);

    const input = blocks['s1b1']?.inputs['MESSAGE'] as unknown[];
    expect(input[0]).toBe(3);
    expect(input[2]).toEqual([10, '']);

    const child = blocks[input[1] as string];
    expect(child).toMatchObject({
      opcode: 'shell_lastDslError',
      parent: 's1b1',
      topLevel: false,
    });
  });

  it('nests a reporter inside a reporter', () => {
    const blocks = buildBlocks([
      script({ x: 0, y: 0 }, [
        block('shell_showAppMessage', {
          MESSAGE: reporter(
            block('operator_join', { A: reporter(block('shell_appLocale')) }),
          ),
        }),
      ]),
    ]);

    const opcodes = Object.values(blocks).map((entry) => entry.opcode);
    expect(opcodes).toContain('operator_join');
    expect(opcodes).toContain('shell_appLocale');
  });
});

describe('fields', () => {
  it('writes a dropdown choice as a field', () => {
    const blocks = buildBlocks([
      script({ x: 0, y: 0 }, [
        block('shell_appFeatureEnabled', {}, { FEATURE: 'protocolV1Codec' }),
      ]),
    ]);

    expect(blocks['s1b1']?.fields['FEATURE']).toEqual([
      'protocolV1Codec',
      null,
    ]);
  });

  it('keeps the stable id of a named Scratch entity', () => {
    const selection = {
      name: 'selected camera',
      id: 'variable:selected-camera',
    };
    const blocks = buildBlocks([
      script({ x: 0, y: 0 }, [
        block(
          'data_setvariableto',
          { VALUE: text('front') },
          { VARIABLE: field(selection) },
        ),
      ]),
    ]);

    expect(blocks['s1b1']?.fields['VARIABLE']).toEqual([
      'selected camera',
      'variable:selected-camera',
    ]);
  });
});

describe('script', () => {
  it('refuses an empty script', () => {
    expect(() => script({ x: 0, y: 0 }, [])).toThrow(/at least one block/);
  });
});

describe('control flow', () => {
  it('links nested substacks to their owning C blocks', () => {
    const blocks = buildBlocks([
      script({ x: 0, y: 0 }, [
        whenFlagClicked(),
        forever([
          ifElse(
            block('camera_isCameraRunning'),
            [
              block('shell_hideAppLoading'),
              repeat(2, [block('looks_nextcostume')]),
            ],
            [block('shell_showAppError')],
          ),
        ]),
      ]),
    ]);

    const foreverBlock = blocks['s1b2'] as {
      inputs: Record<string, unknown[]>;
    };
    const ifId = (foreverBlock.inputs['SUBSTACK'] as [number, string])[1];
    const ifBlock = blocks[ifId] as { inputs: Record<string, unknown[]> };
    const successId = (ifBlock.inputs['SUBSTACK'] as [number, string])[1];
    const failureId = (ifBlock.inputs['SUBSTACK2'] as [number, string])[1];

    expect(blocks[ifId]).toMatchObject({
      opcode: 'control_if_else',
      parent: 's1b2',
    });
    expect(blocks[successId]).toMatchObject({
      opcode: 'shell_hideAppLoading',
      parent: ifId,
    });
    expect(blocks[failureId]).toMatchObject({
      opcode: 'shell_showAppError',
      parent: ifId,
    });
    expect(blocks[blocks[successId]?.next as string]).toMatchObject({
      opcode: 'control_repeat',
    });
  });

  it('builds a representative camera lifecycle flow', () => {
    const blocks = buildBlocks([
      script({ x: 0, y: 0 }, [
        whenFlagClicked(),
        ifElse(
          block('camera_isCameraRunning'),
          [block('camera_showCameraPreview')],
          [
            block('camera_startSharedCamera'),
            ifThen(block('camera_isCameraRunning'), [
              block('camera_showCameraPreview'),
            ]),
          ],
        ),
        block('camera_stopSharedCamera'),
      ]),
    ]);

    expect(Object.values(blocks).map(({ opcode }) => opcode)).toEqual(
      expect.arrayContaining([
        'control_if_else',
        'camera_startSharedCamera',
        'camera_showCameraPreview',
        'camera_stopSharedCamera',
      ]),
    );
  });

  it('encodes boolean conditions as block-only inputs without shadows', () => {
    const blocks = buildBlocks([
      script({ x: 0, y: 0 }, [
        ifThen(block('camera_isCameraRunning'), [
          block('shell_hideAppLoading'),
        ]),
      ]),
    ]);

    expect(blocks['s1b1']?.inputs['CONDITION']?.[0]).toBe(2);
    expect(blocks['s1b1']?.inputs['CONDITION']).toHaveLength(2);
  });

  it('accepts reporter inputs in comparison conditions', () => {
    const blocks = buildBlocks([
      script({ x: 0, y: 0 }, [
        ifThen(
          greaterThan(
            variable(namedReference('count', 'variable:count')),
            number(0),
          ),
          [block('shell_hideAppLoading')],
        ),
      ]),
    ]);

    const comparisonId = blocks['s1b1']?.inputs['CONDITION']?.[1] as string;
    expect(blocks[comparisonId]?.opcode).toBe('operator_gt');
    expect(blocks[comparisonId]?.inputs['OPERAND1']?.[1]).toEqual([
      12,
      'count',
      'variable:count',
    ]);
  });

  it('refuses empty control-flow bodies', () => {
    expect(() => ifThen(block('camera_isCameraRunning'), [])).toThrow(
      /at least one block/,
    );
    expect(() => repeat(2, [])).toThrow(/at least one block/);
  });

  it('does not renumber another script when one script changes', () => {
    const secondScript = script({ x: 0, y: 200 }, [
      whenFlagClicked(),
      block('shell_showAppNotice'),
    ]);
    const before = buildBlocks([
      script({ x: 0, y: 0 }, [whenFlagClicked()]),
      secondScript,
    ]);
    const after = buildBlocks([
      script({ x: 0, y: 0 }, [whenFlagClicked(), wait(1)]),
      secondScript,
    ]);

    expect(before['s2b1']).toEqual(after['s2b1']);
    expect(before['s2b2']).toEqual(after['s2b2']);
  });
});

describe('stable Scratch references', () => {
  const qrText: NamedReference = namedReference('qr text', 'variable:qr-text');
  const qrParts: NamedReference = namedReference('qr parts', 'list:qr-parts');
  const scanQr: NamedReference = namedReference('scan qr', 'broadcast:scan-qr');

  it('encodes variable, list, and broadcast inputs with their ids', () => {
    expect(
      variable(qrText).encode({ block: () => '', stack: () => '' }),
    ).toEqual([3, [12, 'qr text', 'variable:qr-text'], [10, '']]);
    expect(list(qrParts).encode({ block: () => '', stack: () => '' })).toEqual([
      3,
      [13, 'qr parts', 'list:qr-parts'],
      [10, ''],
    ]);
    expect(
      broadcast(scanQr).encode({ block: () => '', stack: () => '' }),
    ).toEqual([1, [11, 'scan qr', 'broadcast:scan-qr']]);
  });

  it('rejects a reference without a stable id', () => {
    expect(() => namedReference('qr text', '')).toThrow(/stable id/);
  });

  it('builds a representative QR pairing accumulation flow', () => {
    const blocks = buildBlocks([
      script({ x: 0, y: 0 }, [
        whenFlagClicked(),
        setVariable(qrText, text('')),
        broadcastMessage(scanQr),
        repeatUntil(not(equals(variable(qrText), text(''))), [wait(0.1)]),
        addToList(variable(qrText), qrParts),
      ]),
      script({ x: 400, y: 0 }, [
        whenBroadcastReceived(scanQr),
        setVariable(qrText, text('decoded payload')),
      ]),
    ]);

    expect(blocks['s2b1']?.fields['BROADCAST_OPTION']).toEqual([
      'scan qr',
      'broadcast:scan-qr',
    ]);
    expect(blocks['s1b2']?.fields['VARIABLE']).toEqual([
      'qr text',
      'variable:qr-text',
    ]);
    expect(blocks['s1b5']?.fields['LIST']).toEqual([
      'qr parts',
      'list:qr-parts',
    ]);
    expect(Object.values(blocks).map(({ opcode }) => opcode)).toEqual(
      expect.arrayContaining([
        'control_repeat_until',
        'operator_not',
        'operator_equals',
        'event_broadcast',
        'control_wait',
        'data_addtolist',
      ]),
    );
  });

  it('waits for broadcast handlers when ordered follow-up work depends on them', () => {
    const blocks = buildBlocks([
      script({ x: 0, y: 0 }, [
        whenFlagClicked(),
        broadcastMessageAndWait(scanQr),
        block('shell_showAppNotice'),
      ]),
    ]);

    expect(blocks['s1b2']?.opcode).toBe('event_broadcastandwait');
    expect(blocks['s1b2']?.inputs['BROADCAST_INPUT']).toEqual([
      1,
      [11, 'scan qr', 'broadcast:scan-qr'],
    ]);
    expect(blocks['s1b2']?.next).toBe('s1b3');
  });
});

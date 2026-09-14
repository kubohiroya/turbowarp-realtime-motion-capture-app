import {describe, expect, it} from 'vitest';

import {block, buildBlocks, number, reporter, script, text} from '../src/blocks.ts';
import {equals, forever, ifElse, ifThen, label, whenFlagClicked} from '../src/standard.ts';

describe('buildBlocks', () => {
  it('links a stack through next and parent', () => {
    const blocks = buildBlocks([
      script({x: 40, y: 40}, [
        block('event_whenflagclicked'),
        block('shell_showAppLoading'),
        block('shell_hideAppLoading')
      ])
    ]);

    expect(Object.keys(blocks)).toEqual(['s1b1', 's1b2', 's1b3']);
    expect(blocks['s1b1']).toMatchObject({parent: null, next: 's1b2', topLevel: true, x: 40, y: 40});
    expect(blocks['s1b2']).toMatchObject({parent: 's1b1', next: 's1b3', topLevel: false});
    expect(blocks['s1b3']).toMatchObject({parent: 's1b2', next: null});
  });

  it('places only the first block of a script', () => {
    const blocks = buildBlocks([
      script({x: 10, y: 20}, [block('event_whenflagclicked'), block('shell_hideAppLoading')])
    ]);

    expect(blocks['s1b1']).toHaveProperty('x', 10);
    expect(blocks['s1b2']).not.toHaveProperty('x');
  });

  it('numbers each script separately so an edit does not renumber the rest', () => {
    const blocks = buildBlocks([
      script({x: 0, y: 0}, [block('event_whenflagclicked')]),
      script({x: 0, y: 200}, [block('event_whenflagclicked'), block('shell_hideAppLoading')])
    ]);

    expect(Object.keys(blocks)).toEqual(['s1b1', 's2b1', 's2b2']);
  });

  it('produces the same result every time, so the archive stays deterministic', () => {
    const build = () =>
      buildBlocks([
        script({x: 0, y: 0}, [
          block('event_whenflagclicked'),
          block('shell_showAppLoading', {LABEL: text('Starting')})
        ])
      ]);

    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });
});

describe('inputs', () => {
  it('writes a text literal as a shadow', () => {
    const blocks = buildBlocks([
      script({x: 0, y: 0}, [block('shell_showAppMessage', {MESSAGE: text('camera missing')})])
    ]);

    expect(blocks['s1b1']?.inputs['MESSAGE']).toEqual([1, [10, 'camera missing']]);
  });

  it('writes a number literal as a number shadow', () => {
    const blocks = buildBlocks([
      script({x: 0, y: 0}, [block('shell_showAppLoadingProgress', {PERCENT: number(40)})])
    ]);

    expect(blocks['s1b1']?.inputs['PERCENT']).toEqual([1, [4, '40']]);
  });

  it('places a reporter in a slot and keeps an empty shadow under it', () => {
    const blocks = buildBlocks([
      script({x: 0, y: 0}, [
        block('shell_showAppMessage', {MESSAGE: reporter(block('shell_lastDslError'))})
      ])
    ]);

    const input = blocks['s1b1']?.inputs['MESSAGE'] as unknown[];
    expect(input[0]).toBe(3);
    expect(input[2]).toEqual([10, '']);

    const child = blocks[input[1] as string];
    expect(child).toMatchObject({opcode: 'shell_lastDslError', parent: 's1b1', topLevel: false});
  });

  it('nests a reporter inside a reporter', () => {
    const blocks = buildBlocks([
      script({x: 0, y: 0}, [
        block('shell_showAppMessage', {
          MESSAGE: reporter(block('operator_join', {A: reporter(block('shell_appLocale'))}))
        })
      ])
    ]);

    const opcodes = Object.values(blocks).map((entry) => entry.opcode);
    expect(opcodes).toContain('operator_join');
    expect(opcodes).toContain('shell_appLocale');
  });
});

describe('fields', () => {
  it('writes a dropdown choice as a field', () => {
    const blocks = buildBlocks([
      script({x: 0, y: 0}, [block('shell_appFeatureEnabled', {}, {FEATURE: 'protocolV1Codec'})])
    ]);

    expect(blocks['s1b1']?.fields['FEATURE']).toEqual(['protocolV1Codec', null]);
  });
});

describe('script', () => {
  it('refuses an empty script', () => {
    expect(() => script({x: 0, y: 0}, [])).toThrow(/at least one block/);
  });
});

describe('control flow', () => {
  it('links a body into the mouth of a C block', () => {
    const blocks = buildBlocks([
      script({x: 0, y: 0}, [
        block('event_whenflagclicked'),
        ifThen(block('camera_isCameraRunning'), [
          block('shell_showAppNotice'),
          block('shell_hideAppLoading')
        ])
      ])
    ]);

    const branch = blocks['s1b2'] as {inputs: Record<string, unknown[]>};
    const [kind, firstId] = branch.inputs['SUBSTACK'] as [number, string];
    expect(kind).toBe(2);

    const first = blocks[firstId];
    expect(first).toMatchObject({opcode: 'shell_showAppNotice', parent: 's1b2', topLevel: false});
    const second = blocks[first?.next as string];
    expect(second).toMatchObject({opcode: 'shell_hideAppLoading', parent: firstId, next: null});
  });

  it('writes a boolean condition without a shadow', () => {
    const blocks = buildBlocks([
      script({x: 0, y: 0}, [ifThen(block('camera_isCameraRunning'), [block('shell_hideAppLoading')])])
    ]);

    const input = (blocks['s1b1'] as {inputs: Record<string, unknown[]>}).inputs['CONDITION'];
    expect(input?.[0]).toBe(2);
    expect(input).toHaveLength(2);
    expect(blocks[input?.[1] as string]?.opcode).toBe('camera_isCameraRunning');
  });

  it('keeps the two branches of an if/else apart', () => {
    const blocks = buildBlocks([
      script({x: 0, y: 0}, [
        ifElse(block('camera_isCameraRunning'), [block('shell_hideAppLoading')], [block('shell_showAppError')])
      ])
    ]);

    const inputs = (blocks['s1b1'] as {inputs: Record<string, unknown[]>}).inputs;
    const body = blocks[(inputs['SUBSTACK'] as [number, string])[1]];
    const otherwise = blocks[(inputs['SUBSTACK2'] as [number, string])[1]];
    expect(body?.opcode).toBe('shell_hideAppLoading');
    expect(otherwise?.opcode).toBe('shell_showAppError');
  });

  it('continues the stack after a C block', () => {
    const blocks = buildBlocks([
      script({x: 0, y: 0}, [
        block('event_whenflagclicked'),
        forever([block('shell_hideAppLoading')]),
        block('shell_showAppNotice')
      ])
    ]);

    expect(blocks['s1b2']?.next).toBe('s1b3');
    expect(blocks['s1b3']).toMatchObject({opcode: 'shell_showAppNotice', parent: 's1b2'});
  });

  it('nests a C block inside a C block', () => {
    const blocks = buildBlocks([
      script({x: 0, y: 0}, [
        forever([ifThen(block('camera_isCameraRunning'), [block('shell_hideAppLoading')])])
      ])
    ]);

    const opcodes = Object.values(blocks).map((entry) => entry.opcode);
    expect(opcodes).toEqual([
      'control_forever',
      'control_if',
      'camera_isCameraRunning',
      'shell_hideAppLoading'
    ]);
  });

  it('refuses an empty body, because an empty mouth is a mistake not a shape', () => {
    expect(() => ifThen(block('camera_isCameraRunning'), [])).toThrow(/at least one block/);
  });

  it('stays deterministic with nesting', () => {
    const build = () =>
      buildBlocks([
        script({x: 0, y: 0}, [
          whenFlagClicked(),
          ifElse(
            equals(reporter(block('camera_cameraDeviceCount')), text('0')),
            [block('shell_showAppError', {MESSAGE: text('no camera')})],
            [block('shell_showAppNotice', {MESSAGE: label('cameras: ', block('camera_cameraDeviceCount'))})]
          )
        ])
      ]);

    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });
});

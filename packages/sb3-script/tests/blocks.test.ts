import {describe, expect, it} from 'vitest';

import {block, buildBlocks, number, reporter, script, text} from '../src/blocks.ts';

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

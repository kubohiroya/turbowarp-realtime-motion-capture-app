import {
  block,
  condition,
  number,
  reporter,
  substack,
  text,
  type BlockNode,
  type InputValue
} from './blocks.ts';

/**
 * The Scratch blocks an application script reaches for.
 *
 * Only the ones actually used are wrapped. A thin layer over every core opcode would be a second
 * catalogue to keep in step with Scratch, while these few make the scripts read as what they do.
 */
export const whenFlagClicked = (): BlockNode => block('event_whenflagclicked');

export const ifThen = (test: BlockNode, body: readonly BlockNode[]): BlockNode =>
  block('control_if', {CONDITION: condition(test), SUBSTACK: substack(body)});

export const ifElse = (
  test: BlockNode,
  body: readonly BlockNode[],
  otherwise: readonly BlockNode[]
): BlockNode =>
  block('control_if_else', {
    CONDITION: condition(test),
    SUBSTACK: substack(body),
    SUBSTACK2: substack(otherwise)
  });

export const forever = (body: readonly BlockNode[]): BlockNode =>
  block('control_forever', {SUBSTACK: substack(body)});

export const repeat = (times: number, body: readonly BlockNode[]): BlockNode =>
  block('control_repeat', {TIMES: number(times), SUBSTACK: substack(body)});

export const repeatUntil = (test: BlockNode, body: readonly BlockNode[]): BlockNode =>
  block('control_repeat_until', {CONDITION: condition(test), SUBSTACK: substack(body)});

export const wait = (seconds: number): BlockNode =>
  block('control_wait', {DURATION: number(seconds)});

export const stop = (option: 'all' | 'this script' | 'other scripts in sprite'): BlockNode =>
  block('control_stop', {}, {STOP_OPTION: option});

export const join = (left: InputValue, right: InputValue): BlockNode =>
  block('operator_join', {STRING1: left, STRING2: right});

export const equals = (left: InputValue, right: InputValue): BlockNode =>
  block('operator_equals', {OPERAND1: left, OPERAND2: right});

export const greaterThan = (left: InputValue, right: InputValue): BlockNode =>
  block('operator_gt', {OPERAND1: left, OPERAND2: right});

export const not = (test: BlockNode): BlockNode =>
  block('operator_not', {OPERAND: condition(test)});

/** `join` over a fixed prefix and a reporter, which is how every notice in these apps is built. */
export const label = (prefix: string, value: BlockNode): InputValue =>
  reporter(join(text(prefix), reporter(value)));

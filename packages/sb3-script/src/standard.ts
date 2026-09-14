import {
  block,
  broadcast,
  condition,
  field,
  number,
  reporter,
  substack,
  text,
  type BlockNode,
  type InputValue,
  type NamedReference
} from './blocks.ts';

const numericInput = (value: number | InputValue): InputValue =>
  typeof value === 'number' ? number(value) : value;

export const whenFlagClicked = (): BlockNode => block('event_whenflagclicked');

export const whenBroadcastReceived = (message: NamedReference): BlockNode =>
  block('event_whenbroadcastreceived', {}, {BROADCAST_OPTION: field(message)});

export const broadcastMessage = (message: NamedReference): BlockNode =>
  block('event_broadcast', {BROADCAST_INPUT: broadcast(message)});

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

export const repeat = (times: number | InputValue, body: readonly BlockNode[]): BlockNode =>
  block('control_repeat', {TIMES: numericInput(times), SUBSTACK: substack(body)});

export const repeatUntil = (test: BlockNode, body: readonly BlockNode[]): BlockNode =>
  block('control_repeat_until', {CONDITION: condition(test), SUBSTACK: substack(body)});

export const wait = (seconds: number | InputValue): BlockNode =>
  block('control_wait', {DURATION: numericInput(seconds)});

export const stop = (option: 'all' | 'this script' | 'other scripts in sprite'): BlockNode =>
  block('control_stop', {}, {STOP_OPTION: option});

export const equals = (left: InputValue, right: InputValue): BlockNode =>
  block('operator_equals', {OPERAND1: left, OPERAND2: right});

export const greaterThan = (left: InputValue, right: InputValue): BlockNode =>
  block('operator_gt', {OPERAND1: left, OPERAND2: right});

export const not = (value: BlockNode): BlockNode =>
  block('operator_not', {OPERAND: condition(value)});

export const join = (left: InputValue, right: InputValue): BlockNode =>
  block('operator_join', {STRING1: left, STRING2: right});

export const setVariable = (
  target: NamedReference,
  value: InputValue
): BlockNode => block('data_setvariableto', {VALUE: value}, {VARIABLE: field(target)});

export const addToList = (value: InputValue, target: NamedReference): BlockNode =>
  block('data_addtolist', {ITEM: value}, {LIST: field(target)});

export const label = (prefix: string, right: BlockNode): InputValue =>
  reporter(join(text(prefix), reporter(right)));

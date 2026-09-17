import {
  block,
  namedReference,
  number,
  reporter,
  script,
  text,
  variable,
  type BlockNode,
  type Script
} from '../../packages/sb3-script/src/blocks.ts';
import {
  equals,
  forever,
  greaterThan,
  ifThen,
  setVariable,
  wait,
  whenFlagClicked
} from '../../packages/sb3-script/src/standard.ts';

/**
 * One reader of the WebRTC receive queue per application.
 *
 * Every consumer of network messages — the pairing test, the space-time calibration — used to be
 * able to wait on the queue itself, and the first one to take a message would take it from the
 * others. A single dispatcher takes each message once, records it by type in a variable, and the
 * flows wait on their own variable instead of the shared queue.
 */

const webrtc = 'kubohiroyawebrtc';

export const networkReferences = () => ({
  message: namedReference('network message', 'variable:network-message'),
  type: namedReference('network message type', 'variable:network-message-type')
});

export type NetworkReferences = ReturnType<typeof networkReferences>;

export const networkVariables = (references: NetworkReferences) => ({
  [references.message.id]: [references.message.name, ''],
  [references.type.id]: [references.type.name, '']
});

export interface MessageRoute {
  readonly type: string;
  readonly handle: readonly BlockNode[];
}

export function messageDispatcher(
  shell: string,
  references: NetworkReferences,
  routes: readonly MessageRoute[],
  position: {x: number; y: number}
): Script {
  return script(position, [
    whenFlagClicked(),
    forever([
      ifThen(greaterThan(reporter(block(`${webrtc}_messageCount`)), number(0)), [
        setVariable(references.message, reporter(block(`${webrtc}_nextMessage`))),
        setVariable(
          references.type,
          reporter(
            block(`${shell}_jsonValueAt`, {JSON: variable(references.message), PATH: text('type')})
          )
        ),
        ...routes.map((route) =>
          ifThen(equals(variable(references.type), text(route.type)), [...route.handle])
        )
      ]),
      wait(0.05)
    ])
  ]);
}

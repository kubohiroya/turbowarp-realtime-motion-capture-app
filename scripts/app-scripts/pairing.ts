import {
  block,
  namedReference,
  number,
  reporter,
  text,
  variable,
  type BlockNode,
  type InputValue,
  type NamedReference,
} from '../../packages/sb3-script/src/blocks.ts';
import {
  add,
  changeVariable,
  equals,
  greaterThan,
  ifElse,
  ifThen,
  join,
  modulo,
  not,
  or,
  repeatUntil,
  setVariable,
  wait,
  waitUntil,
} from '../../packages/sb3-script/src/standard.ts';

/**
 * The QR courier pairing steps both applications share (M-07, issue #7).
 *
 * The fusion app is the hub: it projects the offer and reads the answer a courier carries on a phone.
 * The camera app reads the offer and shows its answer. Transport — parts, hashes, peers, timeouts —
 * belongs to `turbowarp-webrtc-qrcode-pairing`; these scripts only put its parts on screen, turn the
 * operator's button presses into steps, and say what happened.
 *
 * Both projects have no sprite, so a part is shown through the app shell's QR panel from the data
 * URI the pairing extension renders, rather than on a sprite skin.
 */

export const pairingExtension = 'kubohiroyawebrtcqrcodepairing';
const webrtc = 'kubohiroyawebrtc';

/** The contract flag that gates pairing in both apps; the shell forwards it to the pairing extension. */
export const pairingFeatureFlag = 'qrCourierPairing';

export const pairingButtons = {
  next: '次のQR',
  readAnswer: 'Answerを読み取る',
  cancel: 'やめる',
} as const;

/** The message both sides send once connected, so a connection is shown to carry data, not only to exist. */
export const linkTestMessage = 'twrmc-link-test';

export interface PairingReferences {
  readonly session: NamedReference;
  readonly partIndex: NamedReference;
  readonly pressesSeen: NamedReference;
  readonly step: NamedReference;
  readonly waited: NamedReference;
  /** Set by the application's message dispatcher when the other side's test message arrives. */
  readonly linkTest: NamedReference;
}

export const pairingReferences = (): PairingReferences => ({
  session: namedReference('pairing session', 'variable:pairing-session'),
  partIndex: namedReference(
    'pairing QR part index',
    'variable:pairing-qr-part-index',
  ),
  pressesSeen: namedReference(
    'pairing button presses seen',
    'variable:pairing-button-presses-seen',
  ),
  step: namedReference('pairing step', 'variable:pairing-step'),
  waited: namedReference('pairing test wait', 'variable:pairing-test-wait'),
  linkTest: namedReference('link test message', 'variable:link-test-message'),
});

export const pairingVariables = (
  references: PairingReferences,
  session: string,
) => ({
  [references.session.id]: [references.session.name, session],
  [references.partIndex.id]: [references.partIndex.name, 1],
  [references.pressesSeen.id]: [references.pressesSeen.name, 0],
  [references.step.id]: [references.step.name, ''],
  [references.waited.id]: [references.waited.name, 0],
  [references.linkTest.id]: [references.linkTest.name, ''],
});

export const concatenate = (
  first: InputValue,
  ...rest: readonly InputValue[]
): InputValue =>
  rest.reduce((left, right) => reporter(join(left, right)), first);

export class PairingSteps {
  private readonly shell: string;
  private readonly references: PairingReferences;

  public constructor(shell: string, references: PairingReferences) {
    this.shell = shell;
    this.references = references;
  }

  public pairing(
    opcode: string,
    inputs: Readonly<Record<string, InputValue>> = {},
  ): BlockNode {
    return block(`${pairingExtension}_${opcode}`, {
      SESSION: this.session(),
      ...inputs,
    });
  }

  public pairingValue(
    opcode: string,
    inputs: Readonly<Record<string, InputValue>> = {},
  ): InputValue {
    return reporter(this.pairing(opcode, inputs));
  }

  public session(): InputValue {
    return variable(this.references.session);
  }

  public phaseIs(phase: string): BlockNode {
    return equals(this.pairingValue('pairingPhase'), text(phase));
  }

  /** Cancelled, expired or failed: the exchange is over and will not connect. */
  public ended(): BlockNode {
    return or(
      this.phaseIs('cancelled'),
      or(this.phaseIs('expired'), this.phaseIs('failed')),
    );
  }

  public featureEnabled(): BlockNode {
    return block(`${this.shell}_appFeatureEnabled`, {
      FEATURE: text(pairingFeatureFlag),
    });
  }

  public notice(message: InputValue): BlockNode {
    return block(`${this.shell}_showAppNotice`, { MESSAGE: message });
  }

  public error(message: InputValue, code: string): BlockNode {
    return block(`${this.shell}_showAppError`, {
      MESSAGE: message,
      DETAILS: text(JSON.stringify({ code })),
    });
  }

  /** Says why an exchange stopped. A cancel the operator asked for is not reported as a failure. */
  public reportEnded(): BlockNode {
    return ifElse(
      this.phaseIs('cancelled'),
      [this.notice(text('ペアリングをやめました。'))],
      [
        this.error(
          concatenate(
            text('接続できませんでした。'),
            this.pairingValue('pairingErrorMessage'),
            text('（'),
            this.pairingValue('pairingError'),
            text('）'),
          ),
          'PAIRING_FAILED',
        ),
      ],
    );
  }

  private showPart(
    kind: string | InputValue,
    instruction: string,
    buttons: readonly string[],
  ): BlockNode {
    return block(`${this.shell}_showQrImage`, {
      IMAGE: this.pairingValue('pairingQrPartDataUri', {
        INDEX: variable(this.references.partIndex),
      }),
      CAPTION: concatenate(
        typeof kind === 'string' ? text(kind) : kind,
        text(' '),
        variable(this.references.partIndex),
        text(' / '),
        this.pairingValue('pairingQrPartCount'),
        text(` — ${instruction}`),
      ),
      BUTTONS: text(buttons.join('|')),
    });
  }

  /**
   * Shows the parts one at a time and waits for the operator.
   *
   * One part stays up until the operator asks for the next, because the person photographing a
   * projection needs each code to hold still. The wait ends on a connection, on an ended exchange,
   * or on a button this script treats as a step, which it leaves in the step variable.
   */
  public presentParts(
    kind: string | InputValue,
    instruction: string,
    buttons: readonly string[],
    stopOn: BlockNode,
  ): BlockNode[] {
    const { partIndex, pressesSeen, step } = this.references;
    const pressed = (label: string) =>
      equals(reporter(block(`${this.shell}_lastQrImageButton`)), text(label));
    return [
      setVariable(partIndex, number(1)),
      setVariable(step, text('')),
      setVariable(
        pressesSeen,
        reporter(block(`${this.shell}_qrImageButtonPresses`)),
      ),
      this.showPart(kind, instruction, buttons),
      repeatUntil(
        or(stopOn, or(this.ended(), not(equals(variable(step), text(''))))),
        [
          ifThen(
            greaterThan(
              reporter(block(`${this.shell}_qrImageButtonPresses`)),
              variable(pressesSeen),
            ),
            [
              setVariable(
                pressesSeen,
                reporter(block(`${this.shell}_qrImageButtonPresses`)),
              ),
              ifElse(
                pressed(pairingButtons.next),
                [
                  setVariable(
                    partIndex,
                    reporter(
                      add(
                        reporter(
                          modulo(
                            variable(partIndex),
                            this.pairingValue('pairingQrPartCount'),
                          ),
                        ),
                        number(1),
                      ),
                    ),
                  ),
                  this.showPart(kind, instruction, buttons),
                ],
                [
                  ifThen(pressed(pairingButtons.readAnswer), [
                    setVariable(step, text('read-answer')),
                  ]),
                  ifThen(pressed(pairingButtons.cancel), [
                    setVariable(step, text('cancel')),
                  ]),
                ],
              ),
            ],
          ),
          wait(0.1),
        ],
      ),
      block(`${this.shell}_hideQrImage`),
    ];
  }

  /**
   * Proves the connection carries data: sends one message and waits for the other side's.
   *
   * The queue is not cleared first. Both sides send the moment they see the connection, and the
   * other side's message may already be waiting; clearing would throw away the proof.
   */
  public exchangeTestMessage(from: string): BlockNode[] {
    const { waited, linkTest } = this.references;
    const received = not(equals(variable(linkTest), text('')));
    return [
      this.notice(
        concatenate(
          text('接続しました（相手: '),
          this.pairingValue('pairingRemotePeer'),
          text('）。テストメッセージを送受信しています。'),
        ),
      ),
      block(`${webrtc}_broadcastNetworkMessage`, {
        MESSAGE: text(linkTestMessage),
        PAYLOAD: text(JSON.stringify({ from })),
        CHANNEL: text('default'),
        PEER: this.pairingValue('pairingRemotePeer'),
      }),
      setVariable(waited, number(0)),
      repeatUntil(or(received, greaterThan(variable(waited), number(100))), [
        wait(0.1),
        changeVariable(waited, 1),
      ]),
      ifElse(
        received,
        [
          this.notice(
            concatenate(
              text('接続しました（相手: '),
              this.pairingValue('pairingRemotePeer'),
              text('）。テストメッセージを送受信できました: '),
              variable(linkTest),
            ),
          ),
        ],
        [
          this.error(
            text(
              '接続は成立しましたが、10秒以内に相手からテストメッセージが届きませんでした。相手側の画面を確認してください。',
            ),
            'PAIRING_TEST_MESSAGE_MISSING',
          ),
        ],
      ),
    ];
  }

  /**
   * Forgets the previous exchange's test message.
   *
   * Cleared when an exchange starts, not before sending: the other side sends the moment it sees
   * the connection, and its message may arrive before this side gets to send its own.
   */
  public resetLinkTest(): BlockNode {
    return setVariable(this.references.linkTest, text(''));
  }

  /** Waits for the connection after the transport is done, or for the exchange to end. */
  public awaitConnection(): BlockNode {
    return waitUntil(or(this.pairing('isPairingConnected'), this.ended()));
  }

  public cancel(): BlockNode[] {
    return [
      this.pairing('cancelPairing'),
      block(`${this.shell}_hideQrImage`),
      this.notice(text('ペアリングをやめました。')),
    ];
  }
}

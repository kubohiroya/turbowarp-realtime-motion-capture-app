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
  and,
  broadcastMessage,
  changeVariable,
  daysSince2000,
  equals,
  greaterThan,
  ifElse,
  ifThen,
  join,
  lessThan,
  modulo,
  multiply,
  not,
  or,
  repeatUntil,
  setVariable,
  subtract,
  wait,
  waitUntil,
  whenBroadcastReceived,
} from '../../packages/sb3-script/src/standard.ts';

/**
 * The QR courier pairing steps both applications share (M-07, issue #7).
 *
 * The fusion app is the hub: it projects the offer and reads the answer a courier carries on a phone.
 * The camera app reads the offer and shows its answer. Transport — the Structured Append codes,
 * hashes, peers, timeouts — belongs to `turbowarp-webrtc-qrcode-pairing`; these scripts only put its
 * codes on screen, turn the operator's button presses into steps, and say what each read was.
 *
 * The offer's codes cycle by themselves, because the camera app keeps reading and takes them in any
 * order. The answer's codes wait for the operator, because a person photographs each one.
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
  /** When the current code went on screen, in seconds, when the codes cycle by themselves. */
  readonly shownAt: NamedReference;
  /** When the read report last replaced its line, in seconds. */
  readonly reportedAt: NamedReference;
  /** `true` while a camera scan runs, which is how long the read report keeps reporting. */
  readonly scanning: NamedReference;
  /** The extension's read count last reported, so each new read is reported once. */
  readonly readsSeen: NamedReference;
  /** Starts the read report beside a scan, which blocks the script that runs it. */
  readonly readReport: NamedReference;
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
  shownAt: namedReference(
    'pairing QR shown at',
    'variable:pairing-qr-shown-at',
  ),
  reportedAt: namedReference(
    'pairing QR reported at',
    'variable:pairing-qr-reported-at',
  ),
  scanning: namedReference('pairing scanning', 'variable:pairing-scanning'),
  readsSeen: namedReference(
    'pairing QR reads seen',
    'variable:pairing-qr-reads-seen',
  ),
  readReport: namedReference(
    'pairing QR read report',
    'broadcast:pairing-qr-read-report',
  ),
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
  [references.shownAt.id]: [references.shownAt.name, 0],
  [references.reportedAt.id]: [references.reportedAt.name, 0],
  [references.scanning.id]: [references.scanning.name, 'false'],
  [references.readsSeen.id]: [references.readsSeen.name, 0],
});

export const pairingBroadcasts = (references: PairingReferences) => ({
  [references.readReport.id]: references.readReport.name,
});

/** The wall clock in seconds. Waits in a loop run a frame long, so time is read, not counted. */
const secondsNow = (): InputValue =>
  reporter(multiply(reporter(daysSince2000()), number(86_400)));

/** Seconds since a time `secondsNow` gave. */
const secondsSince = (since: NamedReference): InputValue =>
  reporter(subtract(secondsNow(), variable(since)));

/**
 * How long a status line stays before a repeat or a foreign read replaces it. A camera reads the
 * code in front of it several times a second, and a new code's line must stay long enough to read.
 */
const REPORT_HOLD_SECONDS = 1.5;

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
   * Shows the codes one at a time.
   *
   * With `cycleSeconds`, each code stays up that long and the next follows by itself, round and
   * round, for a camera that keeps reading. Without it, a code stays up until the operator asks for
   * the next, because the person photographing a screen needs each code to hold still. The wait
   * ends on a connection, on an ended exchange, or on a button this script treats as a step, which
   * it leaves in the step variable.
   */
  public presentParts(
    kind: string | InputValue,
    instruction: string,
    buttons: readonly string[],
    stopOn: BlockNode,
    cycleSeconds?: number,
  ): BlockNode[] {
    const { partIndex, pressesSeen, step, shownAt } = this.references;
    const pressed = (label: string) =>
      equals(reporter(block(`${this.shell}_lastQrImageButton`)), text(label));
    const advance = [
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
      setVariable(shownAt, secondsNow()),
      this.showPart(kind, instruction, buttons),
    ];
    const cycle =
      cycleSeconds === undefined
        ? []
        : [
            ifThen(
              not(lessThan(secondsSince(shownAt), number(cycleSeconds))),
              advance,
            ),
          ];
    return [
      setVariable(partIndex, number(1)),
      setVariable(shownAt, secondsNow()),
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
              ifElse(pressed(pairingButtons.next), advance, [
                ifThen(pressed(pairingButtons.readAnswer), [
                  setVariable(step, text('read-answer')),
                ]),
                ifThen(pressed(pairingButtons.cancel), [
                  setVariable(step, text('cancel')),
                ]),
              ]),
            ],
          ),
          ...cycle,
          wait(0.1),
        ],
      ),
      block(`${this.shell}_hideQrImage`),
    ];
  }

  /**
   * Reads codes from a camera while the read report says what each read was.
   *
   * The scan block holds its script until the sequence is complete, so the report runs beside it
   * in the script `readReportScript` returns, for as long as the scanning flag is up. The line that
   * says the sequence is complete is written here, after the scan, because the report may already
   * have stopped by the time the last read would reach it.
   */
  public scanWithReport(cameraId: InputValue): BlockNode[] {
    const { scanning, readReport } = this.references;
    return [
      setVariable(scanning, text('true')),
      broadcastMessage(readReport),
      this.pairing('scanPairingQrFromCamera', { CAMERA_ID: cameraId }),
      setVariable(scanning, text('false')),
      ifThen(
        and(
          not(this.ended()),
          greaterThan(this.pairingValue('pairingRequiredParts'), number(0)),
        ),
        [
          this.notice(
            concatenate(
              text('QRコードを全部読み取りました（'),
              this.pairingValue('pairingRequiredParts'),
              text(' 枚）。'),
            ),
          ),
        ],
      ),
    ];
  }

  /**
   * Says what the latest code read was, as one line that later reads replace.
   *
   * A camera reads the code in front of it several times a second, so a new code's line would be
   * gone before anyone read it if every read replaced it. A newly received code always takes the
   * line; a repeat, or a code of another pairing, only once the line has stood for
   * `REPORT_HOLD_SECONDS`. A code of another pairing is a warning that changes nothing.
   */
  public readReportScript(): BlockNode[] {
    const { scanning, readsSeen, readReport, reportedAt } = this.references;
    const reads = this.pairingValue('pairingReadCount');
    const lastRead = (result: string) =>
      equals(this.pairingValue('pairingLastRead'), text(result));
    const remaining = reporter(
      subtract(
        this.pairingValue('pairingRequiredParts'),
        this.pairingValue('pairingReceivedParts'),
      ),
    );
    const detail = this.pairingValue('pairingLastReadDetail');
    const show = (message: InputValue): BlockNode[] => [
      this.notice(message),
      setVariable(reportedAt, secondsNow()),
    ];
    const progress = (opening: string): BlockNode[] => [
      ifElse(
        greaterThan(remaining, number(0)),
        show(
          concatenate(
            text(opening),
            detail,
            text('）。あと '),
            remaining,
            text(' 枚です。'),
          ),
        ),
        show(
          concatenate(text(opening), detail, text('）。全部そろいました。')),
        ),
      ),
    ];
    const held = not(
      lessThan(secondsSince(reportedAt), number(REPORT_HOLD_SECONDS)),
    );
    return [
      whenBroadcastReceived(readReport),
      setVariable(readsSeen, reads),
      setVariable(reportedAt, number(0)),
      repeatUntil(equals(variable(scanning), text('false')), [
        ifThen(greaterThan(reads, variable(readsSeen)), [
          setVariable(readsSeen, reads),
          ifElse(lastRead('accepted'), progress('QRコードを読み取りました（'), [
            ifThen(held, [
              ifElse(
                lastRead('duplicate'),
                progress('このQRコードは読み取り済みです（'),
                show(
                  concatenate(
                    text(
                      '注意: 別のペアリングのQRコードを読んだため、無視しました（',
                    ),
                    detail,
                    text('）。'),
                  ),
                ),
              ),
            ]),
          ]),
        ]),
        wait(0.1),
      ]),
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

import {
  block,
  namedReference,
  number,
  reporter,
  script,
  text,
  variable,
  type Script
} from '../../packages/sb3-script/src/blocks.ts';
import {
  changeVariable,
  equals,
  ifElse,
  ifThen,
  join,
  not,
  setVariable
} from '../../packages/sb3-script/src/standard.ts';
import {
  concatenate,
  pairingButtons,
  pairingReferences,
  PairingSteps,
  pairingVariables
} from './pairing.ts';

const shell = 'realtimemotioncapturefusionshell';
const titleMenu = 'kubohiroyaturbowarptitlemenu';
const cameraSource = 'kubohiroyacamerasource';

/** Menu action ids. The hat matches on these, so they are part of the script's contract. */
const action = {
  dslFiles: 'dslFiles',
  pairCameraApp: 'pairCameraApp',
  cancelPairing: 'cancelPairing',
  diagnostics: 'diagnostics'
} as const;

/** The camera the answer is read with. Its own name, so it never shares a lease with anything else. */
const answerCameraId = 'pairing';

const pairingRefs = pairingReferences();
const pairing = new PairingSteps(shell, pairingRefs);
/** Numbers the camera apps in the order they were paired: camera-1, camera-2, ... */
const pairedCameraCount = namedReference('paired camera count', 'variable:paired-camera-count');

export const fusionAppStageData = {
  variables: {
    ...pairingVariables(pairingRefs, ''),
    [pairedCameraCount.id]: [pairedCameraCount.name, 0]
  },
  broadcasts: {}
} as const;

const joinLabel = (left: string, right: ReturnType<typeof block>) =>
  reporter(join(text(left), reporter(right)));

const menu = () => [
  block(`${titleMenu}_clearAppMenuActions`),
  block(`${titleMenu}_addAppMenuAction`, {
    ACTION: text(action.dslFiles),
    LABEL: text('演出ファイルを選ぶ')
  }),
  ifThen(pairing.featureEnabled(), [
    block(`${titleMenu}_addAppMenuAction`, {
      ACTION: text(action.pairCameraApp),
      LABEL: text('カメラアプリと接続する')
    }),
    block(`${titleMenu}_addAppMenuAction`, {
      ACTION: text(action.cancelPairing),
      LABEL: text('接続をやめる')
    })
  ]),
  block(`${titleMenu}_addAppMenuAction`, {
    ACTION: text(action.diagnostics),
    LABEL: text('動作状況を見る')
  })
];

const stopAnswerPreview = () => [
  block(`${cameraSource}_hideCameraPreview`, {CAMERA_ID: text(answerCameraId)}),
  block(`${cameraSource}_stopSharedCamera`, {CAMERA_ID: text(answerCameraId)})
];

/**
 * The fusion app's startup and menu.
 *
 * The DSL file manager is reached from this application's own menu entry rather than the
 * extension's built-in one, so every item an operator sees belongs to one vocabulary.
 */
export const fusionAppScripts: readonly Script[] = [
  script({x: 48, y: 48}, [
    block('event_whenflagclicked'),
    block(`${shell}_showAppLoading`, {LABEL: text('統合アプリを起動しています')}),
    ...menu(),
    block(`${shell}_hideAppLoading`),
    block(`${titleMenu}_showMenu`)
  ]),

  script({x: 48, y: 320}, [
    block(`${titleMenu}_whenAppMenuActionSelected`, {}, {ACTION: action.dslFiles}),
    block(`${titleMenu}_showDslFiles`)
  ]),

  /**
   * A DSL is announced by the extension, not polled for. The source is read here so a later script
   * can validate it; nothing consumes it yet.
   */
  script({x: 48, y: 480}, [
    block(`${titleMenu}_whenDslSourceOpened`),
    block(`${shell}_showAppNotice`, {
      MESSAGE: joinLabel('読み込んだ演出ファイル: ', block(`${titleMenu}_openedDslName`))
    })
  ]),

  script({x: 48, y: 660}, [
    block(`${titleMenu}_whenAppMenuActionSelected`, {}, {ACTION: action.diagnostics}),
    block(`${shell}_showAppNotice`, {
      MESSAGE: joinLabel('起動時の機能設定: ', block(`${shell}_appFeatureFlagState`))
    })
  ]),

  /**
   * M-07, hub side: project an offer, then read the answer a courier brings on a phone.
   *
   * Each pairing opens its own session and names the camera app after the order it joined, so a
   * second camera app's answer can never complete the first one's exchange. The answer camera shows
   * a preview while it reads, because the courier has to see where to hold the phone.
   */
  script({x: 600, y: 48}, [
    block(`${titleMenu}_whenAppMenuActionSelected`, {}, {ACTION: action.pairCameraApp}),
    ifElse(
      not(pairing.featureEnabled()),
      [pairing.error(text('この配布物ではQRペアリングが無効です。'), 'PAIRING_DISABLED')],
      [
        changeVariable(pairedCameraCount, 1),
        setVariable(pairingRefs.session, reporter(join(text('camera-'), variable(pairedCameraCount)))),
        block(`${shell}_showAppLoading`, {LABEL: text('Offerを作っています')}),
        pairing.pairing('startOfferPairing', {
          LOCAL_PEER: text('fusion'),
          REMOTE_PEER: variable(pairingRefs.session)
        }),
        pairing.pairing('setPairingTimeout', {SECONDS: number(600)}),
        block(`${shell}_hideAppLoading`),
        ifElse(
          not(pairing.phaseIs('offer-ready')),
          [pairing.reportEnded()],
          [
            ...pairing.presentParts(
              concatenate(text('Offer（'), variable(pairingRefs.session), text('）')),
              'カメラアプリのカメラに写してください。Answerを運んできたら「Answerを読み取る」を押します',
              [pairingButtons.next, pairingButtons.readAnswer, pairingButtons.cancel],
              pairing.pairing('isPairingConnected')
            ),
            ifElse(
              equals(variable(pairingRefs.step), text('read-answer')),
              [
                pairing.notice(
                  text(
                    'スマートフォンに表示したAnswerのQRコードを、このPCのカメラに写してください。複数枚のときは全部を写します。'
                  )
                ),
                block(`${cameraSource}_startSharedCamera`, {
                  CAMERA_ID: text(answerCameraId),
                  DEVICE_ID: text('')
                }),
                block(`${cameraSource}_showCameraPreview`, {
                  CAMERA_ID: text(answerCameraId),
                  PREVIEW_FLIP: text('horizontal')
                }),
                ...menu(),
                block(`${titleMenu}_showMenu`),
                pairing.pairing('scanPairingQrFromCamera', {CAMERA_ID: text(answerCameraId)}),
                ...stopAnswerPreview(),
                pairing.awaitConnection(),
                ifElse(
                  pairing.pairing('isPairingConnected'),
                  [pairing.pairing('endPairingQrDisplay'), ...pairing.exchangeTestMessage('fusion-app')],
                  [pairing.reportEnded()]
                )
              ],
              [
                ifElse(
                  equals(variable(pairingRefs.step), text('cancel')),
                  pairing.cancel(),
                  [pairing.reportEnded()]
                )
              ]
            )
          ]
        )
      ]
    ),
    ...menu(),
    block(`${titleMenu}_showMenu`)
  ]),

  script({x: 600, y: 1400}, [
    block(`${titleMenu}_whenAppMenuActionSelected`, {}, {ACTION: action.cancelPairing}),
    ...stopAnswerPreview(),
    ...pairing.cancel(),
    ...menu(),
    block(`${titleMenu}_showMenu`)
  ])
];

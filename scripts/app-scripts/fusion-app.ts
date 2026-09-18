import {
  block,
  namedReference,
  number,
  reporter,
  script,
  text,
  variable,
  type InputValue,
  type Script,
} from '../../packages/sb3-script/src/blocks.ts';
import {
  addToList,
  changeVariable,
  deleteAllOfList,
  equals,
  greaterThan,
  ifElse,
  ifThen,
  join,
  lengthOfList,
  not,
  or,
  repeatUntil,
  setVariable,
} from '../../packages/sb3-script/src/standard.ts';
import {
  messageDispatcher,
  networkReferences,
  networkVariables,
} from './network.ts';
import {
  fusionPoseChannelSetup,
  fusionPoseSummary,
  poseReplayFlag,
} from './pose.ts';
import {
  configurePose3dServiceSteps,
  external3dServiceFlag,
  fusionPose3dReferences,
  fusionPose3dScripts,
  fusionPose3dVariables,
  pose3dService,
  pose3dStatusText,
} from './pose-3d.ts';
import {
  fusionSyncLists,
  fusionSyncReferences,
  fusionSyncRoute,
  fusionSyncSteps,
  fusionSyncVariables,
  spaceTimeSolveSteps,
} from './space-time.ts';
import {
  concatenate,
  linkTestMessage,
  pairingBroadcasts,
  pairingButtons,
  pairingReferences,
  PairingSteps,
  pairingVariables,
} from './pairing.ts';
import {
  AvatarSteps,
  avatarReferences,
  avatarVariables,
  avatarVisibilityScripts,
  chooseAvatarVrmSteps,
} from './avatar.ts';

const shell = 'realtimemotioncapturefusionshell';
const titleMenu = 'kubohiroyaturbowarptitlemenu';
const cameraSource = 'kubohiroyacamerasource';

/** Menu action ids. The hat matches on these, so they are part of the script's contract. */
const action = {
  dslFiles: 'dslFiles',
  pairCameraApp: 'pairCameraApp',
  spaceTimeCalibration: 'spaceTimeCalibration',
  start3d: 'start3d',
  stop3d: 'stop3d',
  cancelPairing: 'cancelPairing',
  diagnostics: 'diagnostics',
  chooseRecording: 'chooseRecording',
  startReplay: 'startReplay',
  stopReplay: 'stopReplay',
  chooseAvatarVrm: 'chooseAvatarVrm',
} as const;

/** The camera the answer is read with. Its own name, so it never shares a lease with anything else. */
const answerCameraId = 'pairing';
/**
 * How long each offer code stays on the projection before the next. The camera app reads every
 * frame and takes the codes in any order, so the codes cycle by themselves; this is long enough for a
 * camera to catch each one in several frames, and a missed one comes round again.
 */
const offerCycleSeconds = 0.8;

const pairingRefs = pairingReferences();
const networkRefs = networkReferences();
const syncRefs = fusionSyncReferences();
const pose3dRefs = fusionPose3dReferences();
const avatarRefs = avatarReferences();
const avatar = new AvatarSteps(shell, avatarRefs);
const poseSummary = {
  index: namedReference('pose summary index', 'variable:pose-summary-index'),
  peer: namedReference('pose summary peer', 'variable:pose-summary-peer'),
  summary: namedReference('pose summary', 'variable:pose-summary'),
};
const pairing = new PairingSteps(shell, pairingRefs);
/** Numbers the camera apps in the order they were paired: camera-1, camera-2, ... */
const pairedCameraCount = namedReference(
  'paired camera count',
  'variable:paired-camera-count',
);

const replayRunning = namedReference(
  'replay running',
  'variable:replay-running',
);
const replay3dEnabled = namedReference(
  'replay 3D enabled',
  'variable:replay-3d-enabled',
);
const replayIndex = namedReference('replay index', 'variable:replay-index');
const replayCamera = namedReference('replay camera', 'variable:replay-camera');
const replayFrame = namedReference('replay frame', 'variable:replay-frame');
const replayPayload = namedReference(
  'replay space-time payload',
  'variable:replay-space-time-payload',
);
const replayWindowStart = namedReference(
  'replay window start',
  'variable:replay-window-start',
);

export const fusionAppStageData = {
  variables: {
    ...pairingVariables(pairingRefs, ''),
    ...networkVariables(networkRefs),
    ...fusionSyncVariables(syncRefs),
    ...fusionPose3dVariables(pose3dRefs),
    ...avatarVariables(avatarRefs),
    [replayRunning.id]: [replayRunning.name, 'false'],
    [replay3dEnabled.id]: [replay3dEnabled.name, 'false'],
    [replayIndex.id]: [replayIndex.name, 0],
    [replayCamera.id]: [replayCamera.name, ''],
    [replayFrame.id]: [replayFrame.name, ''],
    [replayPayload.id]: [replayPayload.name, ''],
    [replayWindowStart.id]: [replayWindowStart.name, 0],
    [poseSummary.index.id]: [poseSummary.index.name, 0],
    [poseSummary.peer.id]: [poseSummary.peer.name, ''],
    [poseSummary.summary.id]: [poseSummary.summary.name, ''],
    [pairedCameraCount.id]: [pairedCameraCount.name, 0],
  },
  lists: fusionSyncLists(syncRefs),
  broadcasts: {
    ...pairingBroadcasts(pairingRefs),
  },
} as const;

const shellBlock = (
  opcode: string,
  inputs: Readonly<Record<string, InputValue>> = {},
) => block(`${shell}_${opcode}`, inputs);
const shellValue = (opcode: string) => reporter(shellBlock(opcode));
const shellValueWith = (
  opcode: string,
  inputs: Readonly<Record<string, InputValue>>,
) => reporter(shellBlock(opcode, inputs));
const serviceBlock = (
  opcode: string,
  inputs: Readonly<Record<string, InputValue>> = {},
) => block(`${pose3dService}_${opcode}`, inputs);

const joinLabel = (left: string, right: ReturnType<typeof block>) =>
  reporter(join(text(left), reporter(right)));

const menu = () => [
  block(`${titleMenu}_clearAppMenuActions`),
  block(`${titleMenu}_addAppMenuAction`, {
    ACTION: text(action.dslFiles),
    LABEL: text('演出ファイルを選ぶ'),
  }),
  ifThen(pairing.featureEnabled(), [
    block(`${titleMenu}_addAppMenuAction`, {
      ACTION: text(action.pairCameraApp),
      LABEL: text('カメラアプリと接続する'),
    }),
    block(`${titleMenu}_addAppMenuAction`, {
      ACTION: text(action.cancelPairing),
      LABEL: text('接続をやめる'),
    }),
    block(`${titleMenu}_addAppMenuAction`, {
      ACTION: text(action.spaceTimeCalibration),
      LABEL: text('空間と時刻を校正する'),
    }),
  ]),
  ifThen(
    block(`${shell}_appFeatureEnabled`, {
      FEATURE: text(external3dServiceFlag),
    }),
    [
      block(`${titleMenu}_addAppMenuAction`, {
        ACTION: text(action.start3d),
        LABEL: text('3D統合を開始する'),
      }),
      block(`${titleMenu}_addAppMenuAction`, {
        ACTION: text(action.stop3d),
        LABEL: text('3D統合を止める'),
      }),
      block(`${titleMenu}_addAppMenuAction`, {
        ACTION: text(action.chooseAvatarVrm),
        LABEL: text('アバターのVRMを指定する'),
      }),
    ],
  ),
  ifThen(
    block(`${shell}_appFeatureEnabled`, { FEATURE: text(poseReplayFlag) }),
    [
      block(`${titleMenu}_addAppMenuAction`, {
        ACTION: text(action.chooseRecording),
        LABEL: text('録画を読み込む'),
      }),
      block(`${titleMenu}_addAppMenuAction`, {
        ACTION: text(action.startReplay),
        LABEL: text('録画で校正して再生する（接続不要）'),
      }),
      block(`${titleMenu}_addAppMenuAction`, {
        ACTION: text(action.stopReplay),
        LABEL: text('再生を止める'),
      }),
    ],
  ),
  block(`${titleMenu}_addAppMenuAction`, {
    ACTION: text(action.diagnostics),
    LABEL: text('動作状況を見る'),
  }),
];

const stopAnswerPreview = () => [
  block(`${cameraSource}_hideCameraPreview`, {
    CAMERA_ID: text(answerCameraId),
  }),
  block(`${cameraSource}_stopSharedCamera`, {
    CAMERA_ID: text(answerCameraId),
  }),
];

/**
 * The fusion app's startup and menu.
 *
 * The DSL file manager is reached from this application's own menu entry rather than the
 * extension's built-in one, so every item an operator sees belongs to one vocabulary.
 */
export const fusionAppScripts: readonly Script[] = [
  messageDispatcher(
    shell,
    networkRefs,
    [
      {
        type: linkTestMessage,
        handle: [
          setVariable(pairingRefs.linkTest, variable(networkRefs.message)),
        ],
      },
      fusionSyncRoute(syncRefs, networkRefs.message),
    ],
    { x: 1200, y: 48 },
  ),

  /** M-10 (#34 stage 1): forward 2D poses to the 3D pose service and show its state. */
  ...fusionPose3dScripts({
    shell,
    titleMenu,
    references: pose3dRefs,
    spaceTimeReady: syncRefs.ready,
    spaceTimeResults: syncRefs.results,
    startAction: action.start3d,
    stopAction: action.stop3d,
    position: { x: 1800, y: 48 },
    avatar: {
      setup: avatar.setup(),
      frame: avatar.frame(),
      stop: avatar.stop(),
      status: avatar.status(),
    },
  }),

  /** Shows each avatar while its person is recognized. */
  ...avatarVisibilityScripts({ x: 2400, y: 48 }),

  script({ x: 2400, y: 500 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.chooseAvatarVrm },
    ),
    ...chooseAvatarVrmSteps(shell),
    block(`${titleMenu}_showMenu`),
  ]),

  /** M-08, fusion side: project the pattern, collect every camera's result, solve, and gate READY. */
  script({ x: 1200, y: 700 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.spaceTimeCalibration },
    ),
    ...fusionSyncSteps({ shell, references: syncRefs }),
    ...menu(),
    block(`${titleMenu}_showMenu`),
  ]),

  script({ x: 48, y: 48 }, [
    block('event_whenflagclicked'),
    block(`${shell}_showAppLoading`, {
      LABEL: text('統合アプリを起動しています'),
    }),
    ...menu(),
    block(`${shell}_hideAppLoading`),
    block(`${titleMenu}_showMenu`),
  ]),

  script({ x: 48, y: 320 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.dslFiles },
    ),
    block(`${titleMenu}_showDslFiles`),
  ]),

  /**
   * A DSL is announced by the extension, not polled for. The source is read here so a later script
   * can validate it; nothing consumes it yet.
   */
  script({ x: 48, y: 480 }, [
    block(`${titleMenu}_whenDslSourceOpened`),
    block(`${shell}_showAppNotice`, {
      MESSAGE: joinLabel(
        '読み込んだ演出ファイル: ',
        block(`${titleMenu}_openedDslName`),
      ),
    }),
  ]),

  script({ x: 48, y: 660 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.diagnostics },
    ),
    ...fusionPoseSummary({ shell, ...poseSummary }),
    block(`${shell}_showAppNotice`, {
      MESSAGE: reporter(
        join(
          joinLabel(
            '起動時の機能設定: ',
            block(`${shell}_appFeatureFlagState`),
          ),
          reporter(
            join(
              text(' / 姿勢フレーム: '),
              reporter(
                block('operator_join', {
                  STRING1: variable(poseSummary.summary),
                  STRING2: text(''),
                }),
              ),
            ),
          ),
        ),
      ),
    }),
  ]),

  /**
   * M-07, hub side: project an offer, then read the answer a courier brings on a phone.
   *
   * Each pairing opens its own session and names the camera app after the order it joined, so a
   * second camera app's answer can never complete the first one's exchange. The answer camera shows
   * a preview while it reads, because the courier has to see where to hold the phone.
   */
  script({ x: 600, y: 48 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.pairCameraApp },
    ),
    ifElse(
      not(pairing.featureEnabled()),
      [
        pairing.error(
          text('この配布物ではQRペアリングが無効です。'),
          'PAIRING_DISABLED',
        ),
      ],
      [
        changeVariable(pairedCameraCount, 1),
        setVariable(
          pairingRefs.session,
          reporter(join(text('camera-'), variable(pairedCameraCount))),
        ),
        block(`${shell}_showAppLoading`, {
          LABEL: text('Offerを作っています'),
        }),
        pairing.resetLinkTest(),
        // The offer carries the channels it was created with, so the pose channel exists first.
        ...fusionPoseChannelSetup(variable(pairingRefs.session)),
        pairing.pairing('startOfferPairing', {
          LOCAL_PEER: text('fusion'),
          REMOTE_PEER: variable(pairingRefs.session),
        }),
        pairing.pairing('setPairingTimeout', { SECONDS: number(600) }),
        block(`${shell}_hideAppLoading`),
        ifElse(
          not(pairing.phaseIs('offer-ready')),
          [pairing.reportEnded()],
          [
            ...pairing.presentParts(
              concatenate(
                text('Offer（'),
                variable(pairingRefs.session),
                text('）'),
              ),
              'カメラアプリのカメラに写してください。QRは自動で切り替わり、順番は問いません。Answerを運んできたら「Answerを読み取る」を押します',
              [pairingButtons.readAnswer, pairingButtons.cancel],
              pairing.pairing('isPairingConnected'),
              offerCycleSeconds,
            ),
            ifElse(
              // The exchange can connect while the Offer is still on screen: the camera app's answer
              // reached this app by another route, or a retry completed. That is a connection, not a
              // failure, so it is taken before the operator's button is read.
              pairing.pairing('isPairingConnected'),
              [
                pairing.pairing('endPairingQrDisplay'),
                ...pairing.exchangeTestMessage('fusion-app'),
              ],
              [
                ifElse(
                  equals(variable(pairingRefs.step), text('read-answer')),
                  [
                    pairing.notice(
                      text(
                        'スマートフォンに表示したAnswerのQRコードを、このPCのカメラに写してください。複数枚のときは順番を問わず全部を写します。',
                      ),
                    ),
                    block(`${cameraSource}_startSharedCamera`, {
                      CAMERA_ID: text(answerCameraId),
                      DEVICE_ID: text(''),
                    }),
                    block(`${cameraSource}_showCameraPreview`, {
                      CAMERA_ID: text(answerCameraId),
                      PREVIEW_FLIP: text('horizontal'),
                    }),
                    ...menu(),
                    block(`${titleMenu}_showMenu`),
                    ...pairing.scanWithReport(text(answerCameraId)),
                    ...stopAnswerPreview(),
                    pairing.awaitConnection(),
                    ifElse(
                      pairing.pairing('isPairingConnected'),
                      [
                        pairing.pairing('endPairingQrDisplay'),
                        ...pairing.exchangeTestMessage('fusion-app'),
                      ],
                      [pairing.reportEnded()],
                    ),
                  ],
                  [
                    ifElse(
                      equals(variable(pairingRefs.step), text('cancel')),
                      pairing.cancel(),
                      [pairing.reportEnded()],
                    ),
                  ],
                ),
              ],
            ),
          ],
        ),
      ],
    ),
    ...menu(),
    block(`${titleMenu}_showMenu`),
  ]),

  /** Says what each code the answer camera read was, while the scan above runs. */
  script({ x: 600, y: 1700 }, pairing.readReportScript()),

  script({ x: 600, y: 1400 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.cancelPairing },
    ),
    ...stopAnswerPreview(),
    ...pairing.cancel(),
    ...menu(),
    block(`${titleMenu}_showMenu`),
  ]),

  /** DEBUG_POSE_REPLAY: choose a recording kept on this PC, or open a file. */
  script({ x: 2600, y: 3600 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.chooseRecording },
    ),
    shellBlock('refreshRecordings'),
    ifElse(
      equals(shellValue('recordingCount'), number(0)),
      [shellBlock('loadRecording', { NAME: text('') })],
      [
        shellBlock('showAppNotice', {
          MESSAGE: concatenate(text('録画: '), shellValue('recordingsSummary')),
        }),
        shellBlock('askNumbers', {
          TITLE: text(
            '読み込む録画の番号を入力してください（表示した順に1から数えます）。',
          ),
          FIELDS: text('番号'),
          DEFAULTS: text('1'),
        }),
        ifElse(
          equals(shellValue('answeredNumbers'), text('')),
          [
            shellBlock('showAppNotice', {
              MESSAGE: text('録画の読み込みをやめました。'),
            }),
          ],
          [
            shellBlock('loadRecording', {
              NAME: shellValueWith('recordingNameAt', {
                INDEX: shellValue('answeredNumbers'),
              }),
            }),
          ],
        ),
      ],
    ),
    ifElse(
      equals(shellValue('poseReplayError'), text('')),
      [
        shellBlock('showAppNotice', {
          MESSAGE: concatenate(
            text('読み込みました: '),
            shellValue('replaySummary'),
          ),
        }),
      ],
      [
        shellBlock('showAppError', {
          MESSAGE: concatenate(
            text('録画を読み込めませんでした: '),
            shellValue('poseReplayError'),
          ),
          DETAILS: text(JSON.stringify({ code: 'RECORDING_LOAD_FAILED' })),
        }),
      ],
    ),
    ...menu(),
    block(`${titleMenu}_showMenu`),
  ]),

  /**
   * DEBUG_POSE_REPLAY: run the whole fusion side against a recording, with no camera app connected.
   *
   * The calibration is redone from what the recording carries, rather than assumed: a recording made
   * by camera apps carries each camera's own measurement, so the placement is solved here exactly as
   * it was on the day, corner measurements and all. A recording made by the local app already carries
   * a solved configuration, and that is applied as it stands.
   */
  script({ x: 2600, y: 4800 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.startReplay },
    ),
    ifElse(
      equals(shellValue('replaySummary'), text('録画を読み込んでいません。')),
      [
        shellBlock('showAppError', {
          MESSAGE: text('先に「録画を読み込む」で録画を選んでください。'),
          DETAILS: text(JSON.stringify({ code: 'REPLAY_NOT_LOADED' })),
        }),
      ],
      [
        setVariable(replayRunning, text('true')),
        // The recording's own space-time measurements stand in for the camera apps' replies.
        deleteAllOfList(syncRefs.results),
        setVariable(syncRefs.expected, number(0)),
        setVariable(replayIndex, number(0)),
        repeatUntil(
          equals(
            shellValueWith('jsonValueAt', {
              JSON: shellValue('replayCamerasJson'),
              PATH: reporter(join(variable(replayIndex), text(''))),
            }),
            text(''),
          ),
          [
            setVariable(
              replayCamera,
              shellValueWith('jsonValueAt', {
                JSON: shellValue('replayCamerasJson'),
                PATH: reporter(join(variable(replayIndex), text(''))),
              }),
            ),
            setVariable(
              replayPayload,
              shellValueWith('replaySpaceTimePayload', {
                CAMERA_ID: variable(replayCamera),
              }),
            ),
            ifThen(not(equals(variable(replayPayload), text(''))), [
              changeVariable(syncRefs.expected, 1),
              addToList(
                shellValueWith('jsonWithJsonField', {
                  JSON: shellValueWith('jsonWithTextField', {
                    JSON: text('{}'),
                    KEY: text('peer'),
                    VALUE: variable(replayCamera),
                  }),
                  KEY: text('payload'),
                  VALUE: variable(replayPayload),
                }),
                syncRefs.results,
              ),
            ]),
            changeVariable(replayIndex, 1),
          ],
        ),
        ifThen(
          greaterThan(reporter(lengthOfList(syncRefs.results)), number(0)),
          [...spaceTimeSolveSteps(shell, syncRefs)],
        ),
        ifThen(
          block(`${shell}_appFeatureEnabled`, {
            FEATURE: text(external3dServiceFlag),
          }),
          [
            shellBlock('showAppLoading', {
              LABEL: text('録画の校正で3Dサービスを準備しています'),
            }),
            ifElse(
              equals(variable(syncRefs.ready), text('true')),
              configurePose3dServiceSteps({
                shell,
                spaceTimeResults: syncRefs.results,
                index: syncRefs.index,
                item: syncRefs.item,
              }),
              [
                // A local-app recording carries the configuration it was estimated under.
                serviceBlock('applyConfigurationJson', {
                  CONFIGURATION_JSON: shellValue('replayConfigurationJson'),
                }),
              ],
            ),
            shellBlock('hideAppLoading'),
            ifElse(
              equals(reporter(serviceBlock('serviceState')), text('ready')),
              [setVariable(replay3dEnabled, text('true')), ...avatar.setup()],
              [
                setVariable(replay3dEnabled, text('false')),
                shellBlock('showAppError', {
                  MESSAGE: concatenate(
                    text('録画の校正で3Dサービスを開始できませんでした: '),
                    reporter(serviceBlock('serviceError')),
                  ),
                  DETAILS: text(
                    JSON.stringify({ code: 'POSE_3D_CONFIGURE_FAILED' }),
                  ),
                }),
              ],
            ),
          ],
        ),
        shellBlock('startPoseReplay'),
        shellBlock('showAppNotice', {
          MESSAGE: concatenate(
            text('録画を再生しています: '),
            shellValue('replaySummary'),
          ),
        }),
        block(`${titleMenu}_showMenu`),
        setVariable(replayWindowStart, reporter(block('sensing_timer'))),
        repeatUntil(
          or(
            not(equals(variable(replayRunning), text('true'))),
            not(equals(shellValue('replayState'), text('playing'))),
          ),
          [
            setVariable(replayIndex, number(0)),
            repeatUntil(
              equals(
                shellValueWith('jsonValueAt', {
                  JSON: shellValue('replayCamerasJson'),
                  PATH: reporter(join(variable(replayIndex), text(''))),
                }),
                text(''),
              ),
              [
                setVariable(
                  replayCamera,
                  shellValueWith('jsonValueAt', {
                    JSON: shellValue('replayCamerasJson'),
                    PATH: reporter(join(variable(replayIndex), text(''))),
                  }),
                ),
                setVariable(
                  replayFrame,
                  shellValueWith('replayPoseFrame', {
                    CAMERA_ID: variable(replayCamera),
                  }),
                ),
                ifThen(not(equals(variable(replayFrame), text(''))), [
                  ifThen(equals(variable(replay3dEnabled), text('true')), [
                    serviceBlock('sendPoseFrame', {
                      FRAME_JSON: variable(replayFrame),
                      CAMERA_ID: variable(replayCamera),
                      AGE_MS: shellValueWith('poseFrameAgeMs', {
                        FRAME_JSON: variable(replayFrame),
                      }),
                    }),
                  ]),
                ]),
                changeVariable(replayIndex, 1),
              ],
            ),
            ifThen(equals(variable(replay3dEnabled), text('true')), [
              serviceBlock('requestPose3d'),
              ...avatar.frame(),
            ]),
            ifThen(
              greaterThan(
                reporter(
                  block('operator_subtract', {
                    NUM1: reporter(block('sensing_timer')),
                    NUM2: variable(replayWindowStart),
                  }),
                ),
                number(1),
              ),
              [
                ifElse(
                  equals(variable(replay3dEnabled), text('true')),
                  [
                    shellBlock('showAppNotice', {
                      MESSAGE: concatenate(
                        text('再生 '),
                        shellValue('replayPositionMs'),
                        text(' / '),
                        shellValue('replayDurationMs'),
                        text(' ms — '),
                        pose3dStatusText(shell),
                        avatar.status(),
                      ),
                    }),
                  ],
                  [
                    shellBlock('showAppNotice', {
                      MESSAGE: concatenate(
                        text('再生 '),
                        shellValue('replayPositionMs'),
                        text(' / '),
                        shellValue('replayDurationMs'),
                        text(' ms（3D統合は無効です）'),
                      ),
                    }),
                  ],
                ),
                setVariable(
                  replayWindowStart,
                  reporter(block('sensing_timer')),
                ),
              ],
            ),
          ],
        ),
        setVariable(replayRunning, text('false')),
        ifThen(equals(variable(replay3dEnabled), text('true')), [
          setVariable(replay3dEnabled, text('false')),
          ...avatar.stop(),
          serviceBlock('stopService'),
        ]),
        shellBlock('showAppNotice', {
          MESSAGE: text('録画の再生が終わりました。'),
        }),
      ],
    ),
    ...menu(),
    block(`${titleMenu}_showMenu`),
  ]),

  script({ x: 2600, y: 9600 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.stopReplay },
    ),
    ifElse(
      equals(variable(replayRunning), text('true')),
      [
        setVariable(replayRunning, text('false')),
        shellBlock('stopPoseReplay'),
        shellBlock('showAppNotice', { MESSAGE: text('再生を止めました。') }),
      ],
      [
        shellBlock('showAppNotice', {
          MESSAGE: text('録画を再生していません。'),
        }),
      ],
    ),
    ...menu(),
    block(`${titleMenu}_showMenu`),
  ]),
];

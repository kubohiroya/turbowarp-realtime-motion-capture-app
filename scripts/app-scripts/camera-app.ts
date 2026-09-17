import {
  block,
  namedReference,
  number,
  reporter,
  script,
  text,
  variable,
  type BlockNode,
  type InputValue,
  type Script,
} from '../../packages/sb3-script/src/blocks.ts';
import {
  and,
  broadcastMessage,
  broadcastMessageAndWait,
  equals,
  forever,
  greaterThan,
  ifElse,
  changeVariable,
  ifThen,
  join,
  label,
  not,
  or,
  repeatUntil,
  setVariable,
  wait,
  waitUntil,
  whenBroadcastReceived,
  whenFlagClicked,
} from '../../packages/sb3-script/src/standard.ts';
import {
  messageDispatcher,
  networkReferences,
  networkVariables,
} from './network.ts';
import {
  cameraPoseReferences,
  cameraPoseScripts,
  cameraPoseVariables,
  poseChannel,
  poseReplayFlag,
} from './pose.ts';
import {
  cameraSyncBroadcasts,
  cameraSyncReferences,
  cameraSyncRoute,
  cameraSyncSteps,
  cameraSyncVariables,
} from './space-time.ts';
import {
  linkTestMessage,
  pairingButtons,
  pairingReferences,
  PairingSteps,
  pairingVariables,
} from './pairing.ts';

const shell = 'realtimemotioncapturecamerashell';
const titleMenu = 'kubohiroyaturbowarptitlemenu';
const cameraSource = 'kubohiroyacamerasource';

const action = {
  chooseCamera: 'chooseCamera',
  openLensCalibration: 'openLensCalibration',
  loadLensCalibrationFile: 'loadLensCalibrationFile',
  pairWithFusion: 'pairWithFusion',
  startPose: 'startPose',
  stopPose: 'stopPose',
  cancelPairing: 'cancelPairing',
  stopCamera: 'stopCamera',
  diagnostics: 'diagnostics',
  startRecording: 'startRecording',
  stopRecording: 'stopRecording',
  chooseRecording: 'chooseRecording',
  startReplay: 'startReplay',
  stopReplay: 'stopReplay',
} as const;

const pairingRefs = pairingReferences();
const networkRefs = networkReferences();
const syncRefs = cameraSyncReferences();
const poseRefs = cameraPoseReferences();

const cameraId = 'pose';
const replayRunning = namedReference(
  'replay running',
  'variable:replay-running',
);
const replayFrame = namedReference('replay frame', 'variable:replay-frame');
const replayWindowStart = namedReference(
  'replay window start',
  'variable:replay-window-start',
);
const replayFrames = namedReference('replay frames', 'variable:replay-frames');
const replaySyncPayload = namedReference(
  'replay space-time payload',
  'variable:replay-space-time-payload',
);
const cameraShouldBeRunning = namedReference(
  'camera should be running',
  'variable:camera-should-be-running',
);
const selectedDeviceIndex = namedReference(
  'selected device index',
  'variable:selected-device-index',
);
const lastCameraStartErrorCode = namedReference(
  'last camera start error code',
  'variable:last-camera-start-error-code',
);
/** `true` only while a lens profile that fits the running camera is registered for it. */
const lensCalibrationReady = namedReference(
  'lens calibration ready',
  'variable:lens-calibration-ready',
);
/** The device to give the camera back to once the calibration window has let go of it. */
const lensCalibrationDeviceId = namedReference(
  'lens calibration device ID',
  'variable:lens-calibration-device-id',
);
/** The stored-profile generation when the calibration window opened; a larger one means it saved. */
const storedProfilesGenerationBefore = namedReference(
  'stored profiles generation before',
  'variable:stored-profiles-generation-before',
);
const lensProfileRejection = namedReference(
  'lens profile rejection',
  'variable:lens-profile-rejection',
);
const lensCalibrationRequested = namedReference(
  'lens calibration requested',
  'broadcast:lens-calibration-requested',
);
const cameraDeviceSelected = namedReference(
  'camera device selected',
  'broadcast:camera-device-selected',
);
const menuActionsRequested = namedReference(
  'menu actions requested',
  'broadcast:menu-actions-requested',
);
const maximumMenuDevices = 8;

export const cameraAppStageData = {
  variables: {
    [cameraShouldBeRunning.id]: [cameraShouldBeRunning.name, 'false'],
    [replayRunning.id]: [replayRunning.name, 'false'],
    [replayFrame.id]: [replayFrame.name, ''],
    [replayWindowStart.id]: [replayWindowStart.name, 0],
    [replayFrames.id]: [replayFrames.name, 0],
    [replaySyncPayload.id]: [replaySyncPayload.name, ''],
    [selectedDeviceIndex.id]: [selectedDeviceIndex.name, 1],
    [lastCameraStartErrorCode.id]: [lastCameraStartErrorCode.name, ''],
    [lensCalibrationReady.id]: [lensCalibrationReady.name, 'false'],
    [lensCalibrationDeviceId.id]: [lensCalibrationDeviceId.name, ''],
    [storedProfilesGenerationBefore.id]: [
      storedProfilesGenerationBefore.name,
      0,
    ],
    [lensProfileRejection.id]: [lensProfileRejection.name, ''],
    ...pairingVariables(pairingRefs, 'fusion-link'),
    ...networkVariables(networkRefs),
    ...cameraSyncVariables(syncRefs),
    ...cameraPoseVariables(poseRefs),
  },
  broadcasts: {
    ...cameraSyncBroadcasts(syncRefs),
    [lensCalibrationRequested.id]: lensCalibrationRequested.name,
    [cameraDeviceSelected.id]: cameraDeviceSelected.name,
    [menuActionsRequested.id]: menuActionsRequested.name,
  },
} as const;

const cameraDeviceAction = (index: number) => `cameraDevice${index}`;
const cameraBlock = (
  opcode: string,
  inputs: Readonly<Record<string, InputValue>> = {},
) => block(`${cameraSource}_${opcode}`, inputs);
const cameraValue = (
  opcode: string,
  inputs: Readonly<Record<string, InputValue>> = {},
) => reporter(cameraBlock(opcode, inputs));

const concatenate = (
  first: InputValue,
  ...rest: readonly InputValue[]
): InputValue =>
  rest.reduce((left, right) => reporter(join(left, right)), first);

const shellBlock = (
  opcode: string,
  inputs: Readonly<Record<string, InputValue>> = {},
) => block(`${shell}_${opcode}`, inputs);
const shellValue = (opcode: string) => reporter(shellBlock(opcode));
const shellValueWith = (
  opcode: string,
  inputs: Readonly<Record<string, InputValue>>,
) => reporter(shellBlock(opcode, inputs));

const pairing = new PairingSteps(shell, pairingRefs);

const baseMenuActions = (chooseCameraLabel: string): BlockNode[] => [
  block(`${titleMenu}_addAppMenuAction`, {
    ACTION: text(action.chooseCamera),
    LABEL: text(chooseCameraLabel),
  }),
  block(`${titleMenu}_addAppMenuAction`, {
    ACTION: text(action.openLensCalibration),
    LABEL: text('レンズ校正アプリで校正する'),
  }),
  block(`${titleMenu}_addAppMenuAction`, {
    ACTION: text(action.loadLensCalibrationFile),
    LABEL: text('レンズ校正ファイルを読む'),
  }),
  ifThen(
    block(`${shell}_appFeatureEnabled`, { FEATURE: text(poseReplayFlag) }),
    [
      block(`${titleMenu}_addAppMenuAction`, {
        ACTION: text(action.startRecording),
        LABEL: text('ポーズの録画を始める'),
      }),
      block(`${titleMenu}_addAppMenuAction`, {
        ACTION: text(action.stopRecording),
        LABEL: text('ポーズの録画を止めて保存する'),
      }),
      block(`${titleMenu}_addAppMenuAction`, {
        ACTION: text(action.chooseRecording),
        LABEL: text('録画を読み込む'),
      }),
      block(`${titleMenu}_addAppMenuAction`, {
        ACTION: text(action.startReplay),
        LABEL: text('録画で再生する（カメラ不要）'),
      }),
      block(`${titleMenu}_addAppMenuAction`, {
        ACTION: text(action.stopReplay),
        LABEL: text('再生を止める'),
      }),
    ],
  ),
  ifThen(pairing.featureEnabled(), [
    block(`${titleMenu}_addAppMenuAction`, {
      ACTION: text(action.pairWithFusion),
      LABEL: text('統合アプリと接続する'),
    }),
    block(`${titleMenu}_addAppMenuAction`, {
      ACTION: text(action.cancelPairing),
      LABEL: text('接続をやめる'),
    }),
  ]),
  ifThen(
    block(`${shell}_appFeatureEnabled`, {
      FEATURE: text('webgpuMoveNetMultiPose'),
    }),
    [
      block(`${titleMenu}_addAppMenuAction`, {
        ACTION: text(action.startPose),
        LABEL: text('姿勢推定を開始する'),
      }),
      block(`${titleMenu}_addAppMenuAction`, {
        ACTION: text(action.stopPose),
        LABEL: text('姿勢推定を止める'),
      }),
    ],
  ),
  block(`${titleMenu}_addAppMenuAction`, {
    ACTION: text(action.stopCamera),
    LABEL: text('カメラを止める'),
  }),
  block(`${titleMenu}_addAppMenuAction`, {
    ACTION: text(action.diagnostics),
    LABEL: text('動作状況を見る'),
  }),
];

const cameraDeviceMenuActions = (): BlockNode[] =>
  Array.from({ length: maximumMenuDevices }, (_, offset) => offset + 1).map(
    (index) =>
      ifThen(greaterThan(cameraValue('cameraDeviceCount'), number(index - 1)), [
        block(`${titleMenu}_addAppMenuAction`, {
          ACTION: text(cameraDeviceAction(index)),
          LABEL: label(
            `${index}: `,
            cameraBlock('cameraDeviceLabelAt', { INDEX: number(index) }),
          ),
        }),
      ]),
  );

const activeCameraSummary = (): InputValue =>
  concatenate(
    label(
      'device: ',
      cameraBlock('cameraDeviceIdReporter', { CAMERA_ID: text(cameraId) }),
    ),
    text(' / resolution: '),
    cameraValue('cameraFrameWidth', { CAMERA_ID: text(cameraId) }),
    text('x'),
    cameraValue('cameraFrameHeight', { CAMERA_ID: text(cameraId) }),
    text(' / fps: '),
    cameraValue('cameraFrameRate', { CAMERA_ID: text(cameraId) }),
    text(' / lens: '),
    cameraValue('cameraProfileCompatibility', { CAMERA_ID: text(cameraId) }),
  );

const showCameraNotFoundError = () =>
  block(`${shell}_showAppError`, {
    MESSAGE: text('カメラが見つかりません。接続を確認してください。'),
    DETAILS: text('{"code":"CAMERA_NOT_FOUND","cameraId":"pose"}'),
  });

const showCameraPermissionError = () =>
  block(`${shell}_showAppError`, {
    MESSAGE: text(
      'カメラを開始できませんでした。ブラウザのカメラ使用許可を確認してください。',
    ),
    DETAILS: text('{"code":"CAMERA_PERMISSION_DENIED","cameraId":"pose"}'),
  });

const showCameraUnavailableError = () =>
  block(`${shell}_showAppError`, {
    MESSAGE: text(
      'カメラを開始できませんでした。接続状態を確認して選び直してください。',
    ),
    DETAILS: text('{"code":"CAMERA_DEVICE_UNAVAILABLE","cameraId":"pose"}'),
  });

const showCameraStartError = (): BlockNode[] => [
  setVariable(
    lastCameraStartErrorCode,
    cameraValue('cameraErrorCode', { CAMERA_ID: text(cameraId) }),
  ),
  ifElse(
    equals(variable(lastCameraStartErrorCode), text('NotFoundError')),
    [showCameraNotFoundError()],
    [
      ifElse(
        equals(variable(lastCameraStartErrorCode), text('NotAllowedError')),
        [showCameraPermissionError()],
        [
          ifElse(
            equals(variable(lastCameraStartErrorCode), text('SecurityError')),
            [showCameraPermissionError()],
            [showCameraUnavailableError()],
          ),
        ],
      ),
    ],
  ),
];

const showPreview = (): BlockNode[] => [
  setVariable(cameraShouldBeRunning, text('true')),
  cameraBlock('showCameraPreview', {
    CAMERA_ID: text(cameraId),
    PREVIEW_FLIP: text('horizontal'),
  }),
  block(`${shell}_showAppNotice`, { MESSAGE: activeCameraSummary() }),
  broadcastMessageAndWait(lensCalibrationRequested),
];

const storedProfileResult = () =>
  cameraValue('storedCameraProfileResult', { CAMERA_ID: text(cameraId) });
const storedProfileDetail = () =>
  cameraValue('storedCameraProfileDetail', { CAMERA_ID: text(cameraId) });

const showCameraNotRunningError = () =>
  shellBlock('showAppError', {
    MESSAGE: text('先に「カメラを選ぶ」で校正するカメラを選んでください。'),
    DETAILS: text('{"code":"CAMERA_NOT_RUNNING","cameraId":"pose"}'),
  });

/**
 * Gives the camera back after the calibration window, and asks again for a profile that fits it.
 *
 * The same device is asked for by ID. Starting with an empty ID would let the browser pick, and on a
 * PC with two cameras the profile just solved could then be judged against the other one.
 */
const resumeCameraAfterLensCalibration = (): BlockNode[] => [
  cameraBlock('startSharedCamera', {
    CAMERA_ID: text(cameraId),
    DEVICE_ID: variable(lensCalibrationDeviceId),
  }),
  ifElse(
    cameraBlock('isCameraRunning', { CAMERA_ID: text(cameraId) }),
    [
      setVariable(cameraShouldBeRunning, text('true')),
      cameraBlock('showCameraPreview', {
        CAMERA_ID: text(cameraId),
        PREVIEW_FLIP: text('horizontal'),
      }),
      broadcastMessageAndWait(lensCalibrationRequested),
    ],
    showCameraStartError(),
  ),
];

export const cameraAppScripts: readonly Script[] = [
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
      cameraSyncRoute(syncRefs, networkRefs.message),
    ],
    { x: 2600, y: 48 },
  ),

  /** M-09: estimate 2D poses and stream them to the fusion app. */
  ...cameraPoseScripts({
    shell,
    titleMenu,
    cameraId,
    references: poseRefs,
    lensCalibrationReady,
    pairingSession: 'fusion-link',
    pairingExtension: 'kubohiroyawebrtcqrcodepairing',
    startAction: action.startPose,
    stopAction: action.stopPose,
    menuActionsRequested,
    position: { x: 3200, y: 48 },
  }),

  /**
   * M-08, camera side: measure time and corners when the fusion app starts a calibration.
   *
   * While replaying a recording there is no camera to measure with, so the measurement the recording
   * carries is sent instead. That is what lets the fusion app place the cameras and run the whole
   * calibration with no pattern on the wall.
   */
  script({ x: 2600, y: 700 }, [
    whenBroadcastReceived(syncRefs.requested),
    // Read only where the build carries replay: a block that is not registered must not be evaluated.
    setVariable(replaySyncPayload, text('')),
    ifThen(
      block(`${shell}_appFeatureEnabled`, { FEATURE: text(poseReplayFlag) }),
      [
        setVariable(
          replaySyncPayload,
          shellValueWith('replaySpaceTimePayload', {
            CAMERA_ID: text(cameraId),
          }),
        ),
      ],
    ),
    ifElse(
      // Answered from the recording while it is replaying, and whenever a recording is loaded and no
      // camera is open: there is nothing to measure with then, and the recording knows what this
      // camera saw.
      and(
        not(equals(variable(replaySyncPayload), text(''))),
        or(
          equals(variable(replayRunning), text('true')),
          not(cameraBlock('isCameraRunning', { CAMERA_ID: text(cameraId) })),
        ),
      ),
      [
        setVariable(syncRefs.result, variable(replaySyncPayload)),
        block(`kubohiroyawebrtc_broadcastNetworkMessage`, {
          MESSAGE: text('twrmc-sync-result'),
          PAYLOAD: variable(syncRefs.result),
          CHANNEL: text('default'),
          PEER: text('*'),
        }),
        shellBlock('showAppNotice', {
          MESSAGE: text(
            '録画に入っている空間と時刻の測定結果を統合アプリへ送りました。カメラでは測っていません。',
          ),
        }),
      ],
      [
        ...cameraSyncSteps({
          shell,
          cameraId,
          references: syncRefs,
          lensCalibrationReady,
        }),
        ifThen(
          block(`${shell}_appFeatureEnabled`, {
            FEATURE: text(poseReplayFlag),
          }),
          [
            ifThen(
              equals(
                reporter(block(`${shell}_poseRecordingState`)),
                text('recording'),
              ),
              [
                shellBlock('recordSpaceTimeResult', {
                  PAYLOAD_JSON: variable(syncRefs.result),
                  CAMERA_ID: text(cameraId),
                }),
              ],
            ),
          ],
        ),
      ],
    ),
  ]),

  script({ x: 48, y: 48 }, [
    whenFlagClicked(),
    setVariable(cameraShouldBeRunning, text('false')),
    block(`${shell}_showAppLoading`, {
      LABEL: text('カメラアプリを起動しています'),
    }),
    block(`${titleMenu}_clearAppMenuActions`),
    ...baseMenuActions('カメラを選ぶ'),
    block(`${shell}_hideAppLoading`),
    ifElse(
      not(block(`${shell}_webGpuAvailable`)),
      [
        block(`${shell}_showAppError`, {
          MESSAGE: text(
            'このブラウザではWebGPUを利用できないため、姿勢認識を開始できません。',
          ),
          DETAILS: text('{"code":"WEBGPU_UNAVAILABLE"}'),
        }),
      ],
      [block(`${titleMenu}_showMenu`)],
    ),
    forever([
      wait(0.5),
      ifThen(equals(variable(cameraShouldBeRunning), text('true')), [
        ifThen(
          not(cameraBlock('isCameraRunning', { CAMERA_ID: text(cameraId) })),
          [
            setVariable(poseRefs.running, text('false')),
            setVariable(cameraShouldBeRunning, text('false')),
            cameraBlock('hideCameraPreview', { CAMERA_ID: text(cameraId) }),
            cameraBlock('stopSharedCamera', { CAMERA_ID: text(cameraId) }),
            block(`${shell}_showAppError`, {
              MESSAGE: text(
                '使用中のカメラが切断されました。再接続して選び直してください。',
              ),
              DETAILS: text('{"code":"CAMERA_TRACK_ENDED","cameraId":"pose"}'),
            }),
          ],
        ),
      ]),
    ]),
  ]),

  script({ x: 48, y: 360 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.chooseCamera },
    ),
    block(`${titleMenu}_clearAppMenuActions`),
    setVariable(cameraShouldBeRunning, text('false')),
    cameraBlock('hideCameraPreview', { CAMERA_ID: text(cameraId) }),
    cameraBlock('stopSharedCamera', { CAMERA_ID: text(cameraId) }),
    cameraBlock('startSharedCamera', {
      CAMERA_ID: text(cameraId),
      DEVICE_ID: text(''),
    }),
    ifElse(
      cameraBlock('isCameraRunning', { CAMERA_ID: text(cameraId) }),
      [
        setVariable(cameraShouldBeRunning, text('true')),
        cameraBlock('showCameraPreview', {
          CAMERA_ID: text(cameraId),
          PREVIEW_FLIP: text('horizontal'),
        }),
        cameraBlock('refreshCameraDevices'),
        broadcastMessageAndWait(menuActionsRequested),
        broadcastMessageAndWait(lensCalibrationRequested),
        block(`${titleMenu}_showMenu`),
      ],
      [
        cameraBlock('refreshCameraDevices'),
        broadcastMessageAndWait(menuActionsRequested),
        ...showCameraStartError(),
      ],
    ),
  ]),

  ...Array.from({ length: maximumMenuDevices }, (_, offset) => offset + 1).map(
    (index) =>
      script({ x: 520, y: 48 + (index - 1) * 280 }, [
        block(
          `${titleMenu}_whenAppMenuActionSelected`,
          {},
          { ACTION: cameraDeviceAction(index) },
        ),
        block(`${titleMenu}_clearAppMenuActions`),
        broadcastMessageAndWait(menuActionsRequested),
        setVariable(selectedDeviceIndex, number(index)),
        broadcastMessage(cameraDeviceSelected),
      ]),
  ),

  script({ x: 900, y: 48 }, [
    whenBroadcastReceived(cameraDeviceSelected),
    setVariable(cameraShouldBeRunning, text('false')),
    cameraBlock('hideCameraPreview', { CAMERA_ID: text(cameraId) }),
    cameraBlock('stopSharedCamera', { CAMERA_ID: text(cameraId) }),
    cameraBlock('startSharedCamera', {
      CAMERA_ID: text(cameraId),
      DEVICE_ID: cameraValue('cameraDeviceIdAt', {
        INDEX: variable(selectedDeviceIndex),
      }),
    }),
    ifElse(
      cameraBlock('isCameraRunning', { CAMERA_ID: text(cameraId) }),
      showPreview(),
      showCameraStartError(),
    ),
  ]),

  /**
   * The first step once a camera runs: make sure its lens is calibrated.
   *
   * A profile saved in this browser is used when it fits the camera as it is configured now, and the
   * operator is told which one. Anything short of `compatible` is not applied: a profile solved at a
   * different resolution or zoom produces plausible but wrong geometry rather than a visible error,
   * so the operator is sent to calibrate or to a file instead.
   */
  script({ x: 1400, y: 48 }, [
    whenBroadcastReceived(lensCalibrationRequested),
    setVariable(lensCalibrationReady, text('false')),
    cameraBlock('restoreStoredCameraProfile', { CAMERA_ID: text(cameraId) }),
    ifElse(
      equals(storedProfileResult(), text('restored')),
      [
        setVariable(lensCalibrationReady, text('true')),
        shellBlock('showAppNotice', {
          MESSAGE: label(
            'このPCに保存済みのレンズ校正を使います。',
            cameraBlock('storedCameraProfileDetail', {
              CAMERA_ID: text(cameraId),
            }),
          ),
        }),
      ],
      [
        ifElse(
          equals(storedProfileResult(), text('incompatible')),
          [
            shellBlock('showAppNotice', {
              MESSAGE: concatenate(
                text('保存済みのレンズ校正は今のカメラの設定と合いません（'),
                storedProfileDetail(),
                text(
                  '）。メニューから校正するか、校正ファイルを読んでください。',
                ),
              ),
            }),
          ],
          [
            ifElse(
              equals(storedProfileResult(), text('unavailable')),
              [
                shellBlock('showAppNotice', {
                  MESSAGE: text(
                    'このブラウザでは校正の保存領域を使えません。メニューから校正するか、校正ファイルを読んでください。',
                  ),
                }),
              ],
              [
                shellBlock('showAppNotice', {
                  MESSAGE: text(
                    'このカメラのレンズ校正がまだありません。メニューの「レンズ校正アプリで校正する」か「レンズ校正ファイルを読む」を選んでください。',
                  ),
                }),
              ],
            ),
          ],
        ),
      ],
    ),
  ]),

  /**
   * Opens the lens calibration app beside this one and waits for it to hand a profile back.
   *
   * The camera is released first so the calibration window can open the same device. The wait ends
   * when the calibration app saves a profile to browser storage — which every window on this origin
   * sees — or when the operator closes the window without one.
   */
  script({ x: 1400, y: 1000 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.openLensCalibration },
    ),
    block(`${titleMenu}_clearAppMenuActions`),
    broadcastMessageAndWait(menuActionsRequested),
    ifElse(
      not(cameraBlock('isCameraRunning', { CAMERA_ID: text(cameraId) })),
      [showCameraNotRunningError()],
      [
        setVariable(
          lensCalibrationDeviceId,
          cameraValue('cameraDeviceIdReporter', { CAMERA_ID: text(cameraId) }),
        ),
        setVariable(
          storedProfilesGenerationBefore,
          cameraValue('storedCameraProfilesGeneration'),
        ),
        setVariable(cameraShouldBeRunning, text('false')),
        cameraBlock('hideCameraPreview', { CAMERA_ID: text(cameraId) }),
        cameraBlock('stopSharedCamera', { CAMERA_ID: text(cameraId) }),
        shellBlock('openLensCalibrationApp'),
        ifElse(
          equals(shellValue('lensCalibrationAppState'), text('open')),
          [
            shellBlock('showAppNotice', {
              MESSAGE: text(
                '別ウィンドウのレンズ校正アプリで校正してください。校正が保存されるか、そのウィンドウを閉じると、ここへ戻ります。',
              ),
            }),
            waitUntil(
              or(
                greaterThan(
                  cameraValue('storedCameraProfilesGeneration'),
                  variable(storedProfilesGenerationBefore),
                ),
                not(shellBlock('lensCalibrationAppOpen')),
              ),
            ),
            ...resumeCameraAfterLensCalibration(),
          ],
          [
            ...resumeCameraAfterLensCalibration(),
            ifElse(
              equals(shellValue('lensCalibrationAppState'), text('blocked')),
              [
                shellBlock('showAppError', {
                  MESSAGE: text(
                    'ブラウザがレンズ校正アプリのウィンドウを開けませんでした。このページのポップアップを許可して、もう一度選んでください。',
                  ),
                  DETAILS: text('{"code":"LENS_CALIBRATION_WINDOW_BLOCKED"}'),
                }),
              ],
              [
                shellBlock('showAppError', {
                  MESSAGE: text(
                    'この起動方法ではレンズ校正アプリを開けません。会場用アプリから起動するか、「レンズ校正ファイルを読む」を選んでください。',
                  ),
                  DETAILS: text('{"code":"LENS_CALIBRATION_APP_UNAVAILABLE"}'),
                }),
              ],
            ),
          ],
        ),
      ],
    ),
    block(`${titleMenu}_showMenu`),
  ]),

  /**
   * Takes a profile from a file, uses it only if it fits the running camera, and keeps it for next
   * time.
   *
   * A file that fails validation leaves whatever profile was in force untouched. A file that is valid
   * but does not fit replaces it and is then withdrawn, so nothing that does not fit stays registered.
   */
  script({ x: 1400, y: 2200 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.loadLensCalibrationFile },
    ),
    block(`${titleMenu}_clearAppMenuActions`),
    broadcastMessageAndWait(menuActionsRequested),
    ifElse(
      not(cameraBlock('isCameraRunning', { CAMERA_ID: text(cameraId) })),
      [showCameraNotRunningError()],
      [
        shellBlock('chooseLensCalibrationFile'),
        ifElse(
          equals(shellValue('chosenLensCalibrationFile'), text('')),
          [
            shellBlock('showAppNotice', {
              MESSAGE: text('レンズ校正ファイルの読込みをやめました。'),
            }),
          ],
          [
            cameraBlock('registerCameraProfileAs', {
              PROFILE_JSON: shellValue('chosenLensCalibrationFile'),
              CAMERA_ID: text(cameraId),
            }),
            ifElse(
              not(equals(cameraValue('cameraProfileError'), text(''))),
              [
                shellBlock('showAppError', {
                  MESSAGE: label(
                    'レンズ校正ファイルを読めませんでした。',
                    cameraBlock('cameraProfileErrorDetail'),
                  ),
                  DETAILS: text(
                    '{"code":"LENS_PROFILE_INVALID","cameraId":"pose"}',
                  ),
                }),
              ],
              [
                ifElse(
                  equals(
                    cameraValue('cameraProfileCompatibility', {
                      CAMERA_ID: text(cameraId),
                    }),
                    text('compatible'),
                  ),
                  [
                    setVariable(lensCalibrationReady, text('true')),
                    cameraBlock('saveCameraProfile', {
                      CAMERA_ID: text(cameraId),
                    }),
                    ifElse(
                      equals(storedProfileResult(), text('saved')),
                      [
                        shellBlock('showAppNotice', {
                          MESSAGE: text(
                            'レンズ校正ファイルを使います。このPCに保存したので、次回からは読み込みを省けます。',
                          ),
                        }),
                      ],
                      [
                        shellBlock('showAppNotice', {
                          MESSAGE: text(
                            'レンズ校正ファイルを使います。ブラウザに保存できなかったため、次回も読み込みが必要です。',
                          ),
                        }),
                      ],
                    ),
                  ],
                  [
                    setVariable(lensCalibrationReady, text('false')),
                    setVariable(
                      lensProfileRejection,
                      cameraValue('cameraProfileCompatibilityDetail', {
                        CAMERA_ID: text(cameraId),
                      }),
                    ),
                    cameraBlock('forgetCameraProfile', {
                      CAMERA_ID: text(cameraId),
                    }),
                    shellBlock('showAppError', {
                      MESSAGE: concatenate(
                        text(
                          'このレンズ校正ファイルは今のカメラの設定と合わないため使いません。',
                        ),
                        variable(lensProfileRejection),
                      ),
                      DETAILS: text(
                        '{"code":"LENS_PROFILE_INCOMPATIBLE","cameraId":"pose"}',
                      ),
                    }),
                  ],
                ),
              ],
            ),
          ],
        ),
      ],
    ),
    block(`${titleMenu}_showMenu`),
  ]),

  /**
   * M-07, camera side: read the fusion app's offer and answer it.
   *
   * The offer is read with the camera already chosen for pose, through the same shared camera, so
   * the operator aims it at the projection once. The answer is shown full screen until the fusion
   * app connects; the courier photographs each part with a phone and carries it there.
   */
  script({ x: 2000, y: 48 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.pairWithFusion },
    ),
    block(`${titleMenu}_clearAppMenuActions`),
    broadcastMessageAndWait(menuActionsRequested),
    ifElse(
      not(pairing.featureEnabled()),
      [
        pairing.error(
          text('この配布物ではQRペアリングが無効です。'),
          'PAIRING_DISABLED',
        ),
      ],
      [
        ifElse(
          not(cameraBlock('isCameraRunning', { CAMERA_ID: text(cameraId) })),
          [
            pairing.error(
              text(
                '先に「カメラを選ぶ」で、統合アプリの投影を写すカメラを選んでください。',
              ),
              'CAMERA_NOT_RUNNING',
            ),
          ],
          [
            pairing.pairing('cancelPairing'),
            pairing.resetLinkTest(),
            pairing.pairing('startAnswerPairing', { LOCAL_PEER: text('') }),
            pairing.pairing('setPairingTimeout', { SECONDS: number(600) }),
            pairing.notice(
              text(
                '統合アプリが投影しているOfferのQRコードを、このカメラに写してください。複数枚のときは全部を写します。',
              ),
            ),
            block(`${titleMenu}_showMenu`),
            pairing.pairing('scanPairingQrFromCamera', {
              CAMERA_ID: text(cameraId),
            }),
            waitUntil(
              or(
                pairing.phaseIs('answer-ready'),
                or(pairing.ended(), pairing.pairing('isPairingConnected')),
              ),
            ),
            ifElse(
              pairing.ended(),
              [pairing.reportEnded()],
              [
                ...pairing.presentParts(
                  'Answer',
                  'スマートフォンで撮影して、統合アプリへ運んでください',
                  [pairingButtons.next, pairingButtons.cancel],
                  pairing.pairing('isPairingConnected'),
                ),
                ifElse(
                  pairing.pairing('isPairingConnected'),
                  [
                    pairing.pairing('endPairingQrDisplay'),
                    ...pairing.exchangeTestMessage('camera-app'),
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
    block(`${titleMenu}_showMenu`),
  ]),

  script({ x: 2000, y: 1400 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.cancelPairing },
    ),
    block(`${titleMenu}_clearAppMenuActions`),
    broadcastMessageAndWait(menuActionsRequested),
    ...pairing.cancel(),
    block(`${titleMenu}_showMenu`),
  ]),

  script({ x: 48, y: 760 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.stopCamera },
    ),
    block(`${titleMenu}_clearAppMenuActions`),
    broadcastMessageAndWait(menuActionsRequested),
    setVariable(poseRefs.running, text('false')),
    setVariable(cameraShouldBeRunning, text('false')),
    cameraBlock('hideCameraPreview', { CAMERA_ID: text(cameraId) }),
    cameraBlock('stopSharedCamera', { CAMERA_ID: text(cameraId) }),
    block(`${shell}_showAppNotice`, { MESSAGE: text('カメラを止めました。') }),
  ]),

  script({ x: 48, y: 960 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.diagnostics },
    ),
    block(`${titleMenu}_clearAppMenuActions`),
    broadcastMessageAndWait(menuActionsRequested),
    ifElse(
      not(block(`${shell}_webGpuAvailable`)),
      [
        block(`${shell}_showAppError`, {
          MESSAGE: text('WebGPU: 利用不可'),
          DETAILS: text('{"code":"WEBGPU_UNAVAILABLE"}'),
        }),
      ],
      [
        ifElse(
          cameraBlock('isCameraRunning', { CAMERA_ID: text(cameraId) }),
          [block(`${shell}_showAppNotice`, { MESSAGE: activeCameraSummary() })],
          [
            block(`${shell}_showAppNotice`, {
              MESSAGE: text('WebGPU: 利用可能 / カメラ: 停止中'),
            }),
          ],
        ),
      ],
    ),
  ]),

  script({ x: 520, y: 2360 }, [
    whenBroadcastReceived(menuActionsRequested),
    ...cameraDeviceMenuActions(),
    ...baseMenuActions('カメラを探し直す'),
  ]),

  /**
   * DEBUG_POSE_REPLAY: record the poses this camera sends, with the calibration behind them.
   *
   * The configuration a recording carries names this app and its reference; the camera's own model
   * and placement observation travel in the space-time result, which is recorded when the fusion app
   * calibrates. That is what a replay needs to stand in for this camera.
   */
  script({ x: 5200, y: 48 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.startRecording },
    ),
    // Both limits are the operator's: 0 records every frame, until they stop it.
    shellBlock('askNumbers', {
      TITLE: text(
        '録画の長さ（秒）と、1秒あたりに記録するフレーム数（fps）を入力してください。0を入れると、その制限をかけません。',
      ),
      FIELDS: text('長さ (秒),fps'),
      DEFAULTS: text('0,0'),
    }),
    shellBlock('startPoseRecording', {
      CONFIGURATION_JSON: text(
        JSON.stringify({
          implementation: 'fusion-v0',
          referenceId: 'venue-projection',
          cameras: [],
        }),
      ),
      SECONDS: shellValueWith('answeredNumberAt', { INDEX: number(1) }),
      FPS: shellValueWith('answeredNumberAt', { INDEX: number(2) }),
    }),
    ifElse(
      equals(shellValue('poseRecordingState'), text('recording')),
      [
        block(`${shell}_showAppNotice`, {
          MESSAGE: text(
            'ポーズの録画を始めました。「姿勢推定を始める」で送っているフレームと、空間と時刻の測定結果を記録します。',
          ),
        }),
      ],
      [
        block(`${shell}_showAppError`, {
          MESSAGE: concatenate(
            text('録画を始められませんでした: '),
            shellValue('poseReplayError'),
          ),
          DETAILS: text(JSON.stringify({ code: 'RECORDING_FAILED' })),
        }),
      ],
    ),
    block(`${titleMenu}_showMenu`),
  ]),

  script({ x: 5200, y: 1200 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.stopRecording },
    ),
    shellBlock('stopPoseRecording'),
    ifElse(
      equals(shellValue('poseRecordingState'), text('recorded')),
      [
        shellBlock('askNumbers', {
          TITLE: text(
            '録画に付ける番号を入力してください。会場のPCに camera-app-<番号>.json として保存します。',
          ),
          FIELDS: text('番号'),
          DEFAULTS: text('1'),
        }),
        ifElse(
          equals(shellValue('answeredNumbers'), text('')),
          [
            block(`${shell}_showAppNotice`, {
              MESSAGE: text(
                '録画の保存をやめました。録画はこのページに残っています。',
              ),
            }),
          ],
          [
            shellBlock('saveRecording', {
              NAME: concatenate(
                text('camera-app-'),
                shellValue('answeredNumbers'),
              ),
            }),
            ifElse(
              equals(shellValue('poseReplayError'), text('')),
              [
                block(`${shell}_showAppNotice`, {
                  MESSAGE: concatenate(
                    text('録画を保存しました。'),
                    shellValue('poseRecordingSummary'),
                  ),
                }),
              ],
              [
                block(`${shell}_showAppError`, {
                  MESSAGE: concatenate(
                    text('録画を保存できませんでした: '),
                    shellValue('poseReplayError'),
                  ),
                  DETAILS: text(
                    JSON.stringify({ code: 'RECORDING_SAVE_FAILED' }),
                  ),
                }),
              ],
            ),
          ],
        ),
      ],
      [
        block(`${shell}_showAppNotice`, {
          MESSAGE: text(
            '保存できる録画がありません。「ポーズの録画を始める」から録ってください。',
          ),
        }),
      ],
    ),
    block(`${titleMenu}_showMenu`),
  ]),

  script({ x: 5200, y: 2400 }, [
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
        block(`${shell}_showAppNotice`, {
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
            block(`${shell}_showAppNotice`, {
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
        block(`${shell}_showAppNotice`, {
          MESSAGE: concatenate(
            text('読み込みました: '),
            shellValue('replaySummary'),
          ),
        }),
      ],
      [
        block(`${shell}_showAppError`, {
          MESSAGE: concatenate(
            text('録画を読み込めませんでした: '),
            shellValue('poseReplayError'),
          ),
          DETAILS: text(JSON.stringify({ code: 'RECORDING_LOAD_FAILED' })),
        }),
      ],
    ),
    block(`${titleMenu}_showMenu`),
  ]),

  /**
   * Sends a recording to the fusion app as this camera, with no camera open.
   *
   * The pairing is real: the fusion app sees an ordinary camera app on the other end of the WebRTC
   * connection, and the calibration request is answered from the recording. Only the camera is absent.
   */
  script({ x: 5200, y: 3600 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.startReplay },
    ),
    setVariable(poseRefs.peer, pairing.pairingValue('pairingRemotePeer')),
    setVariable(poseRefs.localPeer, pairing.pairingValue('pairingLocalPeer')),
    ifElse(
      equals(variable(replayRunning), text('true')),
      [
        block(`${shell}_showAppNotice`, {
          MESSAGE: text('録画はすでに再生しています。'),
        }),
      ],
      [
        ifElse(
          equals(
            shellValue('replaySummary'),
            text('録画を読み込んでいません。'),
          ),
          [
            block(`${shell}_showAppError`, {
              MESSAGE: text('先に「録画を読み込む」で録画を選んでください。'),
              DETAILS: text(JSON.stringify({ code: 'REPLAY_NOT_LOADED' })),
            }),
          ],
          [
            ifElse(
              or(
                equals(variable(poseRefs.peer), text('')),
                not(
                  equals(
                    reporter(
                      block(`kubohiroyawebrtc_connectionState`, {
                        PEER: variable(poseRefs.peer),
                      }),
                    ),
                    text('connected'),
                  ),
                ),
              ),
              [
                block(`${shell}_showAppError`, {
                  MESSAGE: text(
                    '統合アプリと接続していないため、再生を始めません。先に「統合アプリと接続する」を選んでください。',
                  ),
                  DETAILS: text(
                    JSON.stringify({ code: 'REPLAY_NOT_CONNECTED' }),
                  ),
                }),
              ],
              [
                setVariable(replayRunning, text('true')),
                setVariable(replayFrames, number(0)),
                shellBlock('startPoseReplay'),
                block(`${shell}_showAppNotice`, {
                  MESSAGE: concatenate(
                    text('録画を再生して統合アプリへ送っています: '),
                    shellValue('replaySummary'),
                  ),
                }),
                block(`${titleMenu}_showMenu`),
                setVariable(
                  replayWindowStart,
                  reporter(block('sensing_timer')),
                ),
                repeatUntil(
                  or(
                    not(equals(variable(replayRunning), text('true'))),
                    not(equals(shellValue('replayState'), text('playing'))),
                  ),
                  [
                    setVariable(
                      replayFrame,
                      shellValueWith('replayPoseFrame', {
                        CAMERA_ID: variable(poseRefs.localPeer),
                      }),
                    ),
                    ifThen(not(equals(variable(replayFrame), text(''))), [
                      block(`kubohiroyawebrtc_sendLatestData`, {
                        PAYLOAD: variable(replayFrame),
                        CHANNEL: text(poseChannel),
                        PEER: variable(poseRefs.peer),
                      }),
                      changeVariable(replayFrames, 1),
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
                        block(`${shell}_showAppNotice`, {
                          MESSAGE: concatenate(
                            text('再生 '),
                            shellValue('replayPositionMs'),
                            text(' / '),
                            shellValue('replayDurationMs'),
                            text(' ms / 送信: '),
                            variable(replayFrames),
                            text(' 件'),
                          ),
                        }),
                        setVariable(
                          replayWindowStart,
                          reporter(block('sensing_timer')),
                        ),
                      ],
                    ),
                  ],
                ),
                setVariable(replayRunning, text('false')),
                block(`${shell}_showAppNotice`, {
                  MESSAGE: concatenate(
                    text('録画の再生が終わりました。送信: '),
                    variable(replayFrames),
                    text(' 件'),
                  ),
                }),
              ],
            ),
          ],
        ),
      ],
    ),
    block(`${titleMenu}_showMenu`),
  ]),

  script({ x: 5200, y: 7200 }, [
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
        block(`${shell}_showAppNotice`, {
          MESSAGE: text('再生を止めました。'),
        }),
      ],
      [
        block(`${shell}_showAppNotice`, {
          MESSAGE: text('録画を再生していません。'),
        }),
      ],
    ),
    block(`${titleMenu}_showMenu`),
  ]),
];

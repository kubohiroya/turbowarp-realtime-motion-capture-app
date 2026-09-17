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
  addToList,
  and,
  broadcastMessageAndWait,
  changeVariable,
  deleteAllOfList,
  equals,
  greaterThan,
  ifElse,
  ifThen,
  itemOfList,
  join,
  label,
  lengthOfList,
  modulo,
  add,
  not,
  or,
  repeat,
  repeatUntil,
  setVariable,
  waitUntil,
  whenBroadcastReceived,
  whenFlagClicked,
} from '../../packages/sb3-script/src/standard.ts';
import {
  fusionSyncLists,
  fusionSyncReferences,
  fusionSyncVariables,
  measureSeconds,
  measureSpaceTimeSteps,
  patternProfileId,
  referenceId,
  spaceTimeSolveSteps,
  timeSpaceSync,
} from './space-time.ts';
import {
  configurePose3dServiceSteps,
  external3dServiceFlag,
  pose3dService,
  pose3dStatusText,
} from './pose-3d.ts';

/** The application flag that turns recording and replay on. Off in a venue build. */
const replayFlag = 'debugPoseReplayV1';

/**
 * The standalone app (#36): run several USB cameras on one PC, measure them, and calibrate each lens.
 *
 * Stage 1: each camera gets a stable ID (`cam-1`…) bound to the USB device the operator chose, and the
 * binding is remembered in this browser so the same arrangement can be started again. Every camera is
 * asked for the same size and frame rate, and the app shows what each one was configured to and how
 * many frames it actually delivers — the figure a shared USB controller limits.
 *
 * Stage 2: every camera has its own lens calibration. Two cameras of the same model report the same
 * label and conditions, so a saved calibration is only ever restored from those solved on the device
 * the camera runs on, and the calibration app is opened for that device at the size the camera runs.
 *
 * Stage 3: every running camera's 2D pose is estimated in one page. Each camera has its own MoveNet
 * pipeline and they take turns on the one GPU; a camera with no new frame gives its turn away. Each
 * frame carries the capture time Camera Source reports, and the app shows what a turn costs: the
 * inference time and rate per camera, the delay from capture to result, the spread of the cameras'
 * capture times, and how long a round of every camera takes.
 *
 * Stage 4: time correspondence and placement are calibrated in this page. The page shows the time
 * pattern — on the monitor or projector the cameras look at — and each camera is measured against it in
 * turn: the pattern's decoded time gives how much later that camera stamps a frame than the pattern was
 * drawn, and the pattern's four corners give a placement observation. The operator enters the corners'
 * measured positions, the cameras are placed, and the page says READY only when every figure clears
 * the same thresholds as the camera and fusion apps (M-08). The measurement and the solve are the
 * steps those apps use.
 *
 * Stage 5: the 2D poses go to the 3D pose service (#34) from the same loop that estimates them. The
 * service is configured from the stage-4 calibration — each camera's model, placement and time
 * correspondence — exactly as the fusion app configures it from its camera apps, and each round asks
 * for the current 3D frame. Stage 1 of #34 has only stub implementations, so this is behind the same
 * `external3dServiceV1` flag as in the fusion app and every figure names the implementation.
 *
 * DEBUG_POSE_REPLAY: with `debugPoseReplayV1`, the 2D poses estimated from the cameras can be
 * recorded to a file, with the calibration they were estimated under, and played back later with no
 * camera running at all. Everything after the camera — the 3D service here, and the camera and fusion
 * apps elsewhere — then runs against the same movement as often as it needs to.
 */

const shell = 'realtimemotioncapturelocalshell';
const titleMenu = 'kubohiroyaturbowarptitlemenu';
const cameraSource = 'kubohiroyacamerasource';
const motionCapture = 'kubohiroyarealtimemotioncapture';
/** Frames estimated here are not sent anywhere; the peer names this page. */
const localPeerId = 'local';

/** Stage 1 offers at most this many cameras. The measured limit is what stage 1 is for. */
export const maximumCameras = 4;
const maximumMenuDevices = 8;
/** A camera the operator never chose, opened only so the browser grants device labels. */
const probeCameraId = 'probe';

const presets = [
  { width: 640, height: 480, frameRate: 30 },
  { width: 1280, height: 720, frameRate: 30 },
  { width: 1920, height: 1080, frameRate: 30 },
] as const;

const action = {
  findCameras: 'findCameras',
  restoreCameras: 'restoreCameras',
  cycleResolution: 'cycleResolution',
  stopCameras: 'stopCameras',
  diagnostics: 'diagnostics',
  startPose: 'startPose',
  stopPose: 'stopPose',
  calibrateSpaceTime: 'calibrateSpaceTime',
  start3d: 'start3d',
  stop3d: 'stop3d',
  startRecording: 'startRecording',
  stopRecording: 'stopRecording',
  chooseRecording: 'chooseRecording',
  startReplay: 'startReplay',
  stopReplay: 'stopReplay',
} as const;
const deviceAction = (index: number) => `addDevice${index}`;
const calibrateLensAction = (index: number) => `calibrateLens${index}`;
const loadLensFileAction = (index: number) => `loadLensFile${index}`;

const cameraCount = namedReference('camera count', 'variable:camera-count');
const cameraBindings = namedReference(
  'camera bindings',
  'variable:camera-bindings',
);
const preset = namedReference(
  'resolution preset',
  'variable:resolution-preset',
);
const slot = namedReference('camera slot', 'variable:camera-slot');
const slotDevice = namedReference(
  'camera slot device',
  'variable:camera-slot-device',
);
const failures = namedReference('camera failures', 'variable:camera-failures');
const requestWidth = namedReference(
  'requested width',
  'variable:requested-width',
);
const requestHeight = namedReference(
  'requested height',
  'variable:requested-height',
);
const requestFps = namedReference('requested fps', 'variable:requested-fps');
const lensSummary = namedReference('lens summary', 'variable:lens-summary');
const lensRejection = namedReference(
  'lens rejection',
  'variable:lens-rejection',
);
/** The stored-profile generation when a calibration window opened; a larger one means it saved. */
/** `true` while the pose loop runs; setting it `false` asks the loop to stop. */
const poseRunning = namedReference('pose running', 'variable:pose-running');
/** `true` once the loop has stopped and released every pipeline. */
const poseStopped = namedReference('pose stopped', 'variable:pose-stopped');
const poseCalibration = namedReference(
  'pose calibration ID',
  'variable:pose-calibration-id',
);
const poseWindowStart = namedReference(
  'pose window start',
  'variable:pose-window-start',
);
const spaceTime = fusionSyncReferences();
const spaceTimeMeasurement = namedReference(
  'space-time measurement',
  'variable:space-time-measurement',
);
const spaceTimeDelays = namedReference(
  'space-time delays',
  'variable:space-time-delays',
);
/** `true` while each pose round is also forwarded to the 3D service. */
const pose3dEnabled = namedReference('3D enabled', 'variable:3d-enabled');
const replayCamera = namedReference('replay camera', 'variable:replay-camera');
const replayIndex = namedReference('replay index', 'variable:replay-index');
const replayFrame = namedReference('replay frame', 'variable:replay-frame');
const replayWindowStart = namedReference(
  'replay window start',
  'variable:replay-window-start',
);
const profilesGenerationBefore = namedReference(
  'stored profiles generation before',
  'variable:stored-profiles-generation-before',
);
const menuActionsRequested = namedReference(
  'menu actions requested',
  'broadcast:menu-actions-requested',
);
const camerasChanged = namedReference(
  'cameras changed',
  'broadcast:cameras-changed',
);

export const localAppStageData = {
  variables: {
    [cameraCount.id]: [cameraCount.name, 0],
    [cameraBindings.id]: [cameraBindings.name, '{}'],
    [preset.id]: [preset.name, 2],
    [slot.id]: [slot.name, 0],
    [slotDevice.id]: [slotDevice.name, ''],
    [failures.id]: [failures.name, ''],
    [requestWidth.id]: [requestWidth.name, presets[1].width],
    [requestHeight.id]: [requestHeight.name, presets[1].height],
    [requestFps.id]: [requestFps.name, presets[1].frameRate],
    [lensSummary.id]: [lensSummary.name, ''],
    [lensRejection.id]: [lensRejection.name, ''],
    [profilesGenerationBefore.id]: [profilesGenerationBefore.name, 0],
    [poseRunning.id]: [poseRunning.name, 'false'],
    [poseStopped.id]: [poseStopped.name, 'true'],
    [poseCalibration.id]: [poseCalibration.name, ''],
    [poseWindowStart.id]: [poseWindowStart.name, 0],
    ...fusionSyncVariables(spaceTime),
    [spaceTimeMeasurement.id]: [spaceTimeMeasurement.name, ''],
    [spaceTimeDelays.id]: [spaceTimeDelays.name, ''],
    [pose3dEnabled.id]: [pose3dEnabled.name, 'false'],
    [replayCamera.id]: [replayCamera.name, ''],
    [replayIndex.id]: [replayIndex.name, 0],
    [replayFrame.id]: [replayFrame.name, ''],
    [replayWindowStart.id]: [replayWindowStart.name, 0],
  },
  lists: fusionSyncLists(spaceTime),
  broadcasts: {
    [menuActionsRequested.id]: menuActionsRequested.name,
    [camerasChanged.id]: camerasChanged.name,
  },
} as const;

const concatenate = (
  first: InputValue,
  ...rest: readonly InputValue[]
): InputValue =>
  rest.reduce((left, right) => reporter(join(left, right)), first);
const shellBlock = (
  opcode: string,
  inputs: Readonly<Record<string, InputValue>> = {},
) => block(`${shell}_${opcode}`, inputs);
const shellValue = (
  opcode: string,
  inputs: Readonly<Record<string, InputValue>> = {},
) => reporter(shellBlock(opcode, inputs));
const sourceBlock = (
  opcode: string,
  inputs: Readonly<Record<string, InputValue>> = {},
) => block(`${cameraSource}_${opcode}`, inputs);
const sourceValue = (
  opcode: string,
  inputs: Readonly<Record<string, InputValue>> = {},
) => reporter(sourceBlock(opcode, inputs));
const notice = (message: InputValue) =>
  shellBlock('showAppNotice', { MESSAGE: message });
const error = (message: InputValue, code: string) =>
  shellBlock('showAppError', {
    MESSAGE: message,
    DETAILS: text(JSON.stringify({ code })),
  });
const addMenu = (id: string, labelText: InputValue) =>
  block(`${titleMenu}_addAppMenuAction`, {
    ACTION: text(id),
    LABEL: labelText,
  });
const slotId = (): InputValue => reporter(join(text('cam-'), variable(slot)));

/** Copies the selected preset into the request variables every start reads. */
const applyPreset = (): BlockNode[] =>
  presets.map((entry, index) =>
    ifThen(equals(variable(preset), number(index + 1)), [
      setVariable(requestWidth, number(entry.width)),
      setVariable(requestHeight, number(entry.height)),
      setVariable(requestFps, number(entry.frameRate)),
    ]),
  );

const presetLabel = (): InputValue =>
  concatenate(
    variable(requestWidth),
    text('x'),
    variable(requestHeight),
    text(' '),
    variable(requestFps),
    text('fps'),
  );

/** Starts the camera in `slot` on `slotDevice` at the selected preset. */
const startSlot = (): BlockNode =>
  shellBlock('startGridCamera', {
    CAMERA_ID: slotId(),
    DEVICE_ID: variable(slotDevice),
    WIDTH: variable(requestWidth),
    HEIGHT: variable(requestHeight),
    FPS: variable(requestFps),
  });

const slotRunning = (): BlockNode =>
  equals(
    shellValue('gridCameraState', { CAMERA_ID: slotId() }),
    text('running'),
  );

const addFailure = (): BlockNode =>
  setVariable(
    failures,
    concatenate(
      variable(failures),
      slotId(),
      text(': '),
      shellValue('gridCameraError', { CAMERA_ID: slotId() }),
      text(' / '),
    ),
  );

/** Walks slots 1 to the maximum, with `slotDevice` read from the remembered bindings. */
const forEachBoundSlot = (body: BlockNode[]): BlockNode[] => [
  setVariable(slot, number(0)),
  repeat(maximumCameras, [
    changeVariable(slot, 1),
    setVariable(
      slotDevice,
      shellValue('jsonValueAt', {
        JSON: variable(cameraBindings),
        PATH: slotId(),
      }),
    ),
    ifThen(not(equals(variable(slotDevice), text(''))), body),
  ]),
];

const slotValue = (opcode: string): InputValue =>
  sourceValue(opcode, { CAMERA_ID: slotId() });

/**
 * Registers the slot's calibration from those saved for its device, at the size it runs now.
 *
 * Fails closed in Camera Source: nothing that does not fit is registered, and a profile already in
 * force stays unless a fitting one replaces it.
 */
const restoreSlotLens = (): BlockNode =>
  sourceBlock('restoreStoredCameraProfileForDevice', { CAMERA_ID: slotId() });

/** One word per camera. Calibrated means it fits the camera as it runs now and was solved on its device. */
const lensStateOfSlot = (): BlockNode[] => [
  ifElse(
    and(
      equals(slotValue('cameraProfileCompatibility'), text('compatible')),
      sourceBlock('cameraProfileOnDevice', { CAMERA_ID: slotId() }),
    ),
    [
      setVariable(
        lensSummary,
        concatenate(variable(lensSummary), slotId(), text(' 校正済み / ')),
      ),
    ],
    [
      ifElse(
        sourceBlock('cameraProfileRegistered', { CAMERA_ID: slotId() }),
        [
          setVariable(
            lensSummary,
            concatenate(variable(lensSummary), slotId(), text(' 合わない / ')),
          ),
        ],
        [
          ifElse(
            equals(slotValue('storedCameraProfileResult'), text('unavailable')),
            [
              setVariable(
                lensSummary,
                concatenate(
                  variable(lensSummary),
                  slotId(),
                  text(' 保存領域が使えない / '),
                ),
              ),
            ],
            [
              setVariable(
                lensSummary,
                concatenate(
                  variable(lensSummary),
                  slotId(),
                  text(' 未校正 / '),
                ),
              ),
            ],
          ),
        ],
      ),
    ],
  ),
];

const summaryNotice = (): BlockNode[] => [
  setVariable(lensSummary, text('')),
  ...forEachBoundSlot([ifThen(slotRunning(), lensStateOfSlot())]),
  ifElse(
    equals(shellValue('gridCamerasSummary'), text('')),
    [
      notice(
        text(
          '動いているカメラはありません。「カメラを探す」から追加してください。',
        ),
      ),
    ],
    [
      notice(
        concatenate(
          text('要求 '),
          presetLabel(),
          text(' — '),
          shellValue('gridCamerasSummary'),
          text(' — レンズ: '),
          variable(lensSummary),
        ),
      ),
    ],
  ),
];

const baseMenu = (): BlockNode[] => [
  block(`${titleMenu}_clearAppMenuActions`),
  addMenu(action.findCameras, text('カメラを探す')),
  addMenu(action.restoreCameras, text('前回のカメラ構成で始める')),
  addMenu(
    action.cycleResolution,
    concatenate(text('解像度を切り替える（今: '), presetLabel(), text('）')),
  ),
  addMenu(action.stopCameras, text('すべてのカメラを止める')),
  addMenu(action.diagnostics, text('動作状況を見る')),
  addMenu(action.startPose, text('姿勢推定を始める')),
  addMenu(action.stopPose, text('姿勢推定を止める')),
  addMenu(action.calibrateSpaceTime, text('空間と時刻を校正する')),
  ifThen(
    shellBlock('appFeatureEnabled', { FEATURE: text(external3dServiceFlag) }),
    [
      addMenu(action.start3d, text('3D推定を始める')),
      addMenu(action.stop3d, text('3D推定を止める')),
    ],
  ),
  ifThen(shellBlock('appFeatureEnabled', { FEATURE: text(replayFlag) }), [
    addMenu(action.startRecording, text('ポーズの録画を始める')),
    addMenu(action.stopRecording, text('ポーズの録画を止めて保存する')),
    addMenu(action.chooseRecording, text('録画を読み込む')),
    addMenu(action.startReplay, text('録画を再生する（カメラ不要）')),
    addMenu(action.stopReplay, text('再生を止める')),
  ]),
];

const serviceBlock = (
  opcode: string,
  inputs: Readonly<Record<string, InputValue>> = {},
) => block(`${pose3dService}_${opcode}`, inputs);

const poseValue = (opcode: string): InputValue =>
  reporter(block(`${motionCapture}_${opcode}`, { CAMERA_ID: slotId() }));

/**
 * Stops the pose loop and waits until it has released every pipeline.
 *
 * Everything that restarts or releases a camera goes through this first. A pose pipeline holds its own
 * Camera Source lease, so a camera restarted at another size under it would keep the stream it had.
 */
const stopPoseAndWait = (): BlockNode[] => [
  ifThen(equals(variable(poseRunning), text('true')), [
    setVariable(poseRunning, text('false')),
    waitUntil(equals(variable(poseStopped), text('true'))),
    notice(
      text(
        'カメラを変更するため、姿勢推定を止めました。変更が済んだら「姿勢推定を始める」を選んでください。',
      ),
    ),
  ]),
  ...invalidateCalibration(),
];

/**
 * A changed camera — restarted, at another size, or with another lens calibration — no longer matches
 * the placement solved for it, so READY is withdrawn and the 3D service, configured from it, stops.
 */
const invalidateCalibration = (): BlockNode[] => [
  setVariable(spaceTime.ready, text('false')),
  ifThen(equals(variable(pose3dEnabled), text('true')), [
    setVariable(pose3dEnabled, text('false')),
    serviceBlock('stopService'),
  ]),
];

/**
 * The calibration a camera's frames are estimated against: the registered profile when it fits the
 * camera as it runs and was solved on its device, otherwise `uncalibrated`, which the 3D stage refuses.
 */
const setPoseCalibration = (): BlockNode =>
  ifElse(
    and(
      equals(slotValue('cameraProfileCompatibility'), text('compatible')),
      sourceBlock('cameraProfileOnDevice', { CAMERA_ID: slotId() }),
    ),
    [
      setVariable(
        poseCalibration,
        shellValue('jsonValueAt', {
          JSON: slotValue('cameraProfileJson'),
          PATH: text('profileId'),
        }),
      ),
    ],
    [setVariable(poseCalibration, text('uncalibrated'))],
  );

/** Calibration entries for the cameras that are running; a stopped camera has no device to calibrate. */
const lensMenu = (): BlockNode[] =>
  Array.from({ length: maximumCameras }, (_, offset) => offset + 1).map(
    (index) =>
      ifThen(
        equals(
          shellValue('gridCameraState', { CAMERA_ID: text(`cam-${index}`) }),
          text('running'),
        ),
        [
          addMenu(
            calibrateLensAction(index),
            text(`cam-${index} のレンズを校正する`),
          ),
          addMenu(
            loadLensFileAction(index),
            text(`cam-${index} のレンズ校正ファイルを読む`),
          ),
        ],
      ),
  );

const deviceMenu = (): BlockNode[] =>
  Array.from({ length: maximumMenuDevices }, (_, offset) => offset + 1).map(
    (index) =>
      ifThen(greaterThan(sourceValue('cameraDeviceCount'), number(index - 1)), [
        addMenu(
          deviceAction(index),
          label(
            `追加 ${index}: `,
            sourceBlock('cameraDeviceLabelAt', { INDEX: number(index) }),
          ),
        ),
      ]),
  );

const slotNotRunningError = (): BlockNode =>
  error(
    concatenate(
      slotId(),
      text('は動いていません。先にカメラを開始してください。'),
    ),
    'CAMERA_NOT_RUNNING',
  );

export const localAppScripts: readonly Script[] = [
  script({ x: 48, y: 48 }, [
    whenFlagClicked(),
    shellBlock('showAppLoading', {
      LABEL: text('ローカルアプリを起動しています'),
    }),
    setVariable(cameraCount, number(0)),
    setVariable(cameraBindings, text('{}')),
    ...applyPreset(),
    ...baseMenu(),
    shellBlock('hideAppLoading'),
    block(`${titleMenu}_showMenu`),
    notice(
      text(
        'USBカメラをつないでから「カメラを探す」を選んでください。前回と同じ構成なら「前回のカメラ構成で始める」を選べます。',
      ),
    ),
  ]),

  script({ x: 48, y: 420 }, [
    whenBroadcastReceived(menuActionsRequested),
    ...baseMenu(),
    ...lensMenu(),
    ...deviceMenu(),
  ]),

  /** Labels are only visible once a camera has been granted, so one is opened and closed first. */
  script({ x: 48, y: 760 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.findCameras },
    ),
    sourceBlock('startSharedCamera', {
      CAMERA_ID: text(probeCameraId),
      DEVICE_ID: text(''),
    }),
    sourceBlock('stopSharedCamera', { CAMERA_ID: text(probeCameraId) }),
    sourceBlock('refreshCameraDevices'),
    broadcastMessageAndWait(menuActionsRequested),
    ifElse(
      equals(sourceValue('cameraDeviceCount'), number(0)),
      [
        error(
          text(
            'カメラが見つかりません。USBカメラの接続とブラウザのカメラ許可を確認してください。',
          ),
          'CAMERA_NOT_FOUND',
        ),
      ],
      [
        notice(
          concatenate(
            sourceValue('cameraDeviceCount'),
            text(
              '台のカメラが見つかりました。メニューの「追加 n」で、使うカメラを順に追加してください。',
            ),
          ),
        ),
      ],
    ),
    block(`${titleMenu}_showMenu`),
  ]),

  ...Array.from({ length: maximumMenuDevices }, (_, offset) => offset + 1).map(
    (index) =>
      script({ x: 520, y: 48 + (index - 1) * 420 }, [
        block(
          `${titleMenu}_whenAppMenuActionSelected`,
          {},
          { ACTION: deviceAction(index) },
        ),
        ...stopPoseAndWait(),
        ifElse(
          greaterThan(variable(cameraCount), number(maximumCameras - 1)),
          [
            error(
              text(`カメラは${maximumCameras}台までです。`),
              'CAMERA_LIMIT',
            ),
          ],
          [
            setVariable(slot, reporter(add(variable(cameraCount), number(1)))),
            setVariable(
              slotDevice,
              sourceValue('cameraDeviceIdAt', { INDEX: number(index) }),
            ),
            startSlot(),
            ifElse(
              slotRunning(),
              [
                setVariable(cameraCount, variable(slot)),
                restoreSlotLens(),
                setVariable(
                  cameraBindings,
                  shellValue('jsonWithTextField', {
                    JSON: variable(cameraBindings),
                    KEY: slotId(),
                    VALUE: variable(slotDevice),
                  }),
                ),
                shellBlock('rememberSetting', {
                  KEY: text('camera-bindings'),
                  VALUE: variable(cameraBindings),
                }),
                shellBlock('showCameraGrid'),
                broadcastMessageAndWait(camerasChanged),
              ],
              [
                error(
                  concatenate(
                    slotId(),
                    text('を開始できませんでした: '),
                    shellValue('gridCameraError', { CAMERA_ID: slotId() }),
                  ),
                  'CAMERA_START_FAILED',
                ),
              ],
            ),
          ],
        ),
        block(`${titleMenu}_showMenu`),
      ]),
  ),

  script({ x: 1000, y: 48 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.restoreCameras },
    ),
    ...stopPoseAndWait(),
    setVariable(
      cameraBindings,
      shellValue('rememberedSetting', { KEY: text('camera-bindings') }),
    ),
    ifElse(
      equals(variable(cameraBindings), text('')),
      [
        setVariable(cameraBindings, text('{}')),
        notice(
          text(
            'このブラウザには前回のカメラ構成がありません。「カメラを探す」から追加してください。',
          ),
        ),
      ],
      [
        shellBlock('stopAllGridCameras'),
        setVariable(cameraCount, number(0)),
        setVariable(failures, text('')),
        ...forEachBoundSlot([
          startSlot(),
          ifElse(
            slotRunning(),
            [setVariable(cameraCount, variable(slot)), restoreSlotLens()],
            [addFailure()],
          ),
        ]),
        shellBlock('showCameraGrid'),
        ifElse(
          equals(variable(failures), text('')),
          [broadcastMessageAndWait(camerasChanged)],
          [
            error(
              concatenate(
                text('前回の構成のうち、開始できなかったカメラがあります: '),
                variable(failures),
              ),
              'CAMERA_RESTORE_INCOMPLETE',
            ),
          ],
        ),
      ],
    ),
    block(`${titleMenu}_showMenu`),
  ]),

  /** Every running camera is restarted at the next preset, so all of them are measured alike. */
  script({ x: 1000, y: 900 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.cycleResolution },
    ),
    ...stopPoseAndWait(),
    setVariable(
      preset,
      reporter(
        add(
          reporter(modulo(variable(preset), number(presets.length))),
          number(1),
        ),
      ),
    ),
    ...applyPreset(),
    setVariable(failures, text('')),
    ...forEachBoundSlot([
      ifThen(slotRunning(), [
        startSlot(),
        ifElse(slotRunning(), [restoreSlotLens()], [addFailure()]),
      ]),
    ]),
    broadcastMessageAndWait(menuActionsRequested),
    ifElse(
      equals(variable(failures), text('')),
      [broadcastMessageAndWait(camerasChanged)],
      [
        error(
          concatenate(
            text('解像度を切り替えられなかったカメラがあります: '),
            variable(failures),
          ),
          'CAMERA_RESTART_FAILED',
        ),
      ],
    ),
    block(`${titleMenu}_showMenu`),
  ]),

  script({ x: 1000, y: 1500 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.stopCameras },
    ),
    ...stopPoseAndWait(),
    shellBlock('stopAllGridCameras'),
    setVariable(cameraCount, number(0)),
    notice(
      text(
        'すべてのカメラを止めました。カメラ構成はこのブラウザに残っています。',
      ),
    ),
    block(`${titleMenu}_showMenu`),
  ]),

  script({ x: 1000, y: 1800 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.diagnostics },
    ),
    ...summaryNotice(),
    block(`${titleMenu}_showMenu`),
  ]),

  /** The measured frame rate needs a window to fill before it means anything. */
  script({ x: 1500, y: 48 }, [
    whenBroadcastReceived(camerasChanged),
    broadcastMessageAndWait(menuActionsRequested),
    block('control_wait', { DURATION: number(1.5) }),
    ...summaryNotice(),
  ]),

  ...Array.from({ length: maximumCameras }, (_, offset) => offset + 1).flatMap(
    (index) => [calibrateLensScript(index), loadLensFileScript(index)],
  ),

  /**
   * Starts a pipeline for every running camera, then gives each one a turn until asked to stop.
   *
   * The model is loaded once per camera, which takes a while on the first start. After each turn the
   * camera's frame is drawn over its tile and its status goes to the measurement; the summary is shown
   * once a second.
   */
  script({ x: 2600, y: 48 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.startPose },
    ),
    ifElse(
      equals(variable(poseRunning), text('true')),
      [notice(text('姿勢推定はすでに動いています。'))],
      [
        ifElse(
          equals(shellValue('gridCamerasSummary'), text('')),
          [
            error(
              text(
                '動いているカメラがありません。先にカメラを開始してください。',
              ),
              'POSE_NO_CAMERA',
            ),
          ],
          [
            shellBlock('showAppLoading', {
              LABEL: text(
                '姿勢推定を準備しています（カメラごとにモデルを読み込みます）',
              ),
            }),
            setVariable(failures, text('')),
            ...forEachBoundSlot([
              ifThen(slotRunning(), [
                setPoseCalibration(),
                block(`${motionCapture}_startPoseCamera`, {
                  CAMERA_ID: slotId(),
                  PEER_ID: text(localPeerId),
                  CALIBRATION_ID: variable(poseCalibration),
                }),
                ifThen(
                  not(
                    equals(
                      shellValue('jsonValueAt', {
                        JSON: poseValue('poseCameraStatusJson'),
                        PATH: text('state'),
                      }),
                      text('ready'),
                    ),
                  ),
                  [
                    setVariable(
                      failures,
                      concatenate(
                        variable(failures),
                        slotId(),
                        text(': '),
                        shellValue('jsonValueAt', {
                          JSON: poseValue('poseCameraStatusJson'),
                          PATH: text('error'),
                        }),
                        text(' / '),
                      ),
                    ),
                  ],
                ),
              ]),
            ]),
            shellBlock('hideAppLoading'),
            ifElse(
              not(equals(variable(failures), text(''))),
              [
                block(`${motionCapture}_stopAllPoseCameras`),
                error(
                  concatenate(
                    text('姿勢推定を開始できませんでした: '),
                    variable(failures),
                  ),
                  'POSE_START_FAILED',
                ),
              ],
              [
                shellBlock('resetPoseMeasurement'),
                setVariable(poseStopped, text('false')),
                setVariable(poseRunning, text('true')),
                notice(
                  text('姿勢推定を始めました。1秒ごとに計測値を表示します。'),
                ),
                block(`${titleMenu}_showMenu`),
                setVariable(poseWindowStart, reporter(block('sensing_timer'))),
                repeatUntil(not(equals(variable(poseRunning), text('true'))), [
                  ...forEachBoundSlot([
                    ifThen(
                      and(
                        slotRunning(),
                        not(
                          equals(poseValue('poseCameraStatusJson'), text('')),
                        ),
                      ),
                      [
                        block(`${motionCapture}_inferPoseCameraAtFrameTime`, {
                          CAMERA_ID: slotId(),
                        }),
                        shellBlock('showGridPose', {
                          FRAME_JSON: poseValue('poseCameraFrame2D'),
                          CAMERA_ID: slotId(),
                        }),
                        shellBlock('recordPoseStatus', {
                          STATUS_JSON: poseValue('poseCameraStatusJson'),
                          CAMERA_ID: slotId(),
                        }),
                        ifThen(
                          equals(
                            shellValue('poseRecordingState'),
                            text('recording'),
                          ),
                          [
                            shellBlock('recordPoseFrame', {
                              FRAME_JSON: poseValue('poseCameraFrame2D'),
                              CAMERA_ID: slotId(),
                            }),
                          ],
                        ),
                        ifThen(equals(variable(pose3dEnabled), text('true')), [
                          serviceBlock('sendPoseFrame', {
                            FRAME_JSON: poseValue('poseCameraFrame2D'),
                            CAMERA_ID: slotId(),
                            AGE_MS: shellValue('poseFrameAgeMs', {
                              FRAME_JSON: poseValue('poseCameraFrame2D'),
                            }),
                          }),
                        ]),
                      ],
                    ),
                  ]),
                  shellBlock('endPoseRound'),
                  ifThen(equals(variable(pose3dEnabled), text('true')), [
                    serviceBlock('requestPose3d'),
                  ]),
                  ifThen(
                    greaterThan(
                      reporter(
                        block('operator_subtract', {
                          NUM1: reporter(block('sensing_timer')),
                          NUM2: variable(poseWindowStart),
                        }),
                      ),
                      number(1),
                    ),
                    [
                      ifElse(
                        equals(variable(pose3dEnabled), text('true')),
                        [
                          ifElse(
                            equals(
                              reporter(serviceBlock('serviceState')),
                              text('ready'),
                            ),
                            [
                              notice(
                                concatenate(
                                  pose3dStatusText(shell),
                                  text(' — 姿勢推定 '),
                                  shellValue('poseMeasurementSummary'),
                                ),
                              ),
                            ],
                            [
                              error(
                                concatenate(
                                  text('3D出力を停止中です（'),
                                  reporter(serviceBlock('serviceState')),
                                  text('）: '),
                                  reporter(serviceBlock('serviceError')),
                                  text(' — 姿勢推定 '),
                                  shellValue('poseMeasurementSummary'),
                                ),
                                'POSE_3D_WITHHELD',
                              ),
                            ],
                          ),
                        ],
                        [
                          notice(
                            concatenate(
                              text('姿勢推定 — '),
                              shellValue('poseMeasurementSummary'),
                            ),
                          ),
                        ],
                      ),
                      setVariable(
                        poseWindowStart,
                        reporter(block('sensing_timer')),
                      ),
                    ],
                  ),
                ]),
                block(`${motionCapture}_stopAllPoseCameras`),
                ...forEachBoundSlot([
                  shellBlock('showGridPose', {
                    FRAME_JSON: text(''),
                    CAMERA_ID: slotId(),
                  }),
                ]),
                setVariable(poseStopped, text('true')),
              ],
            ),
          ],
        ),
      ],
    ),
    block(`${titleMenu}_showMenu`),
  ]),

  /**
   * Shows the time pattern in this page and measures every running camera against it in turn, then
   * solves placement and judges READY.
   *
   * Only cameras whose lens calibration fits them as they run and was solved on their device are
   * measured; a camera without one is named and nothing is shown. The pattern flickers, so the operator
   * confirms before it appears. It stays up until the last camera has been measured.
   */
  script({ x: 3200, y: 48 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.calibrateSpaceTime },
    ),
    ...stopPoseAndWait(),
    setVariable(spaceTime.ready, text('false')),
    setVariable(failures, text('')),
    ...forEachBoundSlot([
      ifThen(slotRunning(), [
        ifThen(
          not(
            and(
              equals(
                slotValue('cameraProfileCompatibility'),
                text('compatible'),
              ),
              sourceBlock('cameraProfileOnDevice', { CAMERA_ID: slotId() }),
            ),
          ),
          [
            setVariable(
              failures,
              concatenate(variable(failures), slotId(), text(' / ')),
            ),
          ],
        ),
      ]),
    ]),
    ifElse(
      equals(shellValue('gridCamerasSummary'), text('')),
      [
        error(
          text('動いているカメラがありません。先にカメラを開始してください。'),
          'SPACE_TIME_NO_CAMERAS',
        ),
      ],
      [
        ifElse(
          not(equals(variable(failures), text(''))),
          [
            error(
              concatenate(
                text('レンズ校正が済んでいないカメラがあります: '),
                variable(failures),
                text('先に「cam-n のレンズを校正する」で校正してください。'),
              ),
              'SPACE_TIME_LENS_UNCALIBRATED',
            ),
          ],
          [
            shellBlock('askConfirmation', {
              MESSAGE: text(
                'これからこのページに時刻パターンを全画面で表示し、カメラを1台ずつ測ります。パターンは毎秒何十回も明滅します。光過敏の方が見ないよう知らせてから表示してください。すべてのカメラから、パターン全体が正立して見えるようにしてください。表示中はEscキーで消せます。',
              ),
              CONFIRM: text('表示する'),
              CANCEL: text('やめる'),
            }),
            ifElse(
              not(shellBlock('confirmationAccepted')),
              [notice(text('空間と時刻の校正をやめました。'))],
              [
                block(`${timeSpaceSync}_acknowledgePatternFlashing`),
                block(`${timeSpaceSync}_setTimePatternProfile`, {
                  PROFILE_ID: text(patternProfileId),
                }),
                block(`${timeSpaceSync}_showTimePattern`),
                setVariable(spaceTime.waited, number(0)),
                repeatUntil(
                  or(
                    block(`${timeSpaceSync}_timePatternStable`),
                    greaterThan(variable(spaceTime.waited), number(50)),
                  ),
                  [
                    block('control_wait', { DURATION: number(0.1) }),
                    changeVariable(spaceTime.waited, 1),
                  ],
                ),
                deleteAllOfList(spaceTime.results),
                setVariable(spaceTime.expected, number(0)),
                ...forEachBoundSlot([
                  ifThen(
                    and(
                      slotRunning(),
                      block(`${timeSpaceSync}_timePatternShown`),
                    ),
                    [
                      changeVariable(spaceTime.expected, 1),
                      notice(
                        concatenate(
                          slotId(),
                          text(
                            'で時刻パターンを測っています。カメラを動かさないでください。',
                          ),
                        ),
                      ),
                      ...measureSpaceTimeSteps({
                        shell,
                        cameraId: slotId(),
                        referenceId: text(referenceId),
                        refreshUs: reporter(
                          block(`${timeSpaceSync}_timePatternRefreshUs`),
                        ),
                        measureSeconds: number(measureSeconds),
                        result: spaceTimeMeasurement,
                      }),
                      addToList(
                        shellValue('jsonWithJsonField', {
                          JSON: shellValue('jsonWithTextField', {
                            JSON: text('{}'),
                            KEY: text('peer'),
                            VALUE: slotId(),
                          }),
                          KEY: text('payload'),
                          VALUE: variable(spaceTimeMeasurement),
                        }),
                        spaceTime.results,
                      ),
                    ],
                  ),
                ]),
                block(`${timeSpaceSync}_hideTimePattern`),
                ...spaceTimeSolveSteps(shell, spaceTime),
                ifThen(equals(variable(spaceTime.ready), text('true')), [
                  setVariable(spaceTimeDelays, text('')),
                  setVariable(spaceTime.index, number(0)),
                  repeat(reporter(lengthOfList(spaceTime.results)), [
                    changeVariable(spaceTime.index, 1),
                    setVariable(
                      spaceTime.item,
                      reporter(
                        itemOfList(
                          variable(spaceTime.index),
                          spaceTime.results,
                        ),
                      ),
                    ),
                    setVariable(
                      spaceTimeDelays,
                      concatenate(
                        variable(spaceTimeDelays),
                        shellValue('jsonValueAt', {
                          JSON: variable(spaceTime.item),
                          PATH: text('peer'),
                        }),
                        text(' '),
                        reporter(
                          block('operator_round', {
                            NUM: reporter(
                              block('operator_divide', {
                                NUM1: shellValue('jsonValueAt', {
                                  JSON: variable(spaceTime.item),
                                  PATH: text(
                                    'payload.correspondence.displayToTimestampDelayUs',
                                  ),
                                }),
                                NUM2: number(1000),
                              }),
                            ),
                          }),
                        ),
                        text('ms（±'),
                        reporter(
                          block('operator_round', {
                            NUM: reporter(
                              block('operator_divide', {
                                NUM1: shellValue('jsonValueAt', {
                                  JSON: variable(spaceTime.item),
                                  PATH: text(
                                    'payload.correspondence.uncertaintyUs',
                                  ),
                                }),
                                NUM2: number(1000),
                              }),
                            ),
                          }),
                        ),
                        text('ms） / '),
                      ),
                    ),
                  ]),
                  notice(
                    concatenate(
                      text(
                        'READY: 空間と時刻の校正が品質基準を満たしました。表示から各カメラの撮影時刻までの遅れ: ',
                      ),
                      variable(spaceTimeDelays),
                    ),
                  ),
                ]),
              ],
            ),
          ],
        ),
      ],
    ),
    block(`${titleMenu}_showMenu`),
  ]),

  /**
   * Configures the 3D service from the space-time calibration and turns forwarding on.
   *
   * Forwarding happens in the pose loop, so 3D output starts once pose estimation runs; starting 3D
   * first is allowed and says so.
   */
  script({ x: 3800, y: 48 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.start3d },
    ),
    ifElse(
      not(
        shellBlock('appFeatureEnabled', {
          FEATURE: text(external3dServiceFlag),
        }),
      ),
      [
        error(
          text('この配布物では3Dサービスとの連携が無効です。'),
          'POSE_3D_DISABLED',
        ),
      ],
      [
        ifElse(
          not(equals(variable(spaceTime.ready), text('true'))),
          [
            error(
              text(
                '空間と時刻の校正がREADYではありません。先に「空間と時刻を校正する」を済ませてください。',
              ),
              'POSE_3D_NOT_CALIBRATED',
            ),
          ],
          [
            shellBlock('showAppLoading', {
              LABEL: text('3Dサービスを準備しています'),
            }),
            ...configurePose3dServiceSteps({
              shell,
              spaceTimeResults: spaceTime.results,
              index: spaceTime.index,
              item: spaceTime.item,
            }),
            shellBlock('hideAppLoading'),
            ifElse(
              not(
                equals(reporter(serviceBlock('serviceState')), text('ready')),
              ),
              [
                setVariable(pose3dEnabled, text('false')),
                error(
                  concatenate(
                    text('3Dサービスを開始できませんでした: '),
                    reporter(serviceBlock('serviceError')),
                  ),
                  'POSE_3D_CONFIGURE_FAILED',
                ),
              ],
              [
                setVariable(pose3dEnabled, text('true')),
                ifElse(
                  equals(variable(poseRunning), text('true')),
                  [
                    notice(
                      text(
                        '3D推定を始めました。姿勢推定の各周で3Dサービスへ送ります。',
                      ),
                    ),
                  ],
                  [
                    notice(
                      text(
                        '3Dサービスを準備しました。「姿勢推定を始める」を選ぶと、3D推定が始まります。',
                      ),
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

  script({ x: 3800, y: 1600 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.stop3d },
    ),
    ifElse(
      equals(variable(pose3dEnabled), text('true')),
      [
        setVariable(pose3dEnabled, text('false')),
        serviceBlock('stopService'),
        notice(text('3D推定を止めました。姿勢推定は続けています。')),
      ],
      [notice(text('3D推定は動いていません。'))],
    ),
    block(`${titleMenu}_showMenu`),
  ]),

  /**
   * Records the 2D poses, with the calibration they were estimated under.
   *
   * The calibration is what makes the recording replayable rather than merely readable, so recording
   * waits for the space-time calibration to be READY. Frames are recorded by the pose loop, so
   * recording and estimating are the same run: what is replayed is what was seen.
   */
  script({ x: 4400, y: 48 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.startRecording },
    ),
    ifElse(
      not(shellBlock('appFeatureEnabled', { FEATURE: text(replayFlag) })),
      [error(text('この配布物では録画と再生が無効です。'), 'REPLAY_DISABLED')],
      [
        ifElse(
          not(equals(variable(spaceTime.ready), text('true'))),
          [
            error(
              text(
                '空間と時刻の校正がREADYではありません。録画には、そのときの校正が要ります。',
              ),
              'RECORDING_NOT_CALIBRATED',
            ),
          ],
          [
            ...configurePose3dServiceSteps({
              shell,
              spaceTimeResults: spaceTime.results,
              index: spaceTime.index,
              item: spaceTime.item,
              apply: false,
            }),
            // Both limits are the operator's: 0 records every frame, until they stop it.
            shellBlock('askNumbers', {
              TITLE: text(
                '録画の長さ（秒）と、1秒あたりに記録するフレーム数（fps）を入力してください。0を入れると、その制限をかけません。',
              ),
              FIELDS: text('長さ (秒),fps'),
              DEFAULTS: text('0,0'),
            }),
            shellBlock('startPoseRecording', {
              CONFIGURATION_JSON: reporter(serviceBlock('configurationJson')),
              SECONDS: shellValue('answeredNumberAt', { INDEX: number(1) }),
              FPS: shellValue('answeredNumberAt', { INDEX: number(2) }),
            }),
            ifElse(
              equals(shellValue('poseRecordingState'), text('recording')),
              [
                notice(
                  text(
                    'ポーズの録画を始めました。「姿勢推定を始める」で推定している間のフレームを記録します。',
                  ),
                ),
              ],
              [
                error(
                  concatenate(
                    text('録画を始められませんでした: '),
                    shellValue('poseReplayError'),
                  ),
                  'RECORDING_FAILED',
                ),
              ],
            ),
          ],
        ),
      ],
    ),
    block(`${titleMenu}_showMenu`),
  ]),

  script({ x: 4400, y: 1200 }, [
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
            '録画に付ける番号を入力してください。会場のPCに local-app-<番号>.json として保存します。',
          ),
          FIELDS: text('番号'),
          DEFAULTS: text('1'),
        }),
        ifElse(
          equals(shellValue('answeredNumbers'), text('')),
          [
            notice(
              text('録画の保存をやめました。録画はこのページに残っています。'),
            ),
          ],
          [
            shellBlock('saveRecording', {
              NAME: concatenate(
                text('local-app-'),
                shellValue('answeredNumbers'),
              ),
            }),
            ifElse(
              equals(shellValue('poseReplayError'), text('')),
              [
                notice(
                  concatenate(
                    text('録画を保存しました。'),
                    shellValue('poseRecordingSummary'),
                  ),
                ),
              ],
              [
                error(
                  concatenate(
                    text('録画を保存できませんでした: '),
                    shellValue('poseReplayError'),
                  ),
                  'RECORDING_SAVE_FAILED',
                ),
              ],
            ),
          ],
        ),
      ],
      [
        notice(
          text(
            '保存できる録画がありません。「ポーズの録画を始める」から録ってください。',
          ),
        ),
      ],
    ),
    block(`${titleMenu}_showMenu`),
  ]),

  /** Reads what the venue host keeps; with no host, the operator opens the file themselves. */
  script({ x: 4400, y: 2400 }, [
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
        notice(concatenate(text('録画: '), shellValue('recordingsSummary'))),
        shellBlock('askNumbers', {
          TITLE: text(
            '読み込む録画の番号を入力してください（表示した順に1から数えます）。',
          ),
          FIELDS: text('番号'),
          DEFAULTS: text('1'),
        }),
        ifElse(
          equals(shellValue('answeredNumbers'), text('')),
          [notice(text('録画の読み込みをやめました。'))],
          [
            shellBlock('loadRecording', {
              NAME: shellValue('recordingNameAt', {
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
        notice(
          concatenate(text('読み込みました: '), shellValue('replaySummary')),
        ),
      ],
      [
        error(
          concatenate(
            text('録画を読み込めませんでした: '),
            shellValue('poseReplayError'),
          ),
          'RECORDING_LOAD_FAILED',
        ),
      ],
    ),
    block(`${titleMenu}_showMenu`),
  ]),

  /**
   * Replays the loaded recording with no camera running.
   *
   * The 3D service is configured from the recording's own calibration, not from this page's, because
   * the recording is of those cameras in those places. Nothing is started that a camera would need.
   */
  script({ x: 4400, y: 3600 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.startReplay },
    ),
    ...stopPoseAndWait(),
    ifElse(
      equals(shellValue('replaySummary'), text('録画を読み込んでいません。')),
      [
        error(
          text('先に「録画を読み込む」で録画を選んでください。'),
          'REPLAY_NOT_LOADED',
        ),
      ],
      [
        ifThen(
          shellBlock('appFeatureEnabled', {
            FEATURE: text(external3dServiceFlag),
          }),
          [
            shellBlock('showAppLoading', {
              LABEL: text('録画の校正で3Dサービスを準備しています'),
            }),
            serviceBlock('applyConfigurationJson', {
              CONFIGURATION_JSON: shellValue('replayConfigurationJson'),
            }),
            shellBlock('hideAppLoading'),
            ifElse(
              equals(reporter(serviceBlock('serviceState')), text('ready')),
              [setVariable(pose3dEnabled, text('true'))],
              [
                setVariable(pose3dEnabled, text('false')),
                error(
                  concatenate(
                    text('録画の校正で3Dサービスを開始できませんでした: '),
                    reporter(serviceBlock('serviceError')),
                  ),
                  'POSE_3D_CONFIGURE_FAILED',
                ),
              ],
            ),
          ],
        ),
        shellBlock('resetPoseMeasurement'),
        shellBlock('startPoseReplay'),
        notice(
          concatenate(
            text('録画を再生しています: '),
            shellValue('replaySummary'),
          ),
        ),
        block(`${titleMenu}_showMenu`),
        setVariable(replayWindowStart, reporter(block('sensing_timer'))),
        repeatUntil(not(equals(shellValue('replayState'), text('playing'))), [
          setVariable(replayIndex, number(0)),
          repeatUntil(
            equals(
              shellValue('jsonValueAt', {
                JSON: shellValue('replayCamerasJson'),
                PATH: reporter(join(variable(replayIndex), text(''))),
              }),
              text(''),
            ),
            [
              setVariable(
                replayCamera,
                shellValue('jsonValueAt', {
                  JSON: shellValue('replayCamerasJson'),
                  PATH: reporter(join(variable(replayIndex), text(''))),
                }),
              ),
              setVariable(
                replayFrame,
                shellValue('replayPoseFrame', {
                  CAMERA_ID: variable(replayCamera),
                }),
              ),
              ifThen(not(equals(variable(replayFrame), text(''))), [
                ifThen(equals(variable(pose3dEnabled), text('true')), [
                  serviceBlock('sendPoseFrame', {
                    FRAME_JSON: variable(replayFrame),
                    CAMERA_ID: variable(replayCamera),
                    AGE_MS: shellValue('poseFrameAgeMs', {
                      FRAME_JSON: variable(replayFrame),
                    }),
                  }),
                ]),
              ]),
              changeVariable(replayIndex, 1),
            ],
          ),
          ifThen(equals(variable(pose3dEnabled), text('true')), [
            serviceBlock('requestPose3d'),
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
                equals(variable(pose3dEnabled), text('true')),
                [
                  notice(
                    concatenate(
                      text('再生 '),
                      shellValue('replayPositionMs'),
                      text(' / '),
                      shellValue('replayDurationMs'),
                      text(' ms — '),
                      pose3dStatusText(shell),
                    ),
                  ),
                ],
                [
                  notice(
                    concatenate(
                      text('再生 '),
                      shellValue('replayPositionMs'),
                      text(' / '),
                      shellValue('replayDurationMs'),
                      text(' ms（3D推定は無効です）'),
                    ),
                  ),
                ],
              ),
              setVariable(replayWindowStart, reporter(block('sensing_timer'))),
            ],
          ),
        ]),
        ifThen(equals(variable(pose3dEnabled), text('true')), [
          setVariable(pose3dEnabled, text('false')),
          serviceBlock('stopService'),
        ]),
        notice(text('録画の再生が終わりました。')),
      ],
    ),
    block(`${titleMenu}_showMenu`),
  ]),

  script({ x: 4400, y: 6000 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.stopReplay },
    ),
    ifElse(
      equals(shellValue('replayState'), text('playing')),
      [shellBlock('stopPoseReplay'), notice(text('再生を止めました。'))],
      [notice(text('録画を再生していません。'))],
    ),
    block(`${titleMenu}_showMenu`),
  ]),

  script({ x: 2600, y: 3000 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: action.stopPose },
    ),
    ifElse(
      equals(variable(poseRunning), text('true')),
      [
        setVariable(poseRunning, text('false')),
        waitUntil(equals(variable(poseStopped), text('true'))),
        notice(
          concatenate(
            text('姿勢推定を止めました。最後の計測: '),
            shellValue('poseMeasurementSummary'),
          ),
        ),
      ],
      [notice(text('姿勢推定は動いていません。'))],
    ),
    block(`${titleMenu}_showMenu`),
  ]),
];

/**
 * Opens the lens calibration app for one camera and waits for it to hand a profile back.
 *
 * The camera is released first so the calibration window can open the same device, and it is named
 * with the size it runs at: a profile solved at another size would not fit it. The wait ends when the
 * calibration app saves a profile — which every window on this origin sees — or when the operator
 * closes the window. The camera then starts again on the same device and takes the calibration saved
 * for that device.
 */
function calibrateLensScript(index: number): Script {
  const resume = (): BlockNode[] => [
    startSlot(),
    ifElse(slotRunning(), [restoreSlotLens()], [addFailure()]),
  ];
  return script({ x: 2000, y: 48 + (index - 1) * 1400 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: calibrateLensAction(index) },
    ),
    ...stopPoseAndWait(),
    setVariable(slot, number(index)),
    setVariable(failures, text('')),
    ifElse(
      not(slotRunning()),
      [slotNotRunningError()],
      [
        setVariable(
          slotDevice,
          shellValue('jsonValueAt', {
            JSON: variable(cameraBindings),
            PATH: slotId(),
          }),
        ),
        setVariable(
          profilesGenerationBefore,
          sourceValue('storedCameraProfilesGeneration'),
        ),
        shellBlock('stopGridCamera', { CAMERA_ID: slotId() }),
        shellBlock('openLensCalibrationAppForCamera', {
          DEVICE_ID: variable(slotDevice),
          WIDTH: variable(requestWidth),
          HEIGHT: variable(requestHeight),
          FPS: variable(requestFps),
        }),
        ifElse(
          equals(shellValue('lensCalibrationAppState'), text('open')),
          [
            notice(
              concatenate(
                text('別ウィンドウのレンズ校正アプリで'),
                slotId(),
                text('を校正してください（'),
                presetLabel(),
                text(
                  '）。校正が保存されるか、そのウィンドウを閉じると、ここへ戻ります。',
                ),
              ),
            ),
            waitUntil(
              or(
                greaterThan(
                  sourceValue('storedCameraProfilesGeneration'),
                  variable(profilesGenerationBefore),
                ),
                not(shellBlock('lensCalibrationAppOpen')),
              ),
            ),
            ...resume(),
            ifElse(
              equals(variable(failures), text('')),
              [broadcastMessageAndWait(camerasChanged)],
              [
                error(
                  concatenate(
                    text('校正の後でカメラを再開できませんでした: '),
                    variable(failures),
                  ),
                  'CAMERA_RESTART_FAILED',
                ),
              ],
            ),
          ],
          [
            ...resume(),
            ifElse(
              equals(shellValue('lensCalibrationAppState'), text('busy')),
              [
                error(
                  text(
                    '別のカメラのレンズ校正ウィンドウが開いています。そちらを終えるか閉じてから、もう一度選んでください。',
                  ),
                  'LENS_CALIBRATION_BUSY',
                ),
              ],
              [
                ifElse(
                  equals(
                    shellValue('lensCalibrationAppState'),
                    text('blocked'),
                  ),
                  [
                    error(
                      text(
                        'ブラウザがレンズ校正アプリのウィンドウを開けませんでした。このページのポップアップを許可して、もう一度選んでください。',
                      ),
                      'LENS_CALIBRATION_WINDOW_BLOCKED',
                    ),
                  ],
                  [
                    error(
                      text(
                        'この起動方法ではレンズ校正アプリを開けません。会場用アプリから起動するか、レンズ校正ファイルを読んでください。',
                      ),
                      'LENS_CALIBRATION_APP_UNAVAILABLE',
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
  ]);
}

/**
 * Takes one camera's calibration from a file, uses it only if it fits that camera, and keeps it.
 *
 * The operator has said which camera the file is for, so a fitting profile is bound to that camera's
 * device before it is saved; the device in the file belongs to whichever browser solved it. A file
 * that does not fit is withdrawn, and the calibration saved for the device is taken again, so
 * nothing that does not fit stays registered.
 */
function loadLensFileScript(index: number): Script {
  return script({ x: 2000, y: 700 + (index - 1) * 1400 }, [
    block(
      `${titleMenu}_whenAppMenuActionSelected`,
      {},
      { ACTION: loadLensFileAction(index) },
    ),
    ...stopPoseAndWait(),
    setVariable(slot, number(index)),
    ifElse(
      not(slotRunning()),
      [slotNotRunningError()],
      [
        shellBlock('chooseLensCalibrationFile'),
        ifElse(
          equals(shellValue('chosenLensCalibrationFile'), text('')),
          [notice(text('レンズ校正ファイルの読込みをやめました。'))],
          [
            sourceBlock('registerCameraProfileAs', {
              PROFILE_JSON: shellValue('chosenLensCalibrationFile'),
              CAMERA_ID: slotId(),
            }),
            ifElse(
              not(equals(sourceValue('cameraProfileError'), text(''))),
              [
                error(
                  label(
                    'レンズ校正ファイルを読めませんでした。',
                    sourceBlock('cameraProfileErrorDetail'),
                  ),
                  'LENS_PROFILE_INVALID',
                ),
              ],
              [
                ifElse(
                  equals(
                    slotValue('cameraProfileCompatibility'),
                    text('compatible'),
                  ),
                  [
                    sourceBlock('bindCameraProfileToDevice', {
                      CAMERA_ID: slotId(),
                    }),
                    sourceBlock('saveCameraProfile', { CAMERA_ID: slotId() }),
                    ifElse(
                      equals(
                        slotValue('storedCameraProfileResult'),
                        text('saved'),
                      ),
                      [
                        notice(
                          concatenate(
                            slotId(),
                            text(
                              'にレンズ校正ファイルを使います。このカメラの校正としてこのPCに保存したので、次回からは読み込みを省けます。',
                            ),
                          ),
                        ),
                      ],
                      [
                        notice(
                          concatenate(
                            slotId(),
                            text(
                              'にレンズ校正ファイルを使います。ブラウザに保存できなかったため、次回も読み込みが必要です。',
                            ),
                          ),
                        ),
                      ],
                    ),
                  ],
                  [
                    setVariable(
                      lensRejection,
                      slotValue('cameraProfileCompatibilityDetail'),
                    ),
                    sourceBlock('forgetCameraProfile', { CAMERA_ID: slotId() }),
                    restoreSlotLens(),
                    error(
                      concatenate(
                        text('このレンズ校正ファイルは'),
                        slotId(),
                        text('の今の設定と合わないため使いません。'),
                        variable(lensRejection),
                      ),
                      'LENS_PROFILE_INCOMPATIBLE',
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
  ]);
}

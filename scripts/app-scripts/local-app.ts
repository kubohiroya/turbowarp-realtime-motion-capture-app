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
  type Script
} from '../../packages/sb3-script/src/blocks.ts';
import {
  broadcastMessageAndWait,
  changeVariable,
  equals,
  greaterThan,
  ifElse,
  ifThen,
  join,
  label,
  modulo,
  add,
  not,
  repeat,
  setVariable,
  whenBroadcastReceived,
  whenFlagClicked
} from '../../packages/sb3-script/src/standard.ts';

/**
 * The standalone app, stage 1 (#36): run several USB cameras on one PC and measure them.
 *
 * Each camera gets a stable ID (`cam-1`…) bound to the USB device the operator chose, and the binding
 * is remembered in this browser so the same arrangement can be started again. Every camera is asked
 * for the same size and frame rate, and the app shows what each one was configured to and how many
 * frames it actually delivers — the figure a shared USB controller limits.
 */

const shell = 'realtimemotioncapturelocalshell';
const titleMenu = 'kubohiroyaturbowarptitlemenu';
const cameraSource = 'kubohiroyacamerasource';

/** Stage 1 offers at most this many cameras. The measured limit is what stage 1 is for. */
export const maximumCameras = 4;
const maximumMenuDevices = 8;
/** A camera the operator never chose, opened only so the browser grants device labels. */
const probeCameraId = 'probe';

const presets = [
  {width: 640, height: 480, frameRate: 30},
  {width: 1280, height: 720, frameRate: 30},
  {width: 1920, height: 1080, frameRate: 30}
] as const;

const action = {
  findCameras: 'findCameras',
  restoreCameras: 'restoreCameras',
  cycleResolution: 'cycleResolution',
  stopCameras: 'stopCameras',
  diagnostics: 'diagnostics'
} as const;
const deviceAction = (index: number) => `addDevice${index}`;

const cameraCount = namedReference('camera count', 'variable:camera-count');
const cameraBindings = namedReference('camera bindings', 'variable:camera-bindings');
const preset = namedReference('resolution preset', 'variable:resolution-preset');
const slot = namedReference('camera slot', 'variable:camera-slot');
const slotDevice = namedReference('camera slot device', 'variable:camera-slot-device');
const failures = namedReference('camera failures', 'variable:camera-failures');
const requestWidth = namedReference('requested width', 'variable:requested-width');
const requestHeight = namedReference('requested height', 'variable:requested-height');
const requestFps = namedReference('requested fps', 'variable:requested-fps');
const menuActionsRequested = namedReference('menu actions requested', 'broadcast:menu-actions-requested');
const camerasChanged = namedReference('cameras changed', 'broadcast:cameras-changed');

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
    [requestFps.id]: [requestFps.name, presets[1].frameRate]
  },
  broadcasts: {
    [menuActionsRequested.id]: menuActionsRequested.name,
    [camerasChanged.id]: camerasChanged.name
  }
} as const;

const concatenate = (first: InputValue, ...rest: readonly InputValue[]): InputValue =>
  rest.reduce((left, right) => reporter(join(left, right)), first);
const shellBlock = (opcode: string, inputs: Readonly<Record<string, InputValue>> = {}) =>
  block(`${shell}_${opcode}`, inputs);
const shellValue = (opcode: string, inputs: Readonly<Record<string, InputValue>> = {}) =>
  reporter(shellBlock(opcode, inputs));
const sourceBlock = (opcode: string, inputs: Readonly<Record<string, InputValue>> = {}) =>
  block(`${cameraSource}_${opcode}`, inputs);
const sourceValue = (opcode: string, inputs: Readonly<Record<string, InputValue>> = {}) =>
  reporter(sourceBlock(opcode, inputs));
const notice = (message: InputValue) => shellBlock('showAppNotice', {MESSAGE: message});
const error = (message: InputValue, code: string) =>
  shellBlock('showAppError', {MESSAGE: message, DETAILS: text(JSON.stringify({code}))});
const addMenu = (id: string, labelText: InputValue) =>
  block(`${titleMenu}_addAppMenuAction`, {ACTION: text(id), LABEL: labelText});
const slotId = (): InputValue => reporter(join(text('cam-'), variable(slot)));

/** Copies the selected preset into the request variables every start reads. */
const applyPreset = (): BlockNode[] =>
  presets.map((entry, index) =>
    ifThen(equals(variable(preset), number(index + 1)), [
      setVariable(requestWidth, number(entry.width)),
      setVariable(requestHeight, number(entry.height)),
      setVariable(requestFps, number(entry.frameRate))
    ])
  );

const presetLabel = (): InputValue =>
  concatenate(variable(requestWidth), text('x'), variable(requestHeight), text(' '), variable(requestFps), text('fps'));

/** Starts the camera in `slot` on `slotDevice` at the selected preset. */
const startSlot = (): BlockNode =>
  shellBlock('startGridCamera', {
    CAMERA_ID: slotId(),
    DEVICE_ID: variable(slotDevice),
    WIDTH: variable(requestWidth),
    HEIGHT: variable(requestHeight),
    FPS: variable(requestFps)
  });

const slotRunning = (): BlockNode => equals(shellValue('gridCameraState', {CAMERA_ID: slotId()}), text('running'));

const addFailure = (): BlockNode =>
  setVariable(
    failures,
    concatenate(variable(failures), slotId(), text(': '), shellValue('gridCameraError', {CAMERA_ID: slotId()}), text(' / '))
  );

/** Walks slots 1 to the maximum, with `slotDevice` read from the remembered bindings. */
const forEachBoundSlot = (body: BlockNode[]): BlockNode[] => [
  setVariable(slot, number(0)),
  repeat(maximumCameras, [
    changeVariable(slot, 1),
    setVariable(slotDevice, shellValue('jsonValueAt', {JSON: variable(cameraBindings), PATH: slotId()})),
    ifThen(not(equals(variable(slotDevice), text(''))), body)
  ])
];

const summaryNotice = (): BlockNode =>
  ifElse(
    equals(shellValue('gridCamerasSummary'), text('')),
    [notice(text('動いているカメラはありません。「カメラを探す」から追加してください。'))],
    [notice(concatenate(text('要求 '), presetLabel(), text(' — '), shellValue('gridCamerasSummary')))]
  );

const baseMenu = (): BlockNode[] => [
  block(`${titleMenu}_clearAppMenuActions`),
  addMenu(action.findCameras, text('カメラを探す')),
  addMenu(action.restoreCameras, text('前回のカメラ構成で始める')),
  addMenu(action.cycleResolution, concatenate(text('解像度を切り替える（今: '), presetLabel(), text('）'))),
  addMenu(action.stopCameras, text('すべてのカメラを止める')),
  addMenu(action.diagnostics, text('動作状況を見る'))
];

const deviceMenu = (): BlockNode[] =>
  Array.from({length: maximumMenuDevices}, (_, offset) => offset + 1).map((index) =>
    ifThen(greaterThan(sourceValue('cameraDeviceCount'), number(index - 1)), [
      addMenu(
        deviceAction(index),
        label(`追加 ${index}: `, sourceBlock('cameraDeviceLabelAt', {INDEX: number(index)}))
      )
    ])
  );

export const localAppScripts: readonly Script[] = [
  script({x: 48, y: 48}, [
    whenFlagClicked(),
    shellBlock('showAppLoading', {LABEL: text('ローカルアプリを起動しています')}),
    setVariable(cameraCount, number(0)),
    setVariable(cameraBindings, text('{}')),
    ...applyPreset(),
    ...baseMenu(),
    shellBlock('hideAppLoading'),
    block(`${titleMenu}_showMenu`),
    notice(text('USBカメラをつないでから「カメラを探す」を選んでください。前回と同じ構成なら「前回のカメラ構成で始める」を選べます。'))
  ]),

  script({x: 48, y: 420}, [whenBroadcastReceived(menuActionsRequested), ...baseMenu(), ...deviceMenu()]),

  /** Labels are only visible once a camera has been granted, so one is opened and closed first. */
  script({x: 48, y: 760}, [
    block(`${titleMenu}_whenAppMenuActionSelected`, {}, {ACTION: action.findCameras}),
    sourceBlock('startSharedCamera', {CAMERA_ID: text(probeCameraId), DEVICE_ID: text('')}),
    sourceBlock('stopSharedCamera', {CAMERA_ID: text(probeCameraId)}),
    sourceBlock('refreshCameraDevices'),
    broadcastMessageAndWait(menuActionsRequested),
    ifElse(
      equals(sourceValue('cameraDeviceCount'), number(0)),
      [error(text('カメラが見つかりません。USBカメラの接続とブラウザのカメラ許可を確認してください。'), 'CAMERA_NOT_FOUND')],
      [
        notice(
          concatenate(
            sourceValue('cameraDeviceCount'),
            text('台のカメラが見つかりました。メニューの「追加 n」で、使うカメラを順に追加してください。')
          )
        )
      ]
    ),
    block(`${titleMenu}_showMenu`)
  ]),

  ...Array.from({length: maximumMenuDevices}, (_, offset) => offset + 1).map((index) =>
    script({x: 520, y: 48 + (index - 1) * 420}, [
      block(`${titleMenu}_whenAppMenuActionSelected`, {}, {ACTION: deviceAction(index)}),
      ifElse(
        greaterThan(variable(cameraCount), number(maximumCameras - 1)),
        [error(text(`カメラは${maximumCameras}台までです。`), 'CAMERA_LIMIT')],
        [
          setVariable(slot, reporter(add(variable(cameraCount), number(1)))),
          setVariable(slotDevice, sourceValue('cameraDeviceIdAt', {INDEX: number(index)})),
          startSlot(),
          ifElse(
            slotRunning(),
            [
              setVariable(cameraCount, variable(slot)),
              setVariable(
                cameraBindings,
                shellValue('jsonWithTextField', {JSON: variable(cameraBindings), KEY: slotId(), VALUE: variable(slotDevice)})
              ),
              shellBlock('rememberSetting', {KEY: text('camera-bindings'), VALUE: variable(cameraBindings)}),
              shellBlock('showCameraGrid'),
              broadcastMessageAndWait(camerasChanged)
            ],
            [
              error(
                concatenate(slotId(), text('を開始できませんでした: '), shellValue('gridCameraError', {CAMERA_ID: slotId()})),
                'CAMERA_START_FAILED'
              )
            ]
          )
        ]
      ),
      block(`${titleMenu}_showMenu`)
    ])
  ),

  script({x: 1000, y: 48}, [
    block(`${titleMenu}_whenAppMenuActionSelected`, {}, {ACTION: action.restoreCameras}),
    setVariable(cameraBindings, shellValue('rememberedSetting', {KEY: text('camera-bindings')})),
    ifElse(
      equals(variable(cameraBindings), text('')),
      [
        setVariable(cameraBindings, text('{}')),
        notice(text('このブラウザには前回のカメラ構成がありません。「カメラを探す」から追加してください。'))
      ],
      [
        shellBlock('stopAllGridCameras'),
        setVariable(cameraCount, number(0)),
        setVariable(failures, text('')),
        ...forEachBoundSlot([
          startSlot(),
          ifElse(slotRunning(), [setVariable(cameraCount, variable(slot))], [addFailure()])
        ]),
        shellBlock('showCameraGrid'),
        ifElse(
          equals(variable(failures), text('')),
          [broadcastMessageAndWait(camerasChanged)],
          [
            error(
              concatenate(text('前回の構成のうち、開始できなかったカメラがあります: '), variable(failures)),
              'CAMERA_RESTORE_INCOMPLETE'
            )
          ]
        )
      ]
    ),
    block(`${titleMenu}_showMenu`)
  ]),

  /** Every running camera is restarted at the next preset, so all of them are measured alike. */
  script({x: 1000, y: 900}, [
    block(`${titleMenu}_whenAppMenuActionSelected`, {}, {ACTION: action.cycleResolution}),
    setVariable(preset, reporter(add(reporter(modulo(variable(preset), number(presets.length))), number(1)))),
    ...applyPreset(),
    setVariable(failures, text('')),
    ...forEachBoundSlot([
      ifThen(slotRunning(), [startSlot(), ifThen(not(slotRunning()), [addFailure()])])
    ]),
    broadcastMessageAndWait(menuActionsRequested),
    ifElse(
      equals(variable(failures), text('')),
      [broadcastMessageAndWait(camerasChanged)],
      [error(concatenate(text('解像度を切り替えられなかったカメラがあります: '), variable(failures)), 'CAMERA_RESTART_FAILED')]
    ),
    block(`${titleMenu}_showMenu`)
  ]),

  script({x: 1000, y: 1500}, [
    block(`${titleMenu}_whenAppMenuActionSelected`, {}, {ACTION: action.stopCameras}),
    shellBlock('stopAllGridCameras'),
    setVariable(cameraCount, number(0)),
    notice(text('すべてのカメラを止めました。カメラ構成はこのブラウザに残っています。')),
    block(`${titleMenu}_showMenu`)
  ]),

  script({x: 1000, y: 1800}, [
    block(`${titleMenu}_whenAppMenuActionSelected`, {}, {ACTION: action.diagnostics}),
    summaryNotice(),
    block(`${titleMenu}_showMenu`)
  ]),

  /** The measured frame rate needs a window to fill before it means anything. */
  script({x: 1500, y: 48}, [
    whenBroadcastReceived(camerasChanged),
    block('control_wait', {DURATION: number(1.5)}),
    summaryNotice()
  ])
];

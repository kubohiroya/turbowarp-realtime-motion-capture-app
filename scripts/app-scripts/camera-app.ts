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
  broadcastMessage,
  broadcastMessageAndWait,
  equals,
  forever,
  greaterThan,
  ifElse,
  ifThen,
  join,
  label,
  not,
  setVariable,
  wait,
  whenBroadcastReceived,
  whenFlagClicked
} from '../../packages/sb3-script/src/standard.ts';

const shell = 'multiviewposecamerashell';
const titleMenu = 'kubohiroyaturbowarptitlemenu';
const cameraSource = 'kubohiroyacamerasource';

const action = {
  chooseCamera: 'chooseCamera',
  stopCamera: 'stopCamera',
  diagnostics: 'diagnostics'
} as const;

const cameraId = 'pose';
const cameraShouldBeRunning = namedReference(
  'camera should be running',
  'variable:camera-should-be-running'
);
const selectedDeviceIndex = namedReference(
  'selected device index',
  'variable:selected-device-index'
);
const lastCameraStartErrorCode = namedReference(
  'last camera start error code',
  'variable:last-camera-start-error-code'
);
const cameraDeviceSelected = namedReference(
  'camera device selected',
  'broadcast:camera-device-selected'
);
const menuActionsRequested = namedReference(
  'menu actions requested',
  'broadcast:menu-actions-requested'
);
const maximumMenuDevices = 8;

export const cameraAppStageData = {
  variables: {
    [cameraShouldBeRunning.id]: [cameraShouldBeRunning.name, 'false'],
    [selectedDeviceIndex.id]: [selectedDeviceIndex.name, 1],
    [lastCameraStartErrorCode.id]: [lastCameraStartErrorCode.name, '']
  },
  broadcasts: {
    [cameraDeviceSelected.id]: cameraDeviceSelected.name,
    [menuActionsRequested.id]: menuActionsRequested.name
  }
} as const;

const cameraDeviceAction = (index: number) => `cameraDevice${index}`;
const cameraBlock = (opcode: string, inputs: Readonly<Record<string, InputValue>> = {}) =>
  block(`${cameraSource}_${opcode}`, inputs);
const cameraValue = (opcode: string, inputs: Readonly<Record<string, InputValue>> = {}) =>
  reporter(cameraBlock(opcode, inputs));

const concatenate = (first: InputValue, ...rest: readonly InputValue[]): InputValue =>
  rest.reduce((left, right) => reporter(join(left, right)), first);

const baseMenuActions = (chooseCameraLabel: string): BlockNode[] => [
  block(`${titleMenu}_addAppMenuAction`, {
    ACTION: text(action.chooseCamera),
    LABEL: text(chooseCameraLabel)
  }),
  block(`${titleMenu}_addAppMenuAction`, {
    ACTION: text(action.stopCamera),
    LABEL: text('カメラを止める')
  }),
  block(`${titleMenu}_addAppMenuAction`, {
    ACTION: text(action.diagnostics),
    LABEL: text('動作状況を見る')
  })
];

const cameraDeviceMenuActions = (): BlockNode[] =>
  Array.from({length: maximumMenuDevices}, (_, offset) => offset + 1).map((index) =>
    ifThen(greaterThan(cameraValue('cameraDeviceCount'), number(index - 1)), [
      block(`${titleMenu}_addAppMenuAction`, {
        ACTION: text(cameraDeviceAction(index)),
        LABEL: label(`${index}: `, cameraBlock('cameraDeviceLabelAt', {INDEX: number(index)}))
      })
    ])
  );

const activeCameraSummary = (): InputValue =>
  concatenate(
    label('device: ', cameraBlock('cameraDeviceIdReporter', {CAMERA_ID: text(cameraId)})),
    text(' / resolution: '),
    cameraValue('cameraFrameWidth', {CAMERA_ID: text(cameraId)}),
    text('x'),
    cameraValue('cameraFrameHeight', {CAMERA_ID: text(cameraId)}),
    text(' / fps: '),
    cameraValue('cameraFrameRate', {CAMERA_ID: text(cameraId)})
  );

const showCameraNotFoundError = () =>
  block(`${shell}_showAppError`, {
    MESSAGE: text('カメラが見つかりません。接続を確認してください。'),
    DETAILS: text('{"code":"CAMERA_NOT_FOUND","cameraId":"pose"}')
  });

const showCameraPermissionError = () =>
  block(`${shell}_showAppError`, {
    MESSAGE: text('カメラを開始できませんでした。ブラウザのカメラ使用許可を確認してください。'),
    DETAILS: text('{"code":"CAMERA_PERMISSION_DENIED","cameraId":"pose"}')
  });

const showCameraUnavailableError = () =>
  block(`${shell}_showAppError`, {
    MESSAGE: text('カメラを開始できませんでした。接続状態を確認して選び直してください。'),
    DETAILS: text('{"code":"CAMERA_DEVICE_UNAVAILABLE","cameraId":"pose"}')
  });

const showCameraStartError = (): BlockNode[] => [
  setVariable(
    lastCameraStartErrorCode,
    cameraValue('cameraErrorCode', {CAMERA_ID: text(cameraId)})
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
            [showCameraUnavailableError()]
          )
        ]
      )
    ]
  )
];

const showPreview = (): BlockNode[] => [
  setVariable(cameraShouldBeRunning, text('true')),
  cameraBlock('showCameraPreview', {CAMERA_ID: text(cameraId), MIRRORED: text('true')}),
  block(`${shell}_showAppNotice`, {MESSAGE: activeCameraSummary()})
];

export const cameraAppScripts: readonly Script[] = [
  script({x: 48, y: 48}, [
    whenFlagClicked(),
    setVariable(cameraShouldBeRunning, text('false')),
    block(`${shell}_showAppLoading`, {LABEL: text('カメラアプリを起動しています')}),
    block(`${titleMenu}_clearAppMenuActions`),
    ...baseMenuActions('カメラを選ぶ'),
    block(`${shell}_hideAppLoading`),
    ifElse(
      not(block(`${shell}_webGpuAvailable`)),
      [
        block(`${shell}_showAppError`, {
          MESSAGE: text('このブラウザではWebGPUを利用できないため、姿勢認識を開始できません。'),
          DETAILS: text('{"code":"WEBGPU_UNAVAILABLE"}')
        })
      ],
      [block(`${titleMenu}_showMenu`)]
    ),
    forever([
      wait(0.5),
      ifThen(equals(variable(cameraShouldBeRunning), text('true')), [
        ifThen(not(cameraBlock('isCameraRunning', {CAMERA_ID: text(cameraId)})), [
          setVariable(cameraShouldBeRunning, text('false')),
          cameraBlock('hideCameraPreview', {CAMERA_ID: text(cameraId)}),
          cameraBlock('stopSharedCamera', {CAMERA_ID: text(cameraId)}),
          block(`${shell}_showAppError`, {
            MESSAGE: text('使用中のカメラが切断されました。再接続して選び直してください。'),
            DETAILS: text('{"code":"CAMERA_TRACK_ENDED","cameraId":"pose"}')
          })
        ])
      ])
    ])
  ]),

  script({x: 48, y: 360}, [
    block(`${titleMenu}_whenAppMenuActionSelected`, {}, {ACTION: action.chooseCamera}),
    block(`${titleMenu}_clearAppMenuActions`),
    setVariable(cameraShouldBeRunning, text('false')),
    cameraBlock('hideCameraPreview', {CAMERA_ID: text(cameraId)}),
    cameraBlock('stopSharedCamera', {CAMERA_ID: text(cameraId)}),
    cameraBlock('startSharedCamera', {CAMERA_ID: text(cameraId), DEVICE_ID: text('')}),
    ifElse(
      cameraBlock('isCameraRunning', {CAMERA_ID: text(cameraId)}),
      [
        setVariable(cameraShouldBeRunning, text('true')),
        cameraBlock('showCameraPreview', {
          CAMERA_ID: text(cameraId),
          MIRRORED: text('true')
        }),
        cameraBlock('refreshCameraDevices'),
        broadcastMessageAndWait(menuActionsRequested),
        block(`${titleMenu}_showMenu`)
      ],
      [
        cameraBlock('refreshCameraDevices'),
        broadcastMessageAndWait(menuActionsRequested),
        ...showCameraStartError()
      ]
    )
  ]),

  ...Array.from({length: maximumMenuDevices}, (_, offset) => offset + 1).map((index) =>
    script({x: 520, y: 48 + (index - 1) * 280}, [
      block(`${titleMenu}_whenAppMenuActionSelected`, {}, {ACTION: cameraDeviceAction(index)}),
      block(`${titleMenu}_clearAppMenuActions`),
      broadcastMessageAndWait(menuActionsRequested),
      setVariable(selectedDeviceIndex, number(index)),
      broadcastMessage(cameraDeviceSelected)
    ])
  ),

  script({x: 900, y: 48}, [
    whenBroadcastReceived(cameraDeviceSelected),
    setVariable(cameraShouldBeRunning, text('false')),
    cameraBlock('hideCameraPreview', {CAMERA_ID: text(cameraId)}),
    cameraBlock('stopSharedCamera', {CAMERA_ID: text(cameraId)}),
    cameraBlock('startSharedCamera', {
      CAMERA_ID: text(cameraId),
      DEVICE_ID: cameraValue('cameraDeviceIdAt', {INDEX: variable(selectedDeviceIndex)})
    }),
    ifElse(
      cameraBlock('isCameraRunning', {CAMERA_ID: text(cameraId)}),
      showPreview(),
      showCameraStartError()
    )
  ]),

  script({x: 48, y: 760}, [
    block(`${titleMenu}_whenAppMenuActionSelected`, {}, {ACTION: action.stopCamera}),
    block(`${titleMenu}_clearAppMenuActions`),
    broadcastMessageAndWait(menuActionsRequested),
    setVariable(cameraShouldBeRunning, text('false')),
    cameraBlock('hideCameraPreview', {CAMERA_ID: text(cameraId)}),
    cameraBlock('stopSharedCamera', {CAMERA_ID: text(cameraId)}),
    block(`${shell}_showAppNotice`, {MESSAGE: text('カメラを止めました。')})
  ]),

  script({x: 48, y: 960}, [
    block(`${titleMenu}_whenAppMenuActionSelected`, {}, {ACTION: action.diagnostics}),
    block(`${titleMenu}_clearAppMenuActions`),
    broadcastMessageAndWait(menuActionsRequested),
    ifElse(
      not(block(`${shell}_webGpuAvailable`)),
      [
        block(`${shell}_showAppError`, {
          MESSAGE: text('WebGPU: 利用不可'),
          DETAILS: text('{"code":"WEBGPU_UNAVAILABLE"}')
        })
      ],
      [
        ifElse(
          cameraBlock('isCameraRunning', {CAMERA_ID: text(cameraId)}),
          [block(`${shell}_showAppNotice`, {MESSAGE: activeCameraSummary()})],
          [block(`${shell}_showAppNotice`, {MESSAGE: text('WebGPU: 利用可能 / カメラ: 停止中')})]
        )
      ]
    )
  ]),

  script({x: 520, y: 2360}, [
    whenBroadcastReceived(menuActionsRequested),
    ...cameraDeviceMenuActions(),
    ...baseMenuActions('カメラを探し直す')
  ])
];

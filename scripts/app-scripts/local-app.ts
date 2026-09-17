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
  and,
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
  or,
  repeat,
  setVariable,
  waitUntil,
  whenBroadcastReceived,
  whenFlagClicked
} from '../../packages/sb3-script/src/standard.ts';

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
const calibrateLensAction = (index: number) => `calibrateLens${index}`;
const loadLensFileAction = (index: number) => `loadLensFile${index}`;

const cameraCount = namedReference('camera count', 'variable:camera-count');
const cameraBindings = namedReference('camera bindings', 'variable:camera-bindings');
const preset = namedReference('resolution preset', 'variable:resolution-preset');
const slot = namedReference('camera slot', 'variable:camera-slot');
const slotDevice = namedReference('camera slot device', 'variable:camera-slot-device');
const failures = namedReference('camera failures', 'variable:camera-failures');
const requestWidth = namedReference('requested width', 'variable:requested-width');
const requestHeight = namedReference('requested height', 'variable:requested-height');
const requestFps = namedReference('requested fps', 'variable:requested-fps');
const lensSummary = namedReference('lens summary', 'variable:lens-summary');
const lensRejection = namedReference('lens rejection', 'variable:lens-rejection');
/** The stored-profile generation when a calibration window opened; a larger one means it saved. */
const profilesGenerationBefore = namedReference(
  'stored profiles generation before',
  'variable:stored-profiles-generation-before'
);
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
    [requestFps.id]: [requestFps.name, presets[1].frameRate],
    [lensSummary.id]: [lensSummary.name, ''],
    [lensRejection.id]: [lensRejection.name, ''],
    [profilesGenerationBefore.id]: [profilesGenerationBefore.name, 0]
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

const slotValue = (opcode: string): InputValue => sourceValue(opcode, {CAMERA_ID: slotId()});

/**
 * Registers the slot's calibration from those saved for its device, at the size it runs now.
 *
 * Fails closed in Camera Source: nothing that does not fit is registered, and a profile already in
 * force stays unless a fitting one replaces it.
 */
const restoreSlotLens = (): BlockNode => sourceBlock('restoreStoredCameraProfileForDevice', {CAMERA_ID: slotId()});

/** One word per camera. Calibrated means it fits the camera as it runs now and was solved on its device. */
const lensStateOfSlot = (): BlockNode[] => [
  ifElse(
    and(
      equals(slotValue('cameraProfileCompatibility'), text('compatible')),
      sourceBlock('cameraProfileOnDevice', {CAMERA_ID: slotId()})
    ),
    [setVariable(lensSummary, concatenate(variable(lensSummary), slotId(), text(' 校正済み / ')))],
    [
      ifElse(
        sourceBlock('cameraProfileRegistered', {CAMERA_ID: slotId()}),
        [setVariable(lensSummary, concatenate(variable(lensSummary), slotId(), text(' 合わない / ')))],
        [
          ifElse(
            equals(slotValue('storedCameraProfileResult'), text('unavailable')),
            [setVariable(lensSummary, concatenate(variable(lensSummary), slotId(), text(' 保存領域が使えない / ')))],
            [setVariable(lensSummary, concatenate(variable(lensSummary), slotId(), text(' 未校正 / ')))]
          )
        ]
      )
    ]
  )
];

const summaryNotice = (): BlockNode[] => [
  setVariable(lensSummary, text('')),
  ...forEachBoundSlot([ifThen(slotRunning(), lensStateOfSlot())]),
  ifElse(
    equals(shellValue('gridCamerasSummary'), text('')),
    [notice(text('動いているカメラはありません。「カメラを探す」から追加してください。'))],
    [
      notice(
        concatenate(
          text('要求 '),
          presetLabel(),
          text(' — '),
          shellValue('gridCamerasSummary'),
          text(' — レンズ: '),
          variable(lensSummary)
        )
      )
    ]
  )
];

const baseMenu = (): BlockNode[] => [
  block(`${titleMenu}_clearAppMenuActions`),
  addMenu(action.findCameras, text('カメラを探す')),
  addMenu(action.restoreCameras, text('前回のカメラ構成で始める')),
  addMenu(action.cycleResolution, concatenate(text('解像度を切り替える（今: '), presetLabel(), text('）'))),
  addMenu(action.stopCameras, text('すべてのカメラを止める')),
  addMenu(action.diagnostics, text('動作状況を見る'))
];

/** Calibration entries for the cameras that are running; a stopped camera has no device to calibrate. */
const lensMenu = (): BlockNode[] =>
  Array.from({length: maximumCameras}, (_, offset) => offset + 1).map((index) =>
    ifThen(equals(shellValue('gridCameraState', {CAMERA_ID: text(`cam-${index}`)}), text('running')), [
      addMenu(calibrateLensAction(index), text(`cam-${index} のレンズを校正する`)),
      addMenu(loadLensFileAction(index), text(`cam-${index} のレンズ校正ファイルを読む`))
    ])
  );

const deviceMenu = (): BlockNode[] =>
  Array.from({length: maximumMenuDevices}, (_, offset) => offset + 1).map((index) =>
    ifThen(greaterThan(sourceValue('cameraDeviceCount'), number(index - 1)), [
      addMenu(
        deviceAction(index),
        label(`追加 ${index}: `, sourceBlock('cameraDeviceLabelAt', {INDEX: number(index)}))
      )
    ])
  );

const slotNotRunningError = (): BlockNode =>
  error(concatenate(slotId(), text('は動いていません。先にカメラを開始してください。')), 'CAMERA_NOT_RUNNING');

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

  script({x: 48, y: 420}, [
    whenBroadcastReceived(menuActionsRequested),
    ...baseMenu(),
    ...lensMenu(),
    ...deviceMenu()
  ]),

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
              restoreSlotLens(),
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
          ifElse(slotRunning(), [setVariable(cameraCount, variable(slot)), restoreSlotLens()], [addFailure()])
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
      ifThen(slotRunning(), [startSlot(), ifElse(slotRunning(), [restoreSlotLens()], [addFailure()])])
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
    ...summaryNotice(),
    block(`${titleMenu}_showMenu`)
  ]),

  /** The measured frame rate needs a window to fill before it means anything. */
  script({x: 1500, y: 48}, [
    whenBroadcastReceived(camerasChanged),
    broadcastMessageAndWait(menuActionsRequested),
    block('control_wait', {DURATION: number(1.5)}),
    ...summaryNotice()
  ]),

  ...Array.from({length: maximumCameras}, (_, offset) => offset + 1).flatMap((index) => [
    calibrateLensScript(index),
    loadLensFileScript(index)
  ])
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
    ifElse(slotRunning(), [restoreSlotLens()], [addFailure()])
  ];
  return script({x: 2000, y: 48 + (index - 1) * 1400}, [
    block(`${titleMenu}_whenAppMenuActionSelected`, {}, {ACTION: calibrateLensAction(index)}),
    setVariable(slot, number(index)),
    setVariable(failures, text('')),
    ifElse(
      not(slotRunning()),
      [slotNotRunningError()],
      [
        setVariable(slotDevice, shellValue('jsonValueAt', {JSON: variable(cameraBindings), PATH: slotId()})),
        setVariable(profilesGenerationBefore, sourceValue('storedCameraProfilesGeneration')),
        shellBlock('stopGridCamera', {CAMERA_ID: slotId()}),
        shellBlock('openLensCalibrationAppForCamera', {
          DEVICE_ID: variable(slotDevice),
          WIDTH: variable(requestWidth),
          HEIGHT: variable(requestHeight),
          FPS: variable(requestFps)
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
                text('）。校正が保存されるか、そのウィンドウを閉じると、ここへ戻ります。')
              )
            ),
            waitUntil(
              or(
                greaterThan(sourceValue('storedCameraProfilesGeneration'), variable(profilesGenerationBefore)),
                not(shellBlock('lensCalibrationAppOpen'))
              )
            ),
            ...resume(),
            ifElse(
              equals(variable(failures), text('')),
              [broadcastMessageAndWait(camerasChanged)],
              [error(concatenate(text('校正の後でカメラを再開できませんでした: '), variable(failures)), 'CAMERA_RESTART_FAILED')]
            )
          ],
          [
            ...resume(),
            ifElse(
              equals(shellValue('lensCalibrationAppState'), text('busy')),
              [
                error(
                  text('別のカメラのレンズ校正ウィンドウが開いています。そちらを終えるか閉じてから、もう一度選んでください。'),
                  'LENS_CALIBRATION_BUSY'
                )
              ],
              [
                ifElse(
                  equals(shellValue('lensCalibrationAppState'), text('blocked')),
                  [
                    error(
                      text('ブラウザがレンズ校正アプリのウィンドウを開けませんでした。このページのポップアップを許可して、もう一度選んでください。'),
                      'LENS_CALIBRATION_WINDOW_BLOCKED'
                    )
                  ],
                  [
                    error(
                      text('この起動方法ではレンズ校正アプリを開けません。会場用アプリから起動するか、レンズ校正ファイルを読んでください。'),
                      'LENS_CALIBRATION_APP_UNAVAILABLE'
                    )
                  ]
                )
              ]
            )
          ]
        )
      ]
    ),
    block(`${titleMenu}_showMenu`)
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
  return script({x: 2000, y: 700 + (index - 1) * 1400}, [
    block(`${titleMenu}_whenAppMenuActionSelected`, {}, {ACTION: loadLensFileAction(index)}),
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
              CAMERA_ID: slotId()
            }),
            ifElse(
              not(equals(sourceValue('cameraProfileError'), text(''))),
              [
                error(
                  label('レンズ校正ファイルを読めませんでした。', sourceBlock('cameraProfileErrorDetail')),
                  'LENS_PROFILE_INVALID'
                )
              ],
              [
                ifElse(
                  equals(slotValue('cameraProfileCompatibility'), text('compatible')),
                  [
                    sourceBlock('bindCameraProfileToDevice', {CAMERA_ID: slotId()}),
                    sourceBlock('saveCameraProfile', {CAMERA_ID: slotId()}),
                    ifElse(
                      equals(slotValue('storedCameraProfileResult'), text('saved')),
                      [
                        notice(
                          concatenate(
                            slotId(),
                            text('にレンズ校正ファイルを使います。このカメラの校正としてこのPCに保存したので、次回からは読み込みを省けます。')
                          )
                        )
                      ],
                      [
                        notice(
                          concatenate(
                            slotId(),
                            text('にレンズ校正ファイルを使います。ブラウザに保存できなかったため、次回も読み込みが必要です。')
                          )
                        )
                      ]
                    )
                  ],
                  [
                    setVariable(lensRejection, slotValue('cameraProfileCompatibilityDetail')),
                    sourceBlock('forgetCameraProfile', {CAMERA_ID: slotId()}),
                    restoreSlotLens(),
                    error(
                      concatenate(
                        text('このレンズ校正ファイルは'),
                        slotId(),
                        text('の今の設定と合わないため使いません。'),
                        variable(lensRejection)
                      ),
                      'LENS_PROFILE_INCOMPATIBLE'
                    )
                  ]
                )
              ]
            )
          ]
        )
      ]
    ),
    block(`${titleMenu}_showMenu`)
  ]);
}

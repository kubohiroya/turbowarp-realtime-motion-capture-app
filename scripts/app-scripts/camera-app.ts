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
  or,
  setVariable,
  wait,
  waitUntil,
  whenBroadcastReceived,
  whenFlagClicked
} from '../../packages/sb3-script/src/standard.ts';

const shell = 'realtimemotioncapturecamerashell';
const titleMenu = 'kubohiroyaturbowarptitlemenu';
const cameraSource = 'kubohiroyacamerasource';

const action = {
  chooseCamera: 'chooseCamera',
  openLensCalibration: 'openLensCalibration',
  loadLensCalibrationFile: 'loadLensCalibrationFile',
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
/** `true` only while a lens profile that fits the running camera is registered for it. */
const lensCalibrationReady = namedReference(
  'lens calibration ready',
  'variable:lens-calibration-ready'
);
/** The device to give the camera back to once the calibration window has let go of it. */
const lensCalibrationDeviceId = namedReference(
  'lens calibration device ID',
  'variable:lens-calibration-device-id'
);
/** The stored-profile generation when the calibration window opened; a larger one means it saved. */
const storedProfilesGenerationBefore = namedReference(
  'stored profiles generation before',
  'variable:stored-profiles-generation-before'
);
const lensProfileRejection = namedReference(
  'lens profile rejection',
  'variable:lens-profile-rejection'
);
const lensCalibrationRequested = namedReference(
  'lens calibration requested',
  'broadcast:lens-calibration-requested'
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
    [lastCameraStartErrorCode.id]: [lastCameraStartErrorCode.name, ''],
    [lensCalibrationReady.id]: [lensCalibrationReady.name, 'false'],
    [lensCalibrationDeviceId.id]: [lensCalibrationDeviceId.name, ''],
    [storedProfilesGenerationBefore.id]: [storedProfilesGenerationBefore.name, 0],
    [lensProfileRejection.id]: [lensProfileRejection.name, '']
  },
  broadcasts: {
    [lensCalibrationRequested.id]: lensCalibrationRequested.name,
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

const shellBlock = (opcode: string, inputs: Readonly<Record<string, InputValue>> = {}) =>
  block(`${shell}_${opcode}`, inputs);
const shellValue = (opcode: string) => reporter(shellBlock(opcode));

const baseMenuActions = (chooseCameraLabel: string): BlockNode[] => [
  block(`${titleMenu}_addAppMenuAction`, {
    ACTION: text(action.chooseCamera),
    LABEL: text(chooseCameraLabel)
  }),
  block(`${titleMenu}_addAppMenuAction`, {
    ACTION: text(action.openLensCalibration),
    LABEL: text('レンズ校正アプリで校正する')
  }),
  block(`${titleMenu}_addAppMenuAction`, {
    ACTION: text(action.loadLensCalibrationFile),
    LABEL: text('レンズ校正ファイルを読む')
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
    cameraValue('cameraFrameRate', {CAMERA_ID: text(cameraId)}),
    text(' / lens: '),
    cameraValue('cameraProfileCompatibility', {CAMERA_ID: text(cameraId)})
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
  cameraBlock('showCameraPreview', {CAMERA_ID: text(cameraId), PREVIEW_FLIP: text('horizontal')}),
  block(`${shell}_showAppNotice`, {MESSAGE: activeCameraSummary()}),
  broadcastMessageAndWait(lensCalibrationRequested)
];

const storedProfileResult = () =>
  cameraValue('storedCameraProfileResult', {CAMERA_ID: text(cameraId)});
const storedProfileDetail = () =>
  cameraValue('storedCameraProfileDetail', {CAMERA_ID: text(cameraId)});

const showCameraNotRunningError = () =>
  shellBlock('showAppError', {
    MESSAGE: text('先に「カメラを選ぶ」で校正するカメラを選んでください。'),
    DETAILS: text('{"code":"CAMERA_NOT_RUNNING","cameraId":"pose"}')
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
    DEVICE_ID: variable(lensCalibrationDeviceId)
  }),
  ifElse(
    cameraBlock('isCameraRunning', {CAMERA_ID: text(cameraId)}),
    [
      setVariable(cameraShouldBeRunning, text('true')),
      cameraBlock('showCameraPreview', {
        CAMERA_ID: text(cameraId),
        PREVIEW_FLIP: text('horizontal')
      }),
      broadcastMessageAndWait(lensCalibrationRequested)
    ],
    showCameraStartError()
  )
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
          PREVIEW_FLIP: text('horizontal')
        }),
        cameraBlock('refreshCameraDevices'),
        broadcastMessageAndWait(menuActionsRequested),
        broadcastMessageAndWait(lensCalibrationRequested),
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

  /**
   * The first step once a camera runs: make sure its lens is calibrated.
   *
   * A profile saved in this browser is used when it fits the camera as it is configured now, and the
   * operator is told which one. Anything short of `compatible` is not applied: a profile solved at a
   * different resolution or zoom produces plausible but wrong geometry rather than a visible error,
   * so the operator is sent to calibrate or to a file instead.
   */
  script({x: 1400, y: 48}, [
    whenBroadcastReceived(lensCalibrationRequested),
    setVariable(lensCalibrationReady, text('false')),
    cameraBlock('restoreStoredCameraProfile', {CAMERA_ID: text(cameraId)}),
    ifElse(
      equals(storedProfileResult(), text('restored')),
      [
        setVariable(lensCalibrationReady, text('true')),
        shellBlock('showAppNotice', {
          MESSAGE: label('このPCに保存済みのレンズ校正を使います。', cameraBlock('storedCameraProfileDetail', {CAMERA_ID: text(cameraId)}))
        })
      ],
      [
        ifElse(
          equals(storedProfileResult(), text('incompatible')),
          [
            shellBlock('showAppNotice', {
              MESSAGE: concatenate(
                text('保存済みのレンズ校正は今のカメラの設定と合いません（'),
                storedProfileDetail(),
                text('）。メニューから校正するか、校正ファイルを読んでください。')
              )
            })
          ],
          [
            ifElse(
              equals(storedProfileResult(), text('unavailable')),
              [
                shellBlock('showAppNotice', {
                  MESSAGE: text(
                    'このブラウザでは校正の保存領域を使えません。メニューから校正するか、校正ファイルを読んでください。'
                  )
                })
              ],
              [
                shellBlock('showAppNotice', {
                  MESSAGE: text(
                    'このカメラのレンズ校正がまだありません。メニューの「レンズ校正アプリで校正する」か「レンズ校正ファイルを読む」を選んでください。'
                  )
                })
              ]
            )
          ]
        )
      ]
    )
  ]),

  /**
   * Opens the lens calibration app beside this one and waits for it to hand a profile back.
   *
   * The camera is released first so the calibration window can open the same device. The wait ends
   * when the calibration app saves a profile to browser storage — which every window on this origin
   * sees — or when the operator closes the window without one.
   */
  script({x: 1400, y: 1000}, [
    block(`${titleMenu}_whenAppMenuActionSelected`, {}, {ACTION: action.openLensCalibration}),
    block(`${titleMenu}_clearAppMenuActions`),
    broadcastMessageAndWait(menuActionsRequested),
    ifElse(
      not(cameraBlock('isCameraRunning', {CAMERA_ID: text(cameraId)})),
      [showCameraNotRunningError()],
      [
        setVariable(
          lensCalibrationDeviceId,
          cameraValue('cameraDeviceIdReporter', {CAMERA_ID: text(cameraId)})
        ),
        setVariable(storedProfilesGenerationBefore, cameraValue('storedCameraProfilesGeneration')),
        setVariable(cameraShouldBeRunning, text('false')),
        cameraBlock('hideCameraPreview', {CAMERA_ID: text(cameraId)}),
        cameraBlock('stopSharedCamera', {CAMERA_ID: text(cameraId)}),
        shellBlock('openLensCalibrationApp'),
        ifElse(
          equals(shellValue('lensCalibrationAppState'), text('open')),
          [
            shellBlock('showAppNotice', {
              MESSAGE: text(
                '別ウィンドウのレンズ校正アプリで校正してください。校正が保存されるか、そのウィンドウを閉じると、ここへ戻ります。'
              )
            }),
            waitUntil(
              or(
                greaterThan(
                  cameraValue('storedCameraProfilesGeneration'),
                  variable(storedProfilesGenerationBefore)
                ),
                not(shellBlock('lensCalibrationAppOpen'))
              )
            ),
            ...resumeCameraAfterLensCalibration()
          ],
          [
            ...resumeCameraAfterLensCalibration(),
            ifElse(
              equals(shellValue('lensCalibrationAppState'), text('blocked')),
              [
                shellBlock('showAppError', {
                  MESSAGE: text(
                    'ブラウザがレンズ校正アプリのウィンドウを開けませんでした。このページのポップアップを許可して、もう一度選んでください。'
                  ),
                  DETAILS: text('{"code":"LENS_CALIBRATION_WINDOW_BLOCKED"}')
                })
              ],
              [
                shellBlock('showAppError', {
                  MESSAGE: text(
                    'この起動方法ではレンズ校正アプリを開けません。会場用アプリから起動するか、「レンズ校正ファイルを読む」を選んでください。'
                  ),
                  DETAILS: text('{"code":"LENS_CALIBRATION_APP_UNAVAILABLE"}')
                })
              ]
            )
          ]
        )
      ]
    ),
    block(`${titleMenu}_showMenu`)
  ]),

  /**
   * Takes a profile from a file, uses it only if it fits the running camera, and keeps it for next
   * time.
   *
   * A file that fails validation leaves whatever profile was in force untouched. A file that is valid
   * but does not fit replaces it and is then withdrawn, so nothing that does not fit stays registered.
   */
  script({x: 1400, y: 2200}, [
    block(`${titleMenu}_whenAppMenuActionSelected`, {}, {ACTION: action.loadLensCalibrationFile}),
    block(`${titleMenu}_clearAppMenuActions`),
    broadcastMessageAndWait(menuActionsRequested),
    ifElse(
      not(cameraBlock('isCameraRunning', {CAMERA_ID: text(cameraId)})),
      [showCameraNotRunningError()],
      [
        shellBlock('chooseLensCalibrationFile'),
        ifElse(
          equals(shellValue('chosenLensCalibrationFile'), text('')),
          [shellBlock('showAppNotice', {MESSAGE: text('レンズ校正ファイルの読込みをやめました。')})],
          [
            cameraBlock('registerCameraProfileAs', {
              PROFILE_JSON: shellValue('chosenLensCalibrationFile'),
              CAMERA_ID: text(cameraId)
            }),
            ifElse(
              not(equals(cameraValue('cameraProfileError'), text(''))),
              [
                shellBlock('showAppError', {
                  MESSAGE: label('レンズ校正ファイルを読めませんでした。', cameraBlock('cameraProfileErrorDetail')),
                  DETAILS: text('{"code":"LENS_PROFILE_INVALID","cameraId":"pose"}')
                })
              ],
              [
                ifElse(
                  equals(
                    cameraValue('cameraProfileCompatibility', {CAMERA_ID: text(cameraId)}),
                    text('compatible')
                  ),
                  [
                    setVariable(lensCalibrationReady, text('true')),
                    cameraBlock('saveCameraProfile', {CAMERA_ID: text(cameraId)}),
                    ifElse(
                      equals(storedProfileResult(), text('saved')),
                      [
                        shellBlock('showAppNotice', {
                          MESSAGE: text(
                            'レンズ校正ファイルを使います。このPCに保存したので、次回からは読み込みを省けます。'
                          )
                        })
                      ],
                      [
                        shellBlock('showAppNotice', {
                          MESSAGE: text(
                            'レンズ校正ファイルを使います。ブラウザに保存できなかったため、次回も読み込みが必要です。'
                          )
                        })
                      ]
                    )
                  ],
                  [
                    setVariable(lensCalibrationReady, text('false')),
                    setVariable(
                      lensProfileRejection,
                      cameraValue('cameraProfileCompatibilityDetail', {CAMERA_ID: text(cameraId)})
                    ),
                    cameraBlock('forgetCameraProfile', {CAMERA_ID: text(cameraId)}),
                    shellBlock('showAppError', {
                      MESSAGE: concatenate(
                        text('このレンズ校正ファイルは今のカメラの設定と合わないため使いません。'),
                        variable(lensProfileRejection)
                      ),
                      DETAILS: text('{"code":"LENS_PROFILE_INCOMPATIBLE","cameraId":"pose"}')
                    })
                  ]
                )
              ]
            )
          ]
        )
      ]
    ),
    block(`${titleMenu}_showMenu`)
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

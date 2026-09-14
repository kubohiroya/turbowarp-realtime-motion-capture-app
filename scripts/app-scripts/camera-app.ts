import {block, reporter, script, text, type Script} from '../../packages/sb3-script/src/blocks.ts';
import {
  equals,
  ifElse,
  join,
  label,
  not,
  whenFlagClicked
} from '../../packages/sb3-script/src/standard.ts';

const shell = 'multiviewposecamerashell';
const titleMenu = 'kubohiroyaturbowarptitlemenu';
const cameraSource = 'kubohiroyacamerasource';

/** Menu action ids. The hat matches on these, so they are part of the script's contract. */
const action = {
  selectCamera: 'selectCamera',
  stopCamera: 'stopCamera',
  diagnostics: 'diagnostics'
} as const;

/**
 * The lease name the camera is held under.
 *
 * `turbowarp-multiview-pose` takes its MoveNet lease as `pose`, so acquiring under the same name
 * means the preview and the inference share one stream instead of opening the device twice.
 */
const cameraId = 'pose';

/**
 * The camera app's startup, menu, and camera acquisition.
 *
 * Opcodes here are the members' own, not the bundled ones: the build namespaces them when it writes
 * the SB3, so the expanded source stays readable against each extension's own documentation.
 *
 * The menu replaces the extension's built-in actions rather than adding to them, because this
 * application's operator has different work to do than opening a DSL file.
 */
export const cameraAppScripts: readonly Script[] = [
  script({x: 48, y: 48}, [
    whenFlagClicked(),
    block(`${shell}_showAppLoading`, {LABEL: text('カメラアプリを起動しています')}),
    block(`${titleMenu}_clearAppMenuActions`),
    block(`${titleMenu}_addAppMenuAction`, {
      ACTION: text(action.selectCamera),
      LABEL: text('カメラを使う')
    }),
    block(`${titleMenu}_addAppMenuAction`, {
      ACTION: text(action.stopCamera),
      LABEL: text('カメラを止める')
    }),
    block(`${titleMenu}_addAppMenuAction`, {
      ACTION: text(action.diagnostics),
      LABEL: text('動作状況を見る')
    }),
    block(`${cameraSource}_refreshCameraDevices`),
    block(`${shell}_hideAppLoading`),
    block(`${titleMenu}_showMenu`)
  ]),

  /**
   * Acquiring a camera.
   *
   * No device id is passed. Camera Source omits the constraint when the id is empty and takes the
   * default camera, and `enumerateDevices` reports empty ids and labels until the browser has
   * granted camera access, so selecting by id here would either pass an empty string or name a
   * device the operator cannot see.
   *
   * The two failures are kept apart because they need different actions. No camera in the list means
   * nothing is plugged in. A camera that is listed but does not start means access was refused.
   * Camera Source publishes no error reporter, so `camera running?` after the attempt is the only
   * signal that tells the truth about it.
   */
  script({x: 48, y: 360}, [
    block(`${titleMenu}_whenAppMenuActionSelected`, {}, {ACTION: action.selectCamera}),
    block(`${cameraSource}_refreshCameraDevices`),
    ifElse(
      equals(reporter(block(`${cameraSource}_cameraDeviceCount`)), text('0')),
      [
        block(`${shell}_showAppError`, {
          MESSAGE: text('カメラが見つかりません。接続を確認してください。'),
          DETAILS: text('{"cameraId":"pose"}')
        })
      ],
      [
        block(`${cameraSource}_startSharedCamera`, {
          CAMERA_ID: text(cameraId),
          DEVICE_ID: text('')
        }),
        ifElse(
          not(block(`${cameraSource}_isCameraRunning`, {CAMERA_ID: text(cameraId)})),
          [
            block(`${shell}_showAppError`, {
              MESSAGE: text('カメラを開始できませんでした。ブラウザのカメラ使用許可を確認してください。'),
              DETAILS: text('{"cameraId":"pose"}')
            })
          ],
          [
            block(`${cameraSource}_showCameraPreview`, {
              CAMERA_ID: text(cameraId),
              MIRRORED: text('true')
            }),
            block(`${shell}_showAppNotice`, {
              MESSAGE: reporter(
                join(
                  label('映像: ', block(`${cameraSource}_cameraFrameWidth`, {CAMERA_ID: text(cameraId)})),
                  label(' x ', block(`${cameraSource}_cameraFrameHeight`, {CAMERA_ID: text(cameraId)}))
                )
              )
            })
          ]
        )
      ]
    )
  ]),

  script({x: 48, y: 720}, [
    block(`${titleMenu}_whenAppMenuActionSelected`, {}, {ACTION: action.stopCamera}),
    block(`${cameraSource}_hideCameraPreview`, {CAMERA_ID: text(cameraId)}),
    block(`${cameraSource}_stopSharedCamera`, {CAMERA_ID: text(cameraId)}),
    block(`${shell}_showAppNotice`, {MESSAGE: text('カメラを止めました。')})
  ]),

  /** Both halves of readiness an operator can act on: the startup flags, and the live camera. */
  script({x: 48, y: 900}, [
    block(`${titleMenu}_whenAppMenuActionSelected`, {}, {ACTION: action.diagnostics}),
    block(`${shell}_showAppNotice`, {
      MESSAGE: reporter(
        join(
          label('起動時の機能設定: ', block(`${shell}_appFeatureFlagState`)),
          label(
            ' / 解像度: ',
            block(`${cameraSource}_cameraFrameWidth`, {CAMERA_ID: text(cameraId)})
          )
        )
      )
    })
  ])
];

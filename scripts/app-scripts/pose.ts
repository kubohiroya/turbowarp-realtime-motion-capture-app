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
  type NamedReference,
  type Script
} from '../../packages/sb3-script/src/blocks.ts';
import {
  add,
  broadcastMessageAndWait,
  changeVariable,
  equals,
  greaterThan,
  ifElse,
  ifThen,
  join,
  not,
  or,
  repeatUntil,
  setVariable
} from '../../packages/sb3-script/src/standard.ts';

/**
 * M-09: estimate 2D poses on the camera app and stream them to the fusion app.
 *
 * MoveNet MultiPose, WebGPU, tracking and the `twrmc/pose-frame-2d` document belong to
 * `turbowarp-realtime-motion-capture`. These scripts decide when a pipeline may run — a fitting lens
 * profile, a running camera and a live connection to the fusion app — drive one inference after
 * another, hand each frame to a latest-data channel that drops rather than queues, and show what the
 * pipeline is doing.
 */

const motionCapture = 'kubohiroyarealtimemotioncapture';
const webrtc = 'kubohiroyawebrtc';
const cameraSource = 'kubohiroyacamerasource';

/** The latest-data channel both apps name. */
export const poseChannel = 'pose';
/**
 * Bytes a pose channel may hold unsent before a new frame is dropped instead.
 *
 * Six people with seventeen keypoints serialise to about 6 KB, so this admits roughly two frames in
 * flight. Anything more would be a queue, and a queue of poses is latency the fusion app cannot see.
 */
export const poseHighWaterMarkBytes = 16_384;
/** Flag names from the contract extension, as the app shell reports them. */
export const poseFeatureFlag = 'webgpuMoveNetMultiPose';

const mc = (opcode: string, inputs: Readonly<Record<string, InputValue>> = {}) =>
  block(`${motionCapture}_${opcode}`, inputs);
const mcValue = (opcode: string, inputs: Readonly<Record<string, InputValue>> = {}) =>
  reporter(mc(opcode, inputs));

const concatenate = (first: InputValue, ...rest: readonly InputValue[]): InputValue =>
  rest.reduce((left, right) => reporter(join(left, right)), first);

const timer = (): InputValue => reporter(block('sensing_timer'));
const round = (value: InputValue): InputValue => reporter(block('operator_round', {NUM: value}));
const subtract = (left: InputValue, right: InputValue): InputValue =>
  reporter(block('operator_subtract', {NUM1: left, NUM2: right}));
const multiply = (left: InputValue, right: InputValue): InputValue =>
  reporter(block('operator_multiply', {NUM1: left, NUM2: right}));
const divide = (left: InputValue, right: InputValue): InputValue =>
  reporter(block('operator_divide', {NUM1: left, NUM2: right}));
const lengthOf = (value: InputValue): InputValue =>
  reporter(block('operator_length', {STRING: value}));
const sum = (left: InputValue, right: InputValue): InputValue => reporter(add(left, right));

export const cameraPoseReferences = () => ({
  running: namedReference('pose running', 'variable:pose-running'),
  stopReason: namedReference('pose stop reason', 'variable:pose-stop-reason'),
  peer: namedReference('pose peer', 'variable:pose-peer'),
  localPeer: namedReference('pose local peer', 'variable:pose-local-peer'),
  frame: namedReference('pose frame', 'variable:pose-frame'),
  frames: namedReference('pose window frames', 'variable:pose-window-frames'),
  inferenceSeconds: namedReference(
    'pose window inference seconds',
    'variable:pose-window-inference-seconds'
  ),
  bytes: namedReference('pose window bytes', 'variable:pose-window-bytes'),
  windowStart: namedReference('pose window start', 'variable:pose-window-start'),
  inferenceStart: namedReference('pose inference start', 'variable:pose-inference-start'),
  sentBefore: namedReference('pose sent before', 'variable:pose-sent-before'),
  droppedBefore: namedReference('pose dropped before', 'variable:pose-dropped-before')
});

export type CameraPoseReferences = ReturnType<typeof cameraPoseReferences>;

const textVariables = new Set(['running', 'stopReason', 'peer', 'localPeer', 'frame']);

export const cameraPoseVariables = (r: CameraPoseReferences) =>
  Object.fromEntries(
    Object.entries(r).map(([key, reference]) => [
      reference.id,
      [reference.name, key === 'running' ? 'false' : textVariables.has(key) ? '' : 0]
    ])
  );

export function cameraPoseScripts(options: {
  readonly shell: string;
  readonly titleMenu: string;
  readonly cameraId: string;
  readonly references: CameraPoseReferences;
  readonly lensCalibrationReady: NamedReference;
  readonly pairingSession: string;
  readonly pairingExtension: string;
  readonly startAction: string;
  readonly stopAction: string;
  readonly menuActionsRequested: NamedReference;
  readonly position: {x: number; y: number};
}): Script[] {
  const {shell, titleMenu, cameraId, references: r} = options;
  const notice = (message: InputValue) => block(`${shell}_showAppNotice`, {MESSAGE: message});
  const error = (message: InputValue, code: string) =>
    block(`${shell}_showAppError`, {MESSAGE: message, DETAILS: text(JSON.stringify({code}))});
  const pairingValue = (opcode: string) =>
    reporter(block(`${options.pairingExtension}_${opcode}`, {SESSION: text(options.pairingSession)}));
  const connected = () =>
    equals(reporter(block(`${webrtc}_connectionState`, {PEER: variable(r.peer)})), text('connected'));
  const channelArgs = () => ({CHANNEL: text(poseChannel), PEER: variable(r.peer)});
  const sentCount = () => reporter(block(`${webrtc}_latestDataSentCount`, channelArgs()));
  const droppedCount = () => reporter(block(`${webrtc}_latestDataDroppedCount`, channelArgs()));
  const json = (value: InputValue, path: string) =>
    reporter(block(`${shell}_jsonValueAt`, {JSON: value, PATH: text(path)}));
  const menu = (action: string) =>
    block(`${titleMenu}_whenAppMenuActionSelected`, {}, {ACTION: action});
  const elapsed = () => subtract(timer(), variable(r.windowStart));

  const resetWindow = (): BlockNode[] => [
    setVariable(r.windowStart, timer()),
    setVariable(r.frames, number(0)),
    setVariable(r.inferenceSeconds, number(0)),
    setVariable(r.bytes, number(0)),
    setVariable(r.sentBefore, sentCount()),
    setVariable(r.droppedBefore, droppedCount())
  ];

  /**
   * Reports the last second. Drops and sends are read from the channel's own counters rather than
   * counted here, because only the channel knows which frames it refused.
   */
  const reportWindow = (): BlockNode =>
    notice(
      concatenate(
        text('姿勢推定中 — 人数: '),
        json(variable(r.frame), 'persons.length'),
        text(' / FPS: '),
        round(divide(variable(r.frames), elapsed())),
        // Measured across the awaited block, so it includes waiting for the next VM frame as well
        // as the inference itself. Named for what it is, not for the part of it that is inference.
        text(' / 推論1回（フレーム待ちを含む）: '),
        round(multiply(divide(variable(r.inferenceSeconds), variable(r.frames)), number(1000))),
        text(' ms / 送信: '),
        subtract(sentCount(), variable(r.sentBefore)),
        text(' 件 / 破棄: '),
        subtract(droppedCount(), variable(r.droppedBefore)),
        text(' 件 / 送信量: '),
        round(divide(divide(variable(r.bytes), number(1024)), elapsed())),
        text(' KB/s / seq: '),
        json(variable(r.frame), 'sequence')
      )
    );

  const start = script(options.position, [
    menu(options.startAction),
    block(`${titleMenu}_clearAppMenuActions`),
    broadcastMessageAndWait(options.menuActionsRequested),
    setVariable(r.peer, pairingValue('pairingRemotePeer')),
    setVariable(r.localPeer, pairingValue('pairingLocalPeer')),
    ifElse(
      not(block(`${shell}_appFeatureEnabled`, {FEATURE: text(poseFeatureFlag)})),
      [error(text('この配布物では姿勢推定が無効です。'), 'POSE_DISABLED')],
      [
        ifElse(
          equals(variable(r.running), text('true')),
          [notice(text('姿勢推定はすでに動いています。'))],
          [
            ifElse(
              not(block(`${cameraSource}_isCameraRunning`, {CAMERA_ID: text(cameraId)})),
              [error(text('先に「カメラを選ぶ」でカメラを選んでください。'), 'CAMERA_NOT_RUNNING')],
              [
                ifElse(
                  not(equals(variable(options.lensCalibrationReady), text('true'))),
                  [
                    error(
                      text('レンズ校正が適用されていないため、姿勢推定を始められません。先にレンズ校正を済ませてください。'),
                      'LENS_UNCALIBRATED'
                    )
                  ],
                  [
                    ifElse(
                      or(equals(variable(r.peer), text('')), not(connected())),
                      [
                        error(
                          text('統合アプリと接続していないため、姿勢推定を始めません。先に「統合アプリと接続する」を選んでください。'),
                          'POSE_NOT_CONNECTED'
                        )
                      ],
                      runPipeline()
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

  function runPipeline(): BlockNode[] {
    return [
      setVariable(r.running, text('true')),
      setVariable(r.stopReason, text('')),
      block(`${shell}_showAppLoading`, {LABEL: text('MoveNetを読み込んでいます')}),
      mc('startWebGpuMoveNetMultiPose', {
        CALIBRATION_ID: json(
          reporter(block(`${cameraSource}_cameraProfileJson`, {CAMERA_ID: text(cameraId)})),
          'profileId'
        ),
        CAMERA_ID: text(cameraId),
        PEER_ID: variable(r.localPeer)
      }),
      block(`${shell}_hideAppLoading`),
      ifElse(
        not(equals(mcValue('posePipelineState'), text('ready'))),
        [
          setVariable(r.running, text('false')),
          error(
            concatenate(
              text('姿勢推定を開始できませんでした（'),
              mcValue('poseErrorCode'),
              text('）: '),
              mcValue('poseError')
            ),
            'POSE_START_FAILED'
          )
        ],
        [
          notice(text('姿勢推定を開始しました。統合アプリへ送信しています。')),
          block(`${options.titleMenu}_showMenu`),
          ...resetWindow(),
          repeatUntil(not(equals(variable(r.running), text('true'))), [
            ifElse(
              not(connected()),
              [setVariable(r.running, text('false')), setVariable(r.stopReason, text('disconnected'))],
              [
                setVariable(r.inferenceStart, timer()),
                mc('inferNextPoseFrame', {
                  CAPTURE_TIMESTAMP_US: round(reporter(block(`${webrtc}_localTime`)))
                }),
                ifElse(
                  equals(mcValue('posePipelineState'), text('error')),
                  [setVariable(r.running, text('false')), setVariable(r.stopReason, text('error'))],
                  [
                    setVariable(
                      r.inferenceSeconds,
                      sum(variable(r.inferenceSeconds), subtract(timer(), variable(r.inferenceStart)))
                    ),
                    changeVariable(r.frames, 1),
                    setVariable(r.frame, mcValue('latestPoseFrame2D')),
                    ifThen(not(equals(variable(r.frame), text(''))), [
                      block(`${webrtc}_sendLatestData`, {
                        PAYLOAD: variable(r.frame),
                        CHANNEL: text(poseChannel),
                        PEER: variable(r.peer)
                      }),
                      setVariable(r.bytes, sum(variable(r.bytes), lengthOf(variable(r.frame))))
                    ]),
                    ifThen(greaterThan(elapsed(), number(1)), [reportWindow(), ...resetWindow()])
                  ]
                )
              ]
            )
          ]),
          mc('stopWebGpuMoveNetMultiPose'),
          ifElse(
            equals(variable(r.stopReason), text('disconnected')),
            [error(text('統合アプリとの接続が切れたため、姿勢推定を止めました。'), 'POSE_DISCONNECTED')],
            [
              ifElse(
                equals(variable(r.stopReason), text('error')),
                [
                  error(
                    concatenate(
                      text('姿勢推定が止まりました（'),
                      mcValue('poseErrorCode'),
                      text('）: '),
                      mcValue('poseError')
                    ),
                    'POSE_FAILED'
                  )
                ],
                [notice(text('姿勢推定を止めました。'))]
              )
            ]
          )
        ]
      )
    ];
  }

  const stop = script({x: options.position.x, y: options.position.y + 2400}, [
    menu(options.stopAction),
    block(`${titleMenu}_clearAppMenuActions`),
    broadcastMessageAndWait(options.menuActionsRequested),
    ifElse(
      equals(variable(r.running), text('true')),
      [setVariable(r.running, text('false'))],
      [notice(text('姿勢推定は動いていません。'))]
    ),
    block(`${titleMenu}_showMenu`)
  ]);

  return [start, stop];
}

// Fusion app ---------------------------------------------------------------

/** Readies the pose channel for one camera app before its offer is created. */
export function fusionPoseChannelSetup(peer: InputValue): BlockNode[] {
  return [
    block(`${webrtc}_setLatestDataEnabled`, {ENABLED: text('true')}),
    block(`${webrtc}_configureLatestDataChannel`, {
      CHANNEL: text(poseChannel),
      HIGH_WATER_MARK: number(poseHighWaterMarkBytes),
      PEER: peer
    })
  ];
}

/**
 * One line per camera app that has sent poses: how many, how fresh, and what the newest one holds.
 * Receiving is only shown here; using the frames is M-10.
 */
export function fusionPoseSummary(options: {
  readonly shell: string;
  readonly index: NamedReference;
  readonly peer: NamedReference;
  readonly summary: NamedReference;
}): BlockNode[] {
  const {shell} = options;
  const peers = reporter(block(`${shell}_latestDataPeers`, {CHANNEL: text(poseChannel)}));
  const at = (json: InputValue, path: InputValue) =>
    reporter(block(`${shell}_jsonValueAt`, {JSON: json, PATH: path}));
  const payload = () =>
    reporter(block(`${shell}_latestDataPayload`, {CHANNEL: text(poseChannel), PEER: variable(options.peer)}));
  const indexText = () => reporter(join(variable(options.index), text('')));
  return [
    setVariable(options.summary, text('')),
    setVariable(options.index, number(0)),
    repeatUntil(equals(at(peers, indexText()), text('')), [
      setVariable(options.peer, at(peers, indexText())),
      setVariable(
        options.summary,
        concatenate(
          variable(options.summary),
          variable(options.peer),
          text(': '),
          reporter(block(`${shell}_latestDataReceivedCount`, {CHANNEL: text(poseChannel), PEER: variable(options.peer)})),
          text('件 / 最新 '),
          reporter(block(`${shell}_latestDataAgeMs`, {CHANNEL: text(poseChannel), PEER: variable(options.peer)})),
          text(' ms前 / seq '),
          at(payload(), text('sequence')),
          text(' / 人数 '),
          at(payload(), text('persons.length')),
          text(' / calibration '),
          at(payload(), text('calibrationId')),
          text('。 ')
        )
      ),
      changeVariable(options.index, 1)
    ])
  ];
}

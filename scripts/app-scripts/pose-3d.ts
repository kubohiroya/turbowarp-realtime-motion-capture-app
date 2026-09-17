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
  changeVariable,
  equals,
  greaterThan,
  ifElse,
  ifThen,
  itemOfList,
  join,
  lengthOfList,
  not,
  repeat,
  repeatUntil,
  setVariable
} from '../../packages/sb3-script/src/standard.ts';
import {poseChannel} from './pose.ts';
import {referenceId, timeSpaceSync} from './space-time.ts';

/**
 * M-10: forward every camera's 2D poses to the 3D pose service and show what comes back.
 *
 * The service runs in a Worker behind the `realtimemotioncapturepose3dservice` extension. These
 * scripts configure it from the space-time calibration, forward each camera's newest frame, ask for
 * the 3D pose, and show the service's state. They implement no alignment, association or
 * triangulation themselves (#11); the service does (#34).
 */

export const pose3dService = 'realtimemotioncapturepose3dservice';
export const external3dServiceFlag = 'external3dServiceV1';
/**
 * The implementation the apps ask for: `fusion-v0`, which aligns the cameras in time, associates the
 * people they report and triangulates their joints (#34, stage 3). Every figure shown names it, so a
 * later implementation — or a stub — cannot be mistaken for this one.
 */
export const serviceImplementation = 'fusion-v0';

const service = (opcode: string, inputs: Readonly<Record<string, InputValue>> = {}) =>
  block(`${pose3dService}_${opcode}`, inputs);
const serviceValue = (opcode: string) => reporter(service(opcode));

const concatenate = (first: InputValue, ...rest: readonly InputValue[]): InputValue =>
  rest.reduce((left, right) => reporter(join(left, right)), first);

/**
 * Configures the service from the space-time calibration and applies it.
 *
 * `spaceTimeResults` holds `{peer, payload}` items as `measureSpaceTimeSteps` produced them; every
 * measured camera is added under its `peer` name with its camera model, the solved placement and its
 * time correspondence. Shared by the fusion app, whose items come from camera apps, and the local app,
 * whose items are its own cameras.
 */
export function configurePose3dServiceSteps(options: {
  readonly shell: string;
  readonly spaceTimeResults: NamedReference;
  readonly index: NamedReference;
  readonly item: NamedReference;
}): BlockNode[] {
  const json = (value: InputValue, path: string) =>
    reporter(block(`${options.shell}_jsonValueAt`, {JSON: value, PATH: text(path)}));
  const payload = () => json(variable(options.item), 'payload');
  return [
    service('beginConfiguration', {IMPLEMENTATION: text(serviceImplementation), REFERENCE_ID: text(referenceId)}),
    setVariable(options.index, number(0)),
    repeat(reporter(lengthOfList(options.spaceTimeResults)), [
      changeVariable(options.index, 1),
      setVariable(options.item, reporter(itemOfList(variable(options.index), options.spaceTimeResults))),
      ifThen(equals(json(payload(), 'status'), text('measured')), [
        service('addCamera', {
          CAMERA_ID: json(variable(options.item), 'peer'),
          MODEL_JSON: json(payload(), 'cameraModel'),
          PLACEMENT_JSON: reporter(block(`${timeSpaceSync}_placementResultJson`)),
          TIME_JSON: json(payload(), 'correspondence')
        })
      ])
    ]),
    service('applyConfiguration')
  ];
}

/** The service's own state and counters, always naming the implementation. */
export function pose3dStatusText(shell: string): InputValue {
  const json = (path: string) =>
    reporter(block(`${shell}_jsonValueAt`, {JSON: serviceValue('serviceStatusJson'), PATH: text(path)}));
  return concatenate(
    text('3D統合（'),
    json('implementation'),
    text('）— 人数: '),
    json('persons'),
    text(' / RTT: '),
    json('rttMs'),
    text(' ms / 3D経過: '),
    json('poseAgeMs'),
    text(' ms / 送信: '),
    json('framesSent'),
    text(' / 古いフレーム: '),
    json('framesStale'),
    text(' / 不正: '),
    json('framesInvalid'),
    text(' / 拒否: '),
    json('framesRejected')
  );
}

export const fusionPose3dReferences = () => ({
  running: namedReference('3D running', 'variable:3d-running'),
  index: namedReference('3D index', 'variable:3d-index'),
  peer: namedReference('3D peer', 'variable:3d-peer'),
  item: namedReference('3D item', 'variable:3d-item'),
  cameras: namedReference('3D camera ages', 'variable:3d-camera-ages'),
  windowStart: namedReference('3D window start', 'variable:3d-window-start')
});

export type FusionPose3dReferences = ReturnType<typeof fusionPose3dReferences>;

export const fusionPose3dVariables = (r: FusionPose3dReferences) => ({
  [r.running.id]: [r.running.name, 'false'],
  [r.index.id]: [r.index.name, 0],
  [r.peer.id]: [r.peer.name, ''],
  [r.item.id]: [r.item.name, ''],
  [r.cameras.id]: [r.cameras.name, ''],
  [r.windowStart.id]: [r.windowStart.name, 0]
});

export function fusionPose3dScripts(options: {
  readonly shell: string;
  readonly titleMenu: string;
  readonly references: FusionPose3dReferences;
  readonly spaceTimeReady: NamedReference;
  readonly spaceTimeResults: NamedReference;
  readonly startAction: string;
  readonly stopAction: string;
  readonly position: {x: number; y: number};
}): Script[] {
  const {shell, titleMenu, references: r} = options;
  const notice = (message: InputValue) => block(`${shell}_showAppNotice`, {MESSAGE: message});
  const error = (message: InputValue, code: string) =>
    block(`${shell}_showAppError`, {MESSAGE: message, DETAILS: text(JSON.stringify({code}))});
  const json = (value: InputValue, path: string | InputValue) =>
    reporter(block(`${shell}_jsonValueAt`, {JSON: value, PATH: typeof path === 'string' ? text(path) : path}));
  const timer = () => reporter(block('sensing_timer'));
  const channel = () => text(poseChannel);
  const peers = () => reporter(block(`${shell}_latestDataPeers`, {CHANNEL: channel()}));
  const indexText = () => reporter(join(variable(r.index), text('')));
  const status = () => serviceValue('serviceStatusJson');
  const payload = () => json(variable(r.item), 'payload');

  /** Walks the cameras that have sent poses, in name order. */
  const forEachSendingCamera = (body: BlockNode[]): BlockNode[] => [
    setVariable(r.index, number(0)),
    repeatUntil(equals(json(peers(), indexText()), text('')), [
      setVariable(r.peer, json(peers(), indexText())),
      ...body,
      changeVariable(r.index, 1)
    ])
  ];

  const configure = (): BlockNode[] =>
    configurePose3dServiceSteps({shell, spaceTimeResults: options.spaceTimeResults, index: r.index, item: r.item});

  /**
   * One line for the operator: the service's own state and counters, and how old each camera's newest
   * pose is. The implementation is always named, so a stub result cannot be read as a measurement.
   */
  const dashboard = (): BlockNode[] => [
    setVariable(r.cameras, text('')),
    ...forEachSendingCamera([
      setVariable(
        r.cameras,
        concatenate(
          variable(r.cameras),
          variable(r.peer),
          text(' '),
          reporter(block(`${shell}_latestDataAgeMs`, {CHANNEL: channel(), PEER: variable(r.peer)})),
          text('ms前 ')
        )
      )
    ]),
    ifElse(
      equals(serviceValue('serviceState'), text('ready')),
      [
        notice(
          concatenate(
            text('3D統合（'),
            json(status(), 'implementation'),
            text('）— 人数: '),
            json(status(), 'persons'),
            text(' / RTT: '),
            json(status(), 'rttMs'),
            text(' ms / 3D経過: '),
            json(status(), 'poseAgeMs'),
            text(' ms / 送信: '),
            json(status(), 'framesSent'),
            text(' / 古いフレーム: '),
            json(status(), 'framesStale'),
            text(' / 不正: '),
            json(status(), 'framesInvalid'),
            text(' / 拒否: '),
            json(status(), 'framesRejected'),
            text(' / 2D: '),
            variable(r.cameras)
          )
        )
      ],
      [
        error(
          concatenate(
            text('3D出力を停止中です（'),
            serviceValue('serviceState'),
            text('）: '),
            serviceValue('serviceError'),
            text(' / 2D: '),
            variable(r.cameras)
          ),
          'POSE_3D_WITHHELD'
        )
      ]
    )
  ];

  const start = script(options.position, [
    block(`${titleMenu}_whenAppMenuActionSelected`, {}, {ACTION: options.startAction}),
    ifElse(
      not(block(`${shell}_appFeatureEnabled`, {FEATURE: text(external3dServiceFlag)})),
      [error(text('この配布物では3Dサービスとの連携が無効です。'), 'POSE_3D_DISABLED')],
      [
        ifElse(
          equals(variable(r.running), text('true')),
          [notice(text('3D統合はすでに動いています。'))],
          [
            ifElse(
              not(equals(variable(options.spaceTimeReady), text('true'))),
              [
                error(
                  text('空間と時刻の校正がREADYではありません。先に「空間と時刻を校正する」を済ませてください。'),
                  'POSE_3D_NOT_CALIBRATED'
                )
              ],
              [
                block(`${shell}_showAppLoading`, {LABEL: text('3Dサービスを準備しています')}),
                ...configure(),
                block(`${shell}_hideAppLoading`),
                ifElse(
                  not(equals(serviceValue('serviceState'), text('ready'))),
                  [
                    error(
                      concatenate(text('3Dサービスを開始できませんでした: '), serviceValue('serviceError')),
                      'POSE_3D_CONFIGURE_FAILED'
                    )
                  ],
                  [
                    setVariable(r.running, text('true')),
                    notice(concatenate(text('3D統合を開始しました（'), json(status(), 'implementation'), text('）。'))),
                    block(`${titleMenu}_showMenu`),
                    setVariable(r.windowStart, timer()),
                    repeatUntil(not(equals(variable(r.running), text('true'))), [
                      ...forEachSendingCamera([
                        service('sendPoseFrame', {
                          FRAME_JSON: reporter(block(`${shell}_latestDataPayload`, {CHANNEL: channel(), PEER: variable(r.peer)})),
                          CAMERA_ID: variable(r.peer),
                          AGE_MS: reporter(block(`${shell}_latestDataAgeMs`, {CHANNEL: channel(), PEER: variable(r.peer)}))
                        })
                      ]),
                      service('requestPose3d'),
                      ifThen(
                        greaterThan(reporter(block('operator_subtract', {NUM1: timer(), NUM2: variable(r.windowStart)})), number(1)),
                        [...dashboard(), setVariable(r.windowStart, timer())]
                      )
                    ]),
                    service('stopService'),
                    notice(text('3D統合を止めました。'))
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

  const stop = script({x: options.position.x, y: options.position.y + 2000}, [
    block(`${titleMenu}_whenAppMenuActionSelected`, {}, {ACTION: options.stopAction}),
    ifElse(
      equals(variable(r.running), text('true')),
      [setVariable(r.running, text('false'))],
      [notice(text('3D統合は動いていません。'))]
    ),
    block(`${titleMenu}_showMenu`)
  ]);

  return [start, stop];
}


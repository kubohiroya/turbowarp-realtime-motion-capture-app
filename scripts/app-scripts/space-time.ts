import {
  block,
  broadcast,
  condition,
  namedReference,
  number,
  reporter,
  text,
  variable,
  type BlockNode,
  type InputValue,
  type NamedReference
} from '../../packages/sb3-script/src/blocks.ts';
import {
  addToList,
  changeVariable,
  deleteAllOfList,
  equals,
  greaterThan,
  ifElse,
  ifThen,
  itemOfList,
  join,
  lengthOfList,
  lessThan,
  not,
  or,
  repeat,
  repeatUntil,
  setVariable,
  wait
} from '../../packages/sb3-script/src/standard.ts';

/**
 * M-08: calibrate time correspondence and camera placement from one projected pattern.
 *
 * The fusion app projects the time pattern. Every camera app decodes it — which yields the offset
 * from the projection's clock to that camera's frame timestamps — and measures the pattern's four
 * outer corners, which yields a placement observation. The operator measures the same four corners
 * on the wall once. The fusion app then solves where every camera stands and says READY only when
 * every figure clears its threshold.
 *
 * The estimators, the corner detector and the solve belong to `turbowarp-time-space-sync`. These
 * scripts carry messages, apply thresholds, and say what happened.
 */

export const timeSpaceSync = 'kubohiroyatimespacesync';
const webrtc = 'kubohiroyawebrtc';

export const syncStartMessage = 'twrmc-sync-start';
export const syncResultMessage = 'twrmc-sync-result';

/** The pattern with constant corner cells; only it has corners to measure. */
export const patternProfileId = 'twtss.pattern.v2';
export const referenceId = 'venue-projection';
export const rigId = 'venue';

/**
 * Quality thresholds for READY.
 *
 * Starting values, not measured ones: they are chosen to reject clearly broken runs and must be
 * revisited with the hardware records the M-08 test asks for. They are set before looking at
 * results so that a result is judged by them rather than the other way round.
 */
export const thresholds = {
  /** One 100 Hz camera frame. Anything looser cannot place a pose in the right frame. */
  maximumTimeUncertaintyUs: 10_000,
  /** The extension refuses a wider spread itself; kept here so READY states the same limit. */
  maximumCornerSpreadPx: 0.5,
  maximumReprojectionRmsPx: 2
} as const;

/** How long a camera measures the corners, beyond the decoder's own calibration. */
export const measureSeconds = 6;
/** Long enough for every camera's calibration, measurement and reply. */
export const replyTimeoutSeconds = 60;
/** Tape measurement, per corner. Recorded with the reference, not used to tighten anything. */
export const cornerSigmaMeters = 0.003;

const tss = (opcode: string, inputs: Readonly<Record<string, InputValue>> = {}) =>
  block(`${timeSpaceSync}_${opcode}`, inputs);
const tssValue = (opcode: string, inputs: Readonly<Record<string, InputValue>> = {}) =>
  reporter(tss(opcode, inputs));

const concatenate = (first: InputValue, ...rest: readonly InputValue[]): InputValue =>
  rest.reduce((left, right) => reporter(join(left, right)), first);

class Json {
  private readonly shell: string;

  public constructor(shell: string) {
    this.shell = shell;
  }

  public at(json: InputValue, path: string | InputValue): InputValue {
    return reporter(
      block(`${this.shell}_jsonValueAt`, {
        JSON: json,
        PATH: typeof path === 'string' ? text(path) : path
      })
    );
  }

  public withJson(json: InputValue, key: string, value: InputValue): InputValue {
    return reporter(block(`${this.shell}_jsonWithJsonField`, {JSON: json, KEY: text(key), VALUE: value}));
  }

  public withText(json: InputValue, key: string, value: InputValue): InputValue {
    return reporter(block(`${this.shell}_jsonWithTextField`, {JSON: json, KEY: text(key), VALUE: value}));
  }
}

const notice = (shell: string, message: InputValue) =>
  block(`${shell}_showAppNotice`, {MESSAGE: message});
const error = (shell: string, message: InputValue, code: string) =>
  block(`${shell}_showAppError`, {MESSAGE: message, DETAILS: text(JSON.stringify({code}))});

// Camera app ---------------------------------------------------------------

export const cameraSyncReferences = () => ({
  request: namedReference('space-time request', 'variable:space-time-request'),
  result: namedReference('space-time result', 'variable:space-time-result'),
  requested: namedReference('space-time requested', 'broadcast:space-time-requested')
});

export type CameraSyncReferences = ReturnType<typeof cameraSyncReferences>;

export const cameraSyncVariables = (references: CameraSyncReferences) => ({
  [references.request.id]: [references.request.name, ''],
  [references.result.id]: [references.result.name, '']
});

export const cameraSyncBroadcasts = (references: CameraSyncReferences) => ({
  [references.requested.id]: references.requested.name
});

/** What the camera app's message dispatcher does with a start request. */
export const cameraSyncRoute = (references: CameraSyncReferences, message: NamedReference) => ({
  type: syncStartMessage,
  handle: [
    setVariable(references.request, variable(message)),
    block('event_broadcast', {BROADCAST_INPUT: broadcast(references.requested)})
  ]
});

/**
 * Measures one camera against the time pattern on show, and leaves the outcome in `result`.
 *
 * The outcome is `{status: "measured", correspondence, observation, cornerSpreadPx, cameraModel,
 * decodeRate}` or `{status: "failed", error}`. The decoder is stopped afterwards either way, so the
 * next camera can be measured with the same pattern still up. Shared by the camera app, which measures
 * its one camera on the fusion app's request, and the local app, which measures each of its cameras
 * in turn.
 */
export function measureSpaceTimeSteps(options: {
  readonly shell: string;
  readonly cameraId: InputValue;
  readonly referenceId: InputValue;
  readonly refreshUs: InputValue;
  readonly measureSeconds: InputValue;
  readonly result: NamedReference;
}): BlockNode[] {
  const json = new Json(options.shell);
  const result = variable(options.result);
  const failWith = (code: InputValue): BlockNode =>
    setVariable(
      options.result,
      json.withText(json.withText(text('{}'), 'status', text('failed')), 'error', code)
    );
  return [
    tss('stopOpticalTimeDecoder'),
    tss('setTimePatternProfile', {PROFILE_ID: text(patternProfileId)}),
    tss('startOpticalTimeDecoder', {
      CAMERA_ID: options.cameraId,
      REFERENCE_ID: options.referenceId,
      SECONDS: reporter(
        block('operator_add', {
          NUM1: tssValue('opticalTimeMinimumCalibrationSeconds'),
          NUM2: number(1)
        })
      ),
      REFRESH_US: options.refreshUs
    }),
    ifElse(
      not(equals(tssValue('opticalTimeDecoderState'), text('ready'))),
      [failWith(concatenate(text('decoder:'), tssValue('opticalTimeDecoderError')))],
      [
        tss('measurePatternCorners', {SECONDS: options.measureSeconds}),
        tss('estimateTimeCorrespondence'),
        ifElse(
          not(equals(tssValue('patternCornerError'), text(''))),
          [failWith(concatenate(text('corners:'), tssValue('patternCornerError')))],
          [
            ifElse(
              not(equals(tssValue('timeCorrespondenceError'), text(''))),
              [failWith(concatenate(text('time:'), tssValue('timeCorrespondenceError')))],
              [
                setVariable(options.result, json.withText(text('{}'), 'status', text('measured'))),
                setVariable(
                  options.result,
                  json.withJson(result, 'correspondence', tssValue('timeCorrespondenceJson'))
                ),
                setVariable(
                  options.result,
                  json.withJson(result, 'observation', tssValue('patternCornerObservationJson'))
                ),
                setVariable(
                  options.result,
                  json.withJson(result, 'cornerSpreadPx', tssValue('patternCornerSpreadPx'))
                ),
                setVariable(
                  options.result,
                  json.withJson(
                    result,
                    'cameraModel',
                    tssValue('cameraModelJson', {CAMERA_ID: options.cameraId})
                  )
                ),
                setVariable(
                  options.result,
                  json.withJson(result, 'decodeRate', tssValue('opticalTimeDecodeRate'))
                )
              ]
            )
          ]
        )
      ]
    ),
    tss('stopOpticalTimeDecoder')
  ];
}

/**
 * Measures on request and always answers.
 *
 * A camera that cannot measure still replies, with the reason, so the fusion app can name the camera
 * that failed instead of waiting out its timeout and reporting silence.
 */
export function cameraSyncSteps(options: {
  readonly shell: string;
  readonly cameraId: string;
  readonly references: CameraSyncReferences;
  readonly lensCalibrationReady: NamedReference;
}): BlockNode[] {
  const {shell, cameraId, references} = options;
  const json = new Json(shell);
  const request = variable(references.request);
  const result = variable(references.result);
  const failWith = (code: InputValue): BlockNode =>
    setVariable(
      references.result,
      json.withText(json.withText(text('{}'), 'status', text('failed')), 'error', code)
    );
  return [
    ifElse(
      not(equals(variable(options.lensCalibrationReady), text('true'))),
      [failWith(text('lens-uncalibrated'))],
      [
        notice(
          shell,
          text('統合アプリの投影パターンで、時刻と配置を校正しています。カメラを動かさないでください。')
        ),
        ...measureSpaceTimeSteps({
          shell,
          cameraId: text(cameraId),
          referenceId: json.at(request, 'payload.referenceId'),
          refreshUs: json.at(request, 'payload.refreshUs'),
          measureSeconds: json.at(request, 'payload.measureSeconds'),
          result: references.result
        })
      ]
    ),
    block(`${webrtc}_broadcastNetworkMessage`, {
      MESSAGE: text(syncResultMessage),
      PAYLOAD: result,
      CHANNEL: text('default'),
      PEER: text('*')
    }),
    ifElse(
      equals(json.at(result, 'status'), text('measured')),
      [
        notice(
          shell,
          concatenate(
            text('校正の測定結果を統合アプリへ送りました。時刻の不確かさ: '),
            json.at(result, 'correspondence.uncertaintyUs'),
            text(' µs / 四隅のばらつき: '),
            json.at(result, 'cornerSpreadPx'),
            text(' px')
          )
        )
      ],
      [
        error(
          shell,
          concatenate(
            text('校正の測定に失敗し、その理由を統合アプリへ送りました: '),
            json.at(result, 'error'),
            text('。レンズ校正が済んでいるか、投影パターン全体がカメラに写っているかを確認してください。')
          ),
          'SPACE_TIME_MEASUREMENT_FAILED'
        )
      ]
    )
  ];
}

// Fusion app ---------------------------------------------------------------

export const fusionSyncReferences = () => ({
  results: namedReference('space-time results', 'list:space-time-results'),
  expected: namedReference('space-time expected cameras', 'variable:space-time-expected-cameras'),
  waited: namedReference('space-time wait', 'variable:space-time-wait'),
  corners: namedReference('space-time measured corners', 'variable:space-time-measured-corners'),
  referenceJson: namedReference('space-time reference', 'variable:space-time-reference'),
  index: namedReference('space-time index', 'variable:space-time-index'),
  item: namedReference('space-time item', 'variable:space-time-item'),
  peer: namedReference('space-time peer', 'variable:space-time-peer'),
  failures: namedReference('space-time failures', 'variable:space-time-failures'),
  ready: namedReference('space-time ready', 'variable:space-time-ready')
});

export type FusionSyncReferences = ReturnType<typeof fusionSyncReferences>;

export const fusionSyncVariables = (references: FusionSyncReferences) => ({
  [references.expected.id]: [references.expected.name, 0],
  [references.waited.id]: [references.waited.name, 0],
  [references.corners.id]: [references.corners.name, ''],
  [references.referenceJson.id]: [references.referenceJson.name, ''],
  [references.index.id]: [references.index.name, 0],
  [references.item.id]: [references.item.name, ''],
  [references.peer.id]: [references.peer.name, ''],
  [references.failures.id]: [references.failures.name, ''],
  [references.ready.id]: [references.ready.name, 'false']
});

export const fusionSyncLists = (references: FusionSyncReferences) => ({
  [references.results.id]: [references.results.name, []]
});

/** What the fusion app's message dispatcher does with a camera's reply. */
export const fusionSyncRoute = (references: FusionSyncReferences, message: NamedReference) => ({
  type: syncResultMessage,
  handle: [addToList(variable(message), references.results)]
});

const cornerFields =
  '左上 x (m),左上 y (m);右上 x (m),右上 y (m);右下 x (m),右下 y (m);左下 x (m),左下 y (m)';

export function fusionSyncSteps(options: {
  readonly shell: string;
  readonly references: FusionSyncReferences;
}): BlockNode[] {
  const {shell, references: r} = options;
  const json = new Json(shell);
  const item = variable(r.item);
  const peer = variable(r.peer);
  const payload = json.at(item, 'payload');
  const addFailure = (reason: InputValue): BlockNode =>
    setVariable(r.failures, concatenate(variable(r.failures), peer, text(': '), reason, text(' / ')));
  const connectedCount = json.at(reporter(block(`${webrtc}_connectedPeers`)), 'length');
  const forEachResult = (body: BlockNode[]): BlockNode[] => [
    setVariable(r.index, number(0)),
    repeat(reporter(lengthOfList(r.results)), [
      changeVariable(r.index, 1),
      setVariable(r.item, reporter(itemOfList(variable(r.index), r.results))),
      setVariable(r.peer, json.at(item, 'peer')),
      ...body
    ])
  ];

  return [
    setVariable(r.ready, text('false')),
    ifElse(
      or(equals(connectedCount, text('')), equals(connectedCount, text('0'))),
      [
        error(
          shell,
          text('接続中のカメラアプリがありません。先に「カメラアプリと接続する」で接続してください。'),
          'SPACE_TIME_NO_CAMERAS'
        )
      ],
      [
        block(`${shell}_askConfirmation`, {
          MESSAGE: text(
            'これから時刻パターンを全画面に投影します。パターンは毎秒何十回も明滅します。光過敏の方が投影を見ないよう、観客や作業者に知らせてから表示してください。表示中はEscキーで消せます。'
          ),
          CONFIRM: text('投影する'),
          CANCEL: text('やめる')
        }),
        ifElse(
          not(block(`${shell}_confirmationAccepted`)),
          [notice(shell, text('空間と時刻の校正をやめました。'))],
          [
            tss('acknowledgePatternFlashing'),
            tss('setTimePatternProfile', {PROFILE_ID: text(patternProfileId)}),
            tss('showTimePattern'),
            setVariable(r.waited, number(0)),
            repeatUntil(or(tss('timePatternStable'), greaterThan(variable(r.waited), number(50))), [
              wait(0.1),
              changeVariable(r.waited, 1)
            ]),
            deleteAllOfList(r.results),
            setVariable(r.expected, connectedCount),
            block(`${webrtc}_broadcastNetworkMessage`, {
              MESSAGE: text(syncStartMessage),
              PAYLOAD: json.withJson(
                json.withJson(
                  json.withText(text('{}'), 'referenceId', text(referenceId)),
                  'refreshUs',
                  tssValue('timePatternRefreshUs')
                ),
                'measureSeconds',
                text(String(measureSeconds))
              ),
              CHANNEL: text('default'),
              PEER: text('*')
            }),
            setVariable(r.waited, number(0)),
            repeatUntil(
              or(
                not(lessThan(reporter(lengthOfList(r.results)), variable(r.expected))),
                or(
                  greaterThan(variable(r.waited), number(replyTimeoutSeconds * 10)),
                  not(tss('timePatternShown'))
                )
              ),
              [wait(0.1), changeVariable(r.waited, 1)]
            ),
            tss('hideTimePattern'),
            ...stepsAfterReplies(shell, r, json, {item, peer, payload, addFailure, forEachResult})
          ]
        )
      ]
    )
  ];
}

/**
 * Solves placement from the measurements in `results` and says READY or why not.
 *
 * Each item is `{peer, payload}`, where `payload` is what `measureSpaceTimeSteps` produced for the
 * camera named `peer`. `expected` holds how many items there should be. Shared by the fusion app,
 * whose items arrive from camera apps, and the local app, which measures its own cameras.
 */
export function spaceTimeSolveSteps(shell: string, r: FusionSyncReferences): BlockNode[] {
  const json = new Json(shell);
  const item = variable(r.item);
  const peer = variable(r.peer);
  const payload = json.at(item, 'payload');
  const addFailure = (reason: InputValue): BlockNode =>
    setVariable(r.failures, concatenate(variable(r.failures), peer, text(': '), reason, text(' / ')));
  const forEachResult = (body: BlockNode[]): BlockNode[] => [
    setVariable(r.index, number(0)),
    repeat(reporter(lengthOfList(r.results)), [
      changeVariable(r.index, 1),
      setVariable(r.item, reporter(itemOfList(variable(r.index), r.results))),
      setVariable(r.peer, json.at(item, 'peer')),
      ...body
    ])
  ];
  return stepsAfterReplies(shell, r, json, {item, peer, payload, addFailure, forEachResult});
}

function stepsAfterReplies(
  shell: string,
  r: FusionSyncReferences,
  json: Json,
  parts: {
    item: InputValue;
    peer: InputValue;
    payload: InputValue;
    addFailure: (reason: InputValue) => BlockNode;
    forEachResult: (body: BlockNode[]) => BlockNode[];
  }
): BlockNode[] {
  const {peer, payload, addFailure, forEachResult} = parts;
  const measured = equals(json.at(payload, 'status'), text('measured'));
  return [
    ifElse(
      lessThan(reporter(lengthOfList(r.results)), variable(r.expected)),
      [
        error(
          shell,
          concatenate(
            text('一部のカメラアプリから校正結果が届きませんでした（'),
            reporter(lengthOfList(r.results)),
            text(' / '),
            variable(r.expected),
            text('台）。投影を止めたか、接続が切れた可能性があります。もう一度校正してください。')
          ),
          'SPACE_TIME_REPLIES_MISSING'
        )
      ],
      [
        block(`${shell}_askNumbers`, {
          TITLE: text(
            '投影したパターンの外側の四隅を、壁の上で巻尺などで測った位置を入力してください（メートル）。左上の角を原点とし、右向きをx、下向きをyにします。'
          ),
          FIELDS: text(cornerFields),
          DEFAULTS: variable(r.corners)
        }),
        ifElse(
          equals(reporter(block(`${shell}_answeredNumbers`)), text('')),
          [notice(shell, text('四隅の入力をやめたため、配置は校正していません。'))],
          [
            setVariable(r.corners, reporter(block(`${shell}_answeredNumbers`))),
            setVariable(
              r.referenceJson,
              tssValue('patternReferenceJson', {
                REFERENCE_ID: text(referenceId),
                CORNERS: variable(r.corners),
                SIGMA_METERS: number(cornerSigmaMeters),
                MEASURED_BY: text('tape')
              })
            ),
            setVariable(r.failures, text('')),
            tss('clearPlacement'),
            tss('defineReference', {REFERENCE_JSON: variable(r.referenceJson)}),
            ...forEachResult([
              ifElse(
                not(measured),
                [addFailure(concatenate(text('測定失敗 '), json.at(payload, 'error')))],
                [
                  tss('setCameraModel', {CAMERA_ID: peer, MODEL_JSON: json.at(payload, 'cameraModel')}),
                  tss('addPlacementObservation', {
                    OBSERVATION_JSON: json.withText(json.at(payload, 'observation'), 'cameraId', peer)
                  }),
                  ifThen(
                    greaterThan(
                      json.at(payload, 'correspondence.uncertaintyUs'),
                      number(thresholds.maximumTimeUncertaintyUs)
                    ),
                    [
                      addFailure(
                        concatenate(
                          text('時刻の不確かさ '),
                          json.at(payload, 'correspondence.uncertaintyUs'),
                          text(' µs')
                        )
                      )
                    ]
                  ),
                  ifThen(equals(json.at(payload, 'correspondence.degraded'), text('true')), [
                    addFailure(text('時刻対応が劣化状態'))
                  ]),
                  ifThen(
                    greaterThan(json.at(payload, 'cornerSpreadPx'), number(thresholds.maximumCornerSpreadPx)),
                    [
                      addFailure(
                        concatenate(text('四隅のばらつき '), json.at(payload, 'cornerSpreadPx'), text(' px'))
                      )
                    ]
                  )
                ]
              )
            ]),
            tss('solvePlacement', {RIG_ID: text(rigId)}),
            ifElse(
              not(equals(tssValue('placementError'), text(''))),
              [
                setVariable(
                  r.failures,
                  concatenate(variable(r.failures), text('配置: '), tssValue('placementError'), text(' / '))
                )
              ],
              [
                ifThen(equals(json.at(tssValue('placementResultJson'), 'degraded'), text('true')), [
                  setVariable(r.failures, concatenate(variable(r.failures), text('配置が劣化状態 / ')))
                ]),
                ...forEachResult([
                  ifThen(
                    and(
                      measured,
                      greaterThan(
                        tssValue('placementReprojectionRms', {CAMERA_ID: peer}),
                        number(thresholds.maximumReprojectionRmsPx)
                      )
                    ),
                    [
                      addFailure(
                        concatenate(
                          text('再投影誤差 '),
                          tssValue('placementReprojectionRms', {CAMERA_ID: peer}),
                          text(' px')
                        )
                      )
                    ]
                  )
                ])
              ]
            ),
            ifElse(
              equals(variable(r.failures), text('')),
              [
                setVariable(r.ready, text('true')),
                notice(
                  shell,
                  concatenate(
                    text('READY: 空間と時刻の校正が品質基準を満たしました（'),
                    reporter(lengthOfList(r.results)),
                    text('台）。')
                  )
                )
              ],
              [
                error(
                  shell,
                  concatenate(
                    text('READYになりません。品質基準を満たさない項目があります: '),
                    variable(r.failures)
                  ),
                  'SPACE_TIME_NOT_READY'
                )
              ]
            )
          ]
        )
      ]
    )
  ];
}

const and = (left: BlockNode, right: BlockNode): BlockNode =>
  block('operator_and', {OPERAND1: condition(left), OPERAND2: condition(right)});

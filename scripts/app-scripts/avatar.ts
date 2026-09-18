import { readFileSync } from 'node:fs';

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
  type Script,
} from '../../packages/sb3-script/src/blocks.ts';
import {
  changeVariable,
  equals,
  ifElse,
  ifThen,
  join,
  not,
  repeat,
  setVariable,
} from '../../packages/sb3-script/src/standard.ts';
import { pose3dService } from './pose-3d.ts';

/**
 * Shows one VRM avatar per person the 3D service reports, in the fusion app.
 *
 * Binding an avatar per person would load a VRM each time somebody new appears. Avatars are
 * therefore bound once, to the service's avatar slots `slot-1` ... `slot-6`, and the service maps persons to slots
 * each frame and pairs each with the 2D view the avatar blocks also read. An avatar is shown while
 * its slot holds a recognized person and hidden otherwise, on the recognition events the avatar
 * blocks emit.
 *
 * A Performance DSL the operator opens gives each avatar, in slot order, the recognition start and
 * end effects of the performer at the same place in its list; an effect whose name is an
 * expression of the VRM is shown with that expression. Slot order stands in for the performer
 * until performers are identified (glow sticks).
 */

export const aframe = 'turbowarpaframe';
export const motionCapture = 'kubohiroyarealtimemotioncapture';
const yamlJson = 'kubohiroyayamljson';
const performanceDslSchema = 'twrmc/performance-dsl';

export const avatarSlotCount = 6;
/** How long a slot waits for its person before another person may take it. */
export const avatarSlotHoldMs = 1000;
const assetId = 'performer';
const avatarClass = 'twrmc-avatar';
const vrmUrlSetting = 'avatarVrmUrl';
const upAxisSetting = 'avatarUpAxis';
const audienceAxisSetting = 'avatarAudienceAxis';
/** How far in front of the projected pattern the audience camera stands, metres. */
const cameraDistanceM = 4;
/**
 * How far past each 3D request the joints are extrapolated to (#34 stage 6). The service fuses a
 * frame behind the newest camera frame; 0 carries the avatars to the moment of the request. The
 * time a frame then takes to reach the screen is not measured yet, so nothing is added for it.
 */
const predictionLeadMs = 0;
/** Joint and person confidence below which a bone keeps its last rotation. */
const confidence = 0.3;
/**
 * Where the avatars stand in front of A-Frame's default camera, which looks down -Z from 1.6 m.
 * Kalidokit places the hips from the screen, so this lifts them to standing height and moves them
 * back into view; it is not the venue position the 3D service measured.
 */
const rigJson = JSON.stringify({ rootScale: 1, rootOffset: [0, 0.95, -2] });

/**
 * The demo avatar, carried in the project so the fusion app shows something without a network or a
 * file. It is the box humanoid that `turbowarp-aframe`'s `scripts/generate-test-vrm.ts` writes,
 * with its `happy` and `glow` expressions; see `apps/fusion-app/avatars/README.md`.
 */
export const demoVrmUrl = `data:model/gltf-binary;base64,${readFileSync(
  new URL('../../apps/fusion-app/avatars/demo-humanoid.vrm', import.meta.url),
).toString('base64')}`;

export const avatarReferences = () => ({
  vrmUrl: namedReference('avatar VRM URL', 'variable:avatar-vrm-url'),
  index: namedReference('avatar index', 'variable:avatar-index'),
  stage: namedReference('avatar stage', 'variable:avatar-stage'),
  upAxis: namedReference('avatar up axis', 'variable:avatar-up-axis'),
  audienceAxis: namedReference(
    'avatar audience axis',
    'variable:avatar-audience-axis',
  ),
  dsl: namedReference('performance DSL', 'variable:performance-dsl'),
  dslDraft: namedReference(
    'performance DSL draft',
    'variable:performance-dsl-draft',
  ),
  /** One set per recognition hat, since the two may run at once. */
  startSlot: namedReference('avatar start slot', 'variable:avatar-start-slot'),
  endSlot: namedReference('avatar end slot', 'variable:avatar-end-slot'),
});

export type AvatarReferences = ReturnType<typeof avatarReferences>;

export const avatarVariables = (r: AvatarReferences) => ({
  [r.vrmUrl.id]: [r.vrmUrl.name, ''],
  [r.index.id]: [r.index.name, 0],
  [r.stage.id]: [r.stage.name, ''],
  [r.upAxis.id]: [r.upAxis.name, ''],
  [r.audienceAxis.id]: [r.audienceAxis.name, ''],
  [r.dsl.id]: [r.dsl.name, ''],
  [r.dslDraft.id]: [r.dslDraft.name, ''],
  [r.startSlot.id]: [r.startSlot.name, 0],
  [r.endSlot.id]: [r.endSlot.name, 0],
});

const aframeBlock = (
  opcode: string,
  inputs: Readonly<Record<string, InputValue>> = {},
) => block(`${aframe}_${opcode}`, inputs);
const avatarBlock = (
  opcode: string,
  inputs: Readonly<Record<string, InputValue>> = {},
) => block(`${motionCapture}_${opcode}`, inputs);
const serviceValue = (opcode: string) =>
  reporter(block(`${pose3dService}_${opcode}`));
const numbered = (prefix: string, reference: NamedReference) =>
  reporter(join(text(prefix), variable(reference)));

export class AvatarSteps {
  private readonly shell: string;
  private readonly r: AvatarReferences;
  private readonly corners: NamedReference;

  /**
   * `corners` holds the projected pattern's corners as the operator entered them for the
   * placement reference, or nothing before the space-time calibration.
   */
  public constructor(
    shell: string,
    references: AvatarReferences,
    corners: NamedReference,
  ) {
    this.shell = shell;
    this.r = references;
    this.corners = corners;
  }

  /**
   * Builds the scene, registers the VRM and binds one hidden avatar to each slot. Loading a VRM
   * takes a moment, and each bind waits for it. A failed load leaves the avatar state `error`,
   * which is shown rather than stopping the 3D output.
   */
  public setup(): BlockNode[] {
    const { r } = this;
    return [
      setVariable(
        r.vrmUrl,
        reporter(
          block(`${this.shell}_rememberedSetting`, {
            KEY: text(vrmUrlSetting),
          }),
        ),
      ),
      ifThen(equals(variable(r.vrmUrl), text('')), [
        setVariable(r.vrmUrl, text(demoVrmUrl)),
      ]),
      block(`${this.shell}_showAppLoading`, {
        LABEL: text('アバターを準備しています'),
      }),
      block(`${pose3dService}_setPredictionLead`, {
        LEAD_MS: number(predictionLeadMs),
      }),
      aframeBlock('createScene', {
        LAYER: text('above-stage'),
        MODE: text('3d'),
      }),
      ...this.stage(),
      avatarBlock('registerAvatarAsset', {
        ASSET_ID: text(assetId),
        VRM_URL: variable(r.vrmUrl),
        RIG_JSON: text(rigJson),
      }),
      setVariable(r.index, number(1)),
      repeat(number(avatarSlotCount), [
        avatarBlock('bindAvatarPerson', {
          PERSON_ID: numbered('slot-', r.index),
          INSTANCE_ID: numbered('avatar-', r.index),
          ASSET_ID: text(assetId),
          PARENT: text('#scene'),
          CONFIDENCE: number(confidence),
        }),
        aframeBlock('addClass', {
          CLASS: text(avatarClass),
          SELECTOR: numbered('#avatar-', r.index),
        }),
        aframeBlock('setAttribute', {
          SELECTOR: numbered('#avatar-', r.index),
          NAME: text('visible'),
          VALUE: text('false'),
        }),
        changeVariable(r.index, 1),
      ]),
      block(`${this.shell}_hideAppLoading`),
      ifThen(equals(this.state(), text('error')), [
        block(`${this.shell}_showAppError`, {
          MESSAGE: reporter(
            join(
              text('アバターを表示できません: '),
              reporter(avatarBlock('avatarRetargetError')),
            ),
          ),
          DETAILS: text(JSON.stringify({ code: 'AVATAR_SETUP_FAILED' })),
        }),
      ]),
    ];
  }

  /**
   * The projected pattern is the marker the avatars are placed by: its reference frame is the one
   * the 3D service measures in. The axes from the settings turn it to the avatars' axes, the pattern
   * is drawn as a faint plane where it was measured, and a camera in the audience faces it.
   */
  private stage(): BlockNode[] {
    const { r } = this;
    const axis = (
      target: NamedReference,
      key: string,
      fallback: string,
    ): BlockNode[] => [
      setVariable(
        target,
        reporter(block(`${this.shell}_rememberedSetting`, { KEY: text(key) })),
      ),
      ifThen(equals(variable(target), text('')), [
        setVariable(target, text(fallback)),
      ]),
    ];
    const at = (key: string) =>
      reporter(
        block(`${this.shell}_jsonValueAt`, {
          JSON: variable(r.stage),
          PATH: text(key),
        }),
      );
    return [
      ...axis(r.upAxis, upAxisSetting, '-y'),
      ...axis(r.audienceAxis, audienceAxisSetting, '-z'),
      block(`${pose3dService}_setAvatarAxes`, {
        UP: variable(r.upAxis),
        AUDIENCE: variable(r.audienceAxis),
      }),
      ifThen(not(equals(serviceValue('avatarStageError'), text(''))), [
        block(`${this.shell}_showAppNotice`, {
          MESSAGE: reporter(
            join(
              text('アバターの向きの設定を使えないため既定の向きにしました: '),
              serviceValue('avatarStageError'),
            ),
          ),
        }),
      ]),
      setVariable(r.stage, text('')),
      ifThen(not(equals(variable(this.corners), text(''))), [
        setVariable(
          r.stage,
          reporter(
            block(`${pose3dService}_avatarStageJson`, {
              CORNERS: variable(this.corners),
              DISTANCE_M: number(cameraDistanceM),
            }),
          ),
        ),
      ]),
      ifThen(not(equals(variable(r.stage), text(''))), [
        aframeBlock('createNode', {
          TYPE: text('plane'),
          ID: text('avatar-stage-wall'),
          PARENT: text('#scene'),
        }),
        aframeBlock('setPosition', {
          SELECTOR: text('#avatar-stage-wall'),
          X: at('wallX'),
          Y: at('wallY'),
          Z: at('wallZ'),
        }),
        aframeBlock('setRotation', {
          SELECTOR: text('#avatar-stage-wall'),
          X: at('wallRotationX'),
          Y: at('wallRotationY'),
          Z: at('wallRotationZ'),
        }),
        aframeBlock('setAttribute', {
          SELECTOR: text('#avatar-stage-wall'),
          NAME: text('width'),
          VALUE: at('wallWidth'),
        }),
        aframeBlock('setAttribute', {
          SELECTOR: text('#avatar-stage-wall'),
          NAME: text('height'),
          VALUE: at('wallHeight'),
        }),
        aframeBlock('setAttribute', {
          SELECTOR: text('#avatar-stage-wall'),
          NAME: text('material'),
          VALUE: text(
            'color: #7aa7ff; opacity: 0.2; transparent: true; side: double',
          ),
        }),
        aframeBlock('createNode', {
          TYPE: text('camera'),
          ID: text('avatar-stage-camera'),
          PARENT: text('#scene'),
        }),
        aframeBlock('setPosition', {
          SELECTOR: text('#avatar-stage-camera'),
          X: at('cameraX'),
          Y: at('cameraY'),
          Z: at('cameraZ'),
        }),
        aframeBlock('setRotation', {
          SELECTOR: text('#avatar-stage-camera'),
          X: at('wallRotationX'),
          Y: at('wallRotationY'),
          Z: at('wallRotationZ'),
        }),
      ]),
    ];
  }

  /** Maps the newest 3D frame to the slots and turns the avatars. Runs after each 3D request. */
  public frame(): BlockNode[] {
    return [
      block(`${pose3dService}_updateAvatarPoses`, {
        SLOTS: number(avatarSlotCount),
        HOLD_MS: number(avatarSlotHoldMs),
      }),
      ifThen(not(equals(serviceValue('avatarPose3dJson'), text(''))), [
        avatarBlock('applyPoseFrame3DToAvatars', {
          POSE3D_JSON: serviceValue('avatarPose3dJson'),
          POSE2D_JSON: serviceValue('avatarPose2dJson'),
        }),
      ]),
    ];
  }

  /** Removes the avatars; the next start binds them again. */
  public stop(): BlockNode[] {
    return [
      avatarBlock('resetAvatarRetarget'),
      block(`${pose3dService}_setPredictionLead`, { LEAD_MS: number(-1) }),
    ];
  }

  /** For the once-a-second line: how many avatars the last frame moved, and why none if so. */
  public status(): InputValue {
    return reporter(
      join(
        text(' / アバター: '),
        reporter(
          join(
            reporter(avatarBlock('avatarUpdatedCount')),
            reporter(join(text('体 '), this.state())),
          ),
        ),
      ),
    );
  }

  private state(): InputValue {
    return reporter(avatarBlock('avatarRetargetState'));
  }
}

/**
 * Shows an avatar when its person is recognized and hides it when they are lost. The avatar blocks
 * emit these events on the avatar's node, and the A-Frame hat matches them by the avatars' class.
 * With a Performance DSL open, each also shows the performer's start or end effect as an
 * expression, when the VRM has one of that name.
 */
export function avatarVisibilityScripts(
  shell: string,
  r: AvatarReferences,
  position: { x: number; y: number },
): Script[] {
  const toggle = (
    event: string,
    recognized: boolean,
    slot: NamedReference,
    y: number,
  ) =>
    script({ x: position.x, y }, [
      aframeBlock('whenEventOnSelector', {
        TYPE: text(event),
        SELECTOR: text(`.${avatarClass}`),
      }),
      aframeBlock('setAttribute', {
        SELECTOR: reporter(
          join(text('#'), reporter(aframeBlock('eventTargetId'))),
        ),
        NAME: text('visible'),
        VALUE: text(String(recognized)),
      }),
      ifThen(not(equals(variable(r.dsl), text(''))), [
        ...effectSteps(shell, r, slot, recognized),
      ]),
    ]);
  return [
    toggle('twmp-recognition-start', true, r.startSlot, position.y),
    toggle('twmp-recognition-end', false, r.endSlot, position.y + 400),
  ];
}

/**
 * Sets the start effect to 1 and the end effect to 0 on recognition, and the other way round when
 * the person is lost. The avatar is hidden when lost, so the end effect shows only if a later
 * change keeps it visible for a while.
 */
function effectSteps(
  shell: string,
  r: AvatarReferences,
  slot: NamedReference,
  recognized: boolean,
): BlockNode[] {
  const target = () => reporter(aframeBlock('eventTargetId'));
  const personId = () => numbered('slot-', slot);
  const effect = (field: string) =>
    reporter(
      block(`${shell}_jsonValueAt`, {
        JSON: variable(r.dsl),
        PATH: reporter(
          join(
            text('performers.'),
            reporter(
              join(
                reporter(
                  block('operator_subtract', {
                    NUM1: variable(slot),
                    NUM2: number(1),
                  }),
                ),
                text(`.${field}`),
              ),
            ),
          ),
        ),
      }),
    );
  const express = (field: string, weight: number): BlockNode =>
    ifThen(
      block('operator_contains', {
        STRING1: reporter(
          avatarBlock('avatarExpressionNames', { PERSON_ID: personId() }),
        ),
        STRING2: reporter(
          join(text('"'), reporter(join(effect(field), text('"')))),
        ),
      }),
      [
        avatarBlock('setAvatarExpression', {
          NAME: effect(field),
          WEIGHT: number(weight),
          PERSON_ID: personId(),
        }),
      ],
    );
  return [
    // The avatar's slot is the number in its node ID, avatar-N.
    setVariable(slot, number(0)),
    setVariable(r.index, number(1)),
    repeat(number(avatarSlotCount), [
      ifThen(equals(target(), numbered('avatar-', r.index)), [
        setVariable(slot, variable(r.index)),
      ]),
      changeVariable(r.index, 1),
    ]),
    ifThen(not(equals(variable(slot), number(0))), [
      express('recognitionStartEffect', recognized ? 1 : 0),
      express('recognitionEndEffect', recognized ? 0 : 1),
    ]),
  ];
}

/**
 * Reads the Performance DSL the operator opened: YAML or JSON, checked as `twrmc/performance-dsl`
 * by the motion capture extension's contract codec. Only a valid one replaces the one in use.
 */
export function performanceDslLoadSteps(
  shell: string,
  titleMenu: string,
  r: AvatarReferences,
): BlockNode[] {
  const notice = (label: string, detail: InputValue) =>
    block(`${shell}_showAppNotice`, {
      MESSAGE: reporter(join(text(label), detail)),
    });
  return [
    setVariable(
      r.dslDraft,
      reporter(
        block(`${yamlJson}_renderJson`, {
          FRAGMENT: reporter(
            block(
              `${yamlJson}_parseText`,
              { TEXT: reporter(block(`${titleMenu}_openedDslSource`)) },
              { FORMAT: 'auto' },
            ),
          ),
        }),
      ),
    ),
    ifElse(
      not(block(`${yamlJson}_lastParseSucceeded`)),
      [
        notice(
          '演出ファイルを読めませんでした: ',
          reporter(block(`${yamlJson}_lastParseDiagnostic`)),
        ),
      ],
      [
        // Validation reports a bad document; decoding one would throw.
        ifElse(
          avatarBlock('protocolJsonValid', { JSON: variable(r.dslDraft) }),
          [
            avatarBlock('decodeProtocolJson', { JSON: variable(r.dslDraft) }),
            ifElse(
              equals(
                reporter(avatarBlock('protocolSchema')),
                text(performanceDslSchema),
              ),
              [
                setVariable(r.dsl, variable(r.dslDraft)),
                notice(
                  '演出ファイルを使います。演者: ',
                  reporter(
                    join(
                      reporter(
                        block(`${shell}_jsonValueAt`, {
                          JSON: variable(r.dsl),
                          PATH: text('performers.length'),
                        }),
                      ),
                      text('人'),
                    ),
                  ),
                ),
              ],
              [
                notice(
                  `演出ファイルではありません（${performanceDslSchema}ではなく）: `,
                  reporter(avatarBlock('protocolSchema')),
                ),
              ],
            ),
          ],
          [
            notice(
              '演出ファイルが正しくありません: ',
              reporter(avatarBlock('protocolErrorMessage')),
            ),
          ],
        ),
      ],
    ),
    setVariable(r.dslDraft, text('')),
  ];
}

/**
 * Asks for the URL of the VRM to show and remembers it. An empty answer returns to the demo avatar.
 * The new VRM is used from the next start of the 3D output.
 */
export function chooseAvatarVrmSteps(shell: string): BlockNode[] {
  const answer = () => reporter(block('sensing_answer'));
  return [
    block('sensing_askandwait', {
      QUESTION: text(
        'アバターにするVRMのURLを入力してください（空欄でデモのアバター）',
      ),
    }),
    block(`${shell}_rememberSetting`, {
      KEY: text(vrmUrlSetting),
      VALUE: answer(),
    }),
    ifElse(
      equals(answer(), text('')),
      [
        block(`${shell}_showAppNotice`, {
          MESSAGE: text(
            'デモのアバターに戻しました。次に3D出力を始めたときから使います。',
          ),
        }),
      ],
      [
        block(`${shell}_showAppNotice`, {
          MESSAGE: text(
            'VRMを設定しました。次に3D出力を始めたときから使います。',
          ),
        }),
      ],
    ),
  ];
}

/**
 * Asks which axis of the space-time reference points up and which towards the audience, and
 * remembers them. Empty answers return to the defaults, which fit corners measured from the
 * top-left with x to the right and y downwards.
 */
export function chooseAvatarAxesSteps(shell: string): BlockNode[] {
  const answer = () => reporter(block('sensing_answer'));
  const ask = (question: string, key: string): BlockNode[] => [
    block('sensing_askandwait', { QUESTION: text(question) }),
    block(`${shell}_rememberSetting`, { KEY: text(key), VALUE: answer() }),
  ];
  return [
    ...ask(
      '基準座標系で上を向く軸を入力してください（+x, -x, +y, -y, +z, -z。空欄で既定の -y）',
      upAxisSetting,
    ),
    ...ask(
      '基準座標系で客席の側を向く軸を入力してください（空欄で既定の -z）',
      audienceAxisSetting,
    ),
    block(`${shell}_showAppNotice`, {
      MESSAGE: text(
        'アバターの向きを設定しました。次に3D出力を始めたときから使います。',
      ),
    }),
  ];
}

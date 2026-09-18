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
 * The 3D service names a person after the camera and tracker that saw them first, so the name
 * changes when that tracker does (identity over time is #34 stage 4). Avatars are therefore bound
 * once, to the service's avatar slots `slot-1` ... `slot-6`, and the service maps persons to slots
 * each frame and pairs each with the 2D view the avatar blocks also read. An avatar is shown while
 * its slot holds a recognized person and hidden otherwise, on the recognition events the avatar
 * blocks emit.
 *
 * Connecting Performance DSL effects to expressions is not done here: the DSL is not loaded by the
 * fusion app yet.
 */

export const aframe = 'turbowarpaframe';
export const motionCapture = 'kubohiroyarealtimemotioncapture';

export const avatarSlotCount = 6;
/** How long a slot waits for its person before another person may take it. */
export const avatarSlotHoldMs = 1000;
const assetId = 'performer';
const avatarClass = 'twrmc-avatar';
const vrmUrlSetting = 'avatarVrmUrl';
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
});

export type AvatarReferences = ReturnType<typeof avatarReferences>;

export const avatarVariables = (r: AvatarReferences) => ({
  [r.vrmUrl.id]: [r.vrmUrl.name, ''],
  [r.index.id]: [r.index.name, 0],
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

  public constructor(shell: string, references: AvatarReferences) {
    this.shell = shell;
    this.r = references;
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
      aframeBlock('createScene', {
        LAYER: text('above-stage'),
        MODE: text('3d'),
      }),
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
    return [avatarBlock('resetAvatarRetarget')];
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
 */
export function avatarVisibilityScripts(position: {
  x: number;
  y: number;
}): Script[] {
  const toggle = (event: string, visible: boolean, y: number) =>
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
        VALUE: text(String(visible)),
      }),
    ]);
  return [
    toggle('twmp-recognition-start', true, position.y),
    toggle('twmp-recognition-end', false, position.y + 200),
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

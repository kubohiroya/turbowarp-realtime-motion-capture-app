import {block, reporter, script, text, type Script} from '../../packages/sb3-script/src/blocks.ts';

const shell = 'multiviewposecamerashell';
const titleMenu = 'kubohiroyaturbowarptitlemenu';
const cameraSource = 'kubohiroyacamerasource';

/** Menu action ids. The hat matches on these, so they are part of the script's contract. */
const action = {
  selectCamera: 'selectCamera',
  diagnostics: 'diagnostics'
} as const;

const join = (left: string, right: ReturnType<typeof block>) =>
  reporter(block('operator_join', {STRING1: text(left), STRING2: reporter(right)}));

/**
 * The camera app's startup and menu.
 *
 * Opcodes here are the members' own, not the bundled ones: the build namespaces them when it writes
 * the SB3, so the expanded source stays readable against each extension's own documentation.
 *
 * The menu replaces the extension's built-in actions rather than adding to them, because this
 * application's operator has different work to do than opening a DSL file. Clearing first is safe
 * while the menu is closed, and `show application menu` runs only after the actions exist.
 */
export const cameraAppScripts: readonly Script[] = [
  script({x: 48, y: 48}, [
    block('event_whenflagclicked'),
    block(`${shell}_showAppLoading`, {LABEL: text('カメラアプリを起動しています')}),
    block(`${titleMenu}_clearAppMenuActions`),
    block(`${titleMenu}_addAppMenuAction`, {
      ACTION: text(action.selectCamera),
      LABEL: text('カメラを選ぶ')
    }),
    block(`${titleMenu}_addAppMenuAction`, {
      ACTION: text(action.diagnostics),
      LABEL: text('動作状況を見る')
    }),
    block(`${cameraSource}_refreshCameraDevices`),
    block(`${shell}_hideAppLoading`),
    block(`${titleMenu}_showMenu`)
  ]),

  script({x: 48, y: 320}, [
    block(`${titleMenu}_whenAppMenuActionSelected`, {}, {ACTION: action.selectCamera}),
    block(`${cameraSource}_refreshCameraDevices`),
    block(`${shell}_showAppNotice`, {
      MESSAGE: join('つながっているカメラの数: ', block(`${cameraSource}_cameraDeviceCount`))
    })
  ]),

  script({x: 48, y: 520}, [
    block(`${titleMenu}_whenAppMenuActionSelected`, {}, {ACTION: action.diagnostics}),
    block(`${shell}_showAppNotice`, {
      MESSAGE: join('起動時の機能設定: ', block(`${shell}_appFeatureFlagState`))
    })
  ])
];

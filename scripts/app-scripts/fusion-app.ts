import {block, reporter, script, text, type Script} from '../../packages/sb3-script/src/blocks.ts';

const shell = 'realtimemotioncapturefusionshell';
const titleMenu = 'kubohiroyaturbowarptitlemenu';

/** Menu action ids. The hat matches on these, so they are part of the script's contract. */
const action = {
  dslFiles: 'dslFiles',
  diagnostics: 'diagnostics'
} as const;

const join = (left: string, right: ReturnType<typeof block>) =>
  reporter(block('operator_join', {STRING1: text(left), STRING2: reporter(right)}));

/**
 * The fusion app's startup and menu.
 *
 * The DSL file manager is reached from this application's own menu entry rather than the
 * extension's built-in one, so every item an operator sees belongs to one vocabulary.
 */
export const fusionAppScripts: readonly Script[] = [
  script({x: 48, y: 48}, [
    block('event_whenflagclicked'),
    block(`${shell}_showAppLoading`, {LABEL: text('統合アプリを起動しています')}),
    block(`${titleMenu}_clearAppMenuActions`),
    block(`${titleMenu}_addAppMenuAction`, {
      ACTION: text(action.dslFiles),
      LABEL: text('演出ファイルを選ぶ')
    }),
    block(`${titleMenu}_addAppMenuAction`, {
      ACTION: text(action.diagnostics),
      LABEL: text('動作状況を見る')
    }),
    block(`${shell}_hideAppLoading`),
    block(`${titleMenu}_showMenu`)
  ]),

  script({x: 48, y: 320}, [
    block(`${titleMenu}_whenAppMenuActionSelected`, {}, {ACTION: action.dslFiles}),
    block(`${titleMenu}_showDslFiles`)
  ]),

  /**
   * A DSL is announced by the extension, not polled for. The source is read here so a later script
   * can validate it; nothing consumes it yet.
   */
  script({x: 48, y: 480}, [
    block(`${titleMenu}_whenDslSourceOpened`),
    block(`${shell}_showAppNotice`, {
      MESSAGE: join('読み込んだ演出ファイル: ', block(`${titleMenu}_openedDslName`))
    })
  ]),

  script({x: 48, y: 660}, [
    block(`${titleMenu}_whenAppMenuActionSelected`, {}, {ACTION: action.diagnostics}),
    block(`${shell}_showAppNotice`, {
      MESSAGE: join('起動時の機能設定: ', block(`${shell}_appFeatureFlagState`))
    })
  ])
];

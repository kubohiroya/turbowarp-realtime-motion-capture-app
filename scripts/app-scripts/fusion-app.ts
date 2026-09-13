import {block, script, text, type Script} from '../../packages/sb3-script/src/blocks.ts';

const shell = 'multiviewposefusionshell';
const titleMenu = 'kubohiroyaturbowarptitlemenu';

/**
 * The fusion app's startup.
 *
 * Same limits as the camera app: this is the part the pinned extensions can already run, and the
 * menu wiring waits for `turbowarp-title-menu` 0.2.2.
 */
export const fusionAppScripts: readonly Script[] = [
  script({x: 48, y: 48}, [
    block('event_whenflagclicked'),
    block(`${shell}_showAppLoading`, {LABEL: text('統合アプリを起動しています')}),
    block(`${shell}_hideAppLoading`),
    block(`${titleMenu}_showTitle`)
  ])
];

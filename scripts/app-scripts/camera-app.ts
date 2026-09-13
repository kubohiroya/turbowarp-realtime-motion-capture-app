import {block, script, text, type Script} from '../../packages/sb3-script/src/blocks.ts';

const shell = 'multiviewposecamerashell';
const titleMenu = 'kubohiroyaturbowarptitlemenu';
const cameraSource = 'kubohiroyacamerasource';

/**
 * The camera app's startup, as far as the pinned extensions can carry it.
 *
 * Opcodes here are the members' own, not the bundled ones: the build namespaces them when it writes
 * the SB3, and the expanded source stays readable against each extension's documentation.
 *
 * Menu actions are not registered yet. The action hat needs `turbowarp-title-menu` 0.2.2, where the
 * action argument became a field the hat can match; the pinned 0.2.1 would show the items and never
 * fire.
 */
export const cameraAppScripts: readonly Script[] = [
  script({x: 48, y: 48}, [
    block('event_whenflagclicked'),
    block(`${shell}_showAppLoading`, {LABEL: text('カメラアプリを起動しています')}),
    block(`${cameraSource}_refreshCameraDevices`),
    block(`${shell}_hideAppLoading`),
    block(`${titleMenu}_showTitle`)
  ])
];

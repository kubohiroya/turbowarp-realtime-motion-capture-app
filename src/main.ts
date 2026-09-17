import {
  createAppShellApplicationMenu,
  createRuntimeMessageIndicator,
} from '@kubohiroya/turbowarp-app-shell';
import config from '../config/app.json';
import { featureFlags } from '../config/feature-flags.ts';
import './style.css';

const englishModes: Readonly<
  Record<string, { label: string; description: string }>
> = config.en.modes;

const mount = document.querySelector<HTMLElement>('#app');
if (!mount) throw new Error('Application mount is missing.');
function element(tag: string, text: string) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}
document.title = config.title;
mount.append(element('h1', config.title), element('p', config.summary));
const note = element(
  'p',
  'SB3のblockスクリプトは実機確認前です。カメラ取得、ペアリング、姿勢推定、3D統合、アバター表示は検証されていません。',
);
note.className = 'note';
mount.append(note);
const status = element(
  'section',
  'アプリを選ぶと役割とSB3のダウンロードを表示します。',
);
const menuMount = element('section', '');
const download = document.createElement('a');
download.hidden = true;
mount.append(menuMount, status, download);
const errors = createRuntimeMessageIndicator({
  document,
  mount,
  locales: { ja: { title: '起動エラー' }, en: { title: 'Startup error' } },
  initialLocale: 'ja',
});
const menu = createAppShellApplicationMenu({
  document,
  mount: menuMount,
  initialLocale: 'ja',
  actions: config.modes.map((mode) => ({
    id: mode.id,
    labels: { ja: mode.label, en: englishModes[mode.id]?.label ?? mode.label },
    onSelect: () => {
      status.textContent = mode.description;
      download.href = `./downloads/${mode.sb3}`;
      download.download = mode.sb3;
      download.textContent = `${mode.label}アプリのSB3をダウンロード（${mode.sb3}）`;
      download.hidden = false;
    },
  })),
  onError: (error) =>
    errors.show({
      message: error instanceof Error ? error.message : String(error),
    }),
});
menu.show();
const plan = element('section', '');
plan.append(element('h2', '実装予定'));
const list = document.createElement('ul');
for (const feature of config.plannedFeatures)
  list.append(element('li', feature));
plan.append(list);
mount.append(plan);
if (featureFlags.embeddedPlayer) {
  errors.show({
    message:
      'このページはTurboWarpプレイヤーを内蔵しません。embeddedPlayerフラグをOFFに戻してください。',
  });
}

import type {AppShellAppConfig} from '../app-config.js';

/**
 * The standalone app (#36): several USB cameras on one PC, processed and shown in one page.
 *
 * No contract flag is requested yet. Stage 1 runs and measures cameras and stage 2 calibrates each
 * one's lens; each later stage adds the flags and extensions it needs.
 */
export const localAppConfig: AppShellAppConfig = {
  id: 'realtimemotioncapturelocalshell',
  slug: 'local-app-shell',
  name: 'Realtime Motion Capture Local App',
  description: 'Application shell for the standalone realtime motion capture app that runs every camera on one PC.',
  author: 'Hiroya Kubo',
  license: 'MPL-2.0',
  docsURI: 'https://kubohiroya.github.io/turbowarp-realtime-motion-capture-app/',
  blockIconURI:
    'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0OCA0OCI+PHJlY3QgeD0iNCIgeT0iMTIiIHdpZHRoPSIzMCIgaGVpZ2h0PSIyNCIgcng9IjQiIGZpbGw9IiM0Qzk3RkYiLz48cGF0aCBkPSJNMzQgMjJsMTAtNnYxNmwtMTAtNnoiIGZpbGw9IiMyRTZGRDkiLz48Y2lyY2xlIGN4PSIxOSIgY3k9IjI0IiByPSI3IiBmaWxsPSIjRkZGRkZGIi8+PC9zdmc+',
  featureFlags: [],
  cameraGrid: true,
  lensCalibration: true,
  noticeLocales: {
    en: {title: 'Local app'},
    ja: {title: 'ローカルアプリからのお知らせ'}
  },
  errorLocales: {
    en: {title: 'Local app stopped'},
    ja: {title: 'ローカルアプリが停止しました'}
  }
};

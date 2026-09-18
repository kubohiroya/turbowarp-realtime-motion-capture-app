import type { AppShellAppConfig } from '../app-config.js';

/**
 * The standalone app (#36): several USB cameras on one PC, processed and shown in one page.
 *
 * Stage 1 runs and measures cameras, stage 2 calibrates each one's lens, stage 3 estimates every
 * camera's 2D pose — the one contract flag requested so far — and stage 4 calibrates time
 * correspondence and placement in this page, which switches Time-Space Sync on. Each later stage adds
 * the flags and extensions it needs.
 */
export const localAppConfig: AppShellAppConfig = {
  id: 'realtimemotioncapturelocalshell',
  slug: 'local-app-shell',
  name: 'Realtime Motion Capture Local App',
  description:
    'Application shell for the standalone realtime motion capture app that runs every camera on one PC.',
  author: 'Hiroya Kubo',
  license: 'MPL-2.0',
  docsURI:
    'https://kubohiroya.github.io/turbowarp-realtime-motion-capture-app/',
  blockIconURI:
    'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0OCA0OCI+PHJlY3QgeD0iNCIgeT0iMTIiIHdpZHRoPSIzMCIgaGVpZ2h0PSIyNCIgcng9IjQiIGZpbGw9IiM0Qzk3RkYiLz48cGF0aCBkPSJNMzQgMjJsMTAtNnYxNmwtMTAtNnoiIGZpbGw9IiMyRTZGRDkiLz48Y2lyY2xlIGN4PSIxOSIgY3k9IjI0IiByPSI3IiBmaWxsPSIjRkZGRkZGIi8+PC9zdmc+',
  // avatarRetargetV1: the avatars that follow the 3D output (#36 stage 6), as in the fusion app.
  featureFlags: ['webgpuMoveNetMultiPose', 'avatarRetargetV1'],
  cameraGrid: true,
  lensCalibration: true,
  timeSpaceSync: true,
  // The 3D service has only stub implementations (#34, stage 1); kept off, as in the fusion app.
  appFlags: [],
  noticeLocales: {
    en: { title: 'Local app' },
    ja: { title: 'ローカルアプリからのお知らせ' },
  },
  errorLocales: {
    en: { title: 'Local app stopped' },
    ja: { title: 'ローカルアプリが停止しました' },
  },
};

import type {AppShellAppConfig} from '../app-config.js';

export const cameraAppConfig: AppShellAppConfig = {
  id: 'realtimemotioncapturecamerashell',
  slug: 'camera-app-shell',
  name: 'Realtime Motion Capture Camera App',
  description: 'Application shell and contract feature flags for the realtime motion capture camera app.',
  author: 'Hiroya Kubo',
  license: 'MPL-2.0',
  docsURI: 'https://kubohiroya.github.io/turbowarp-realtime-motion-capture-app/',
  blockIconURI:
    'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0OCA0OCI+PHJlY3QgeD0iNCIgeT0iMTIiIHdpZHRoPSIzMCIgaGVpZ2h0PSIyNCIgcng9IjQiIGZpbGw9IiM0Qzk3RkYiLz48cGF0aCBkPSJNMzQgMjJsMTAtNnYxNmwtMTAtNnoiIGZpbGw9IiMyRTZGRDkiLz48Y2lyY2xlIGN4PSIxOSIgY3k9IjI0IiByPSI3IiBmaWxsPSIjRkZGRkZGIi8+PC9zdmc+',
  featureFlags: [
    'webgpuMoveNetMultiPose',
    'protocolV1Codec',
    'cameraCalibrationV1',
    'frameSyncPatternV1',
    'glowStickMarkers'
  ],
  noticeLocales: {
    en: {title: 'Camera app'},
    ja: {title: 'カメラアプリからのお知らせ'}
  },
  errorLocales: {
    en: {title: 'Camera app stopped'},
    ja: {title: 'カメラアプリが停止しました'}
  }
};

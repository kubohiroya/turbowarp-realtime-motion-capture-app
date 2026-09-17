import type {AppShellAppConfig} from '../app-config.js';

export const fusionAppConfig: AppShellAppConfig = {
  id: 'realtimemotioncapturefusionshell',
  slug: 'fusion-app-shell',
  name: 'Realtime Motion Capture Fusion App',
  description: 'Application shell and contract feature flags for the realtime motion capture fusion app.',
  author: 'Hiroya Kubo',
  license: 'MPL-2.0',
  docsURI: 'https://kubohiroya.github.io/turbowarp-realtime-motion-capture-app/',
  blockIconURI:
    'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0OCA0OCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxNCIgcj0iNiIgZmlsbD0iIzRDOTdGRiIvPjxjaXJjbGUgY3g9IjEyIiBjeT0iMzQiIHI9IjYiIGZpbGw9IiM1OUMwNTkiLz48Y2lyY2xlIGN4PSIzNiIgY3k9IjI0IiByPSI4IiBmaWxsPSIjRkZBQjE5Ii8+PHBhdGggZD0iTTE3IDE2bDEyIDZNMTcgMzJsMTItNiIgc3Ryb2tlPSIjNTc1RTc1IiBzdHJva2Utd2lkdGg9IjMiIGZpbGw9Im5vbmUiLz48L3N2Zz4=',
  featureFlags: [
    'qrCourierPairing',
    'protocolV1Codec',
    'avatarRetargetV1',
    'poseFusion3D',
    'glowStickMarkers'
  ],
  timeSpaceSync: true,
  // The 3D service has only stub implementations so far (#34 stage 1). Listing this flag would put
  // stub poses in the distributed app, so it stays off until a real implementation exists.
  appFlags: [],
  noticeLocales: {
    en: {title: 'Fusion app'},
    ja: {title: '統合アプリからのお知らせ'}
  },
  errorLocales: {
    en: {title: 'Fusion app stopped'},
    ja: {title: '統合アプリが停止しました'}
  }
};

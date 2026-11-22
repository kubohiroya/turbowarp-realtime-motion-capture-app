import { turboWarpExtension } from '@kubohiroya/vite-plugin-turbowarp-extension';
import { defineConfig } from 'vite';

import { parseAppFlags } from './src/app-config.js';

import { fusionAppConfig } from './src/apps/fusion.js';

export default defineConfig({
  // Empty unless this is a measurement build: `TWRMC_APP_FLAGS=debugPoseReplayV1 pnpm run build:measurement`.
  define: {
    __TWRMC_APP_FLAGS__: JSON.stringify(
      parseAppFlags(process.env['TWRMC_APP_FLAGS'] ?? '').join(','),
    ),
  },
  // One output directory per app: the plugin always clears its own outDir before writing.
  build: { outDir: 'dist/fusion-app' },
  plugins: [
    turboWarpExtension({
      id: fusionAppConfig.id,
      name: fusionAppConfig.name,
      description: fusionAppConfig.description,
      author: fusionAppConfig.author,
      license: fusionAppConfig.license,
      entry: 'src/entries/fusion.ts',
      fileName: `${fusionAppConfig.slug}.js`,
    }),
  ],
});

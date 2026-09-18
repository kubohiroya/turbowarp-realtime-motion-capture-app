import { turboWarpExtension } from '@kubohiroya/vite-plugin-turbowarp-extension';
import { defineConfig } from 'vite';

import { parseAppFlags } from './src/app-config.js';

import { cameraAppConfig } from './src/apps/camera.js';

export default defineConfig({
  // Empty unless this is a measurement build: `TWRMC_APP_FLAGS=debugPoseReplayV1 pnpm run build:measurement`.
  define: {
    __TWRMC_APP_FLAGS__: JSON.stringify(
      parseAppFlags(process.env['TWRMC_APP_FLAGS'] ?? '').join(','),
    ),
  },
  // One output directory per app: the plugin always clears its own outDir before writing.
  build: { outDir: 'dist/camera-app' },
  plugins: [
    turboWarpExtension({
      id: cameraAppConfig.id,
      name: cameraAppConfig.name,
      description: cameraAppConfig.description,
      author: cameraAppConfig.author,
      license: cameraAppConfig.license,
      entry: 'src/entries/camera.ts',
      fileName: `${cameraAppConfig.slug}.js`,
    }),
  ],
});

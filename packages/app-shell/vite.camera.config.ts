import { turboWarpExtension } from '@kubohiroya/vite-plugin-turbowarp-extension';
import { defineConfig } from 'vite';

import { cameraAppConfig } from './src/apps/camera.js';

export default defineConfig({
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

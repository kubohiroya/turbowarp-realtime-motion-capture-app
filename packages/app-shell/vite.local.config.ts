import { turboWarpExtension } from '@kubohiroya/vite-plugin-turbowarp-extension';
import { defineConfig } from 'vite';

import { localAppConfig } from './src/apps/local.js';

export default defineConfig({
  // One output directory per app: the plugin always clears its own outDir before writing.
  build: { outDir: 'dist/local-app' },
  plugins: [
    turboWarpExtension({
      id: localAppConfig.id,
      name: localAppConfig.name,
      description: localAppConfig.description,
      author: localAppConfig.author,
      license: localAppConfig.license,
      entry: 'src/entries/local.ts',
      fileName: `${localAppConfig.slug}.js`,
    }),
  ],
});

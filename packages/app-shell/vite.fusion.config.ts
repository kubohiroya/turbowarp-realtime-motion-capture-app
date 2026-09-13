import {turboWarpExtension} from '@kubohiroya/vite-plugin-turbowarp-extension';
import {defineConfig} from 'vite';

import {fusionAppConfig} from './src/apps/fusion.js';

export default defineConfig({
  // One output directory per app: the plugin always clears its own outDir before writing.
  build: {outDir: 'dist/fusion-app'},
  plugins: [
    turboWarpExtension({
      id: fusionAppConfig.id,
      name: fusionAppConfig.name,
      description: fusionAppConfig.description,
      author: fusionAppConfig.author,
      license: fusionAppConfig.license,
      entry: 'src/entries/fusion.ts',
      fileName: `${fusionAppConfig.slug}.js`
    })
  ]
});

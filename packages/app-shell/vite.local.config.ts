import { turboWarpExtension } from '@kubohiroya/vite-plugin-turbowarp-extension';
import { defineConfig } from 'vite';

import { parseAppFlags } from './src/app-config.js';

import { localAppConfig } from './src/apps/local.js';

export default defineConfig({
  // Empty unless this is a measurement build: `TWRMC_APP_FLAGS=debugPoseReplayV1 pnpm run build:measurement`.
  define: {
    __TWRMC_APP_FLAGS__: JSON.stringify(
      parseAppFlags(process.env['TWRMC_APP_FLAGS'] ?? '').join(','),
    ),
  },
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

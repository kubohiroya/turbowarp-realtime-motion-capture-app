import { turboWarpExtension } from '@kubohiroya/vite-plugin-turbowarp-extension';
import { defineConfig } from 'vite';

export default defineConfig({
  build: { outDir: 'dist' },
  plugins: [
    turboWarpExtension({
      id: 'realtimemotioncapturepose3dservice',
      name: 'Pose 3D Service',
      description:
        'Drives the 3D pose service of the realtime motion capture fusion app in a Worker.',
      author: 'Hiroya Kubo',
      license: 'MPL-2.0',
      entry: 'src/entry.ts',
      fileName: 'pose-3d-service.js',
    }),
  ],
});

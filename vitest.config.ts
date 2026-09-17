import { defineConfig } from 'vitest/config';

// Only this repository's own page and configuration tests. Each workspace package runs its tests
// through its own `check`, so they are not collected twice from the root.
export default defineConfig({ test: { include: ['tests/**/*.test.ts'] } });

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // A single `buildWorld` runs the §13.4 ladder (up to 28 soup simulations of
    // 1152 frames each) and the corpus sweeps build several worlds in one test,
    // so the 5 s default is far too tight. The suite's own budget is asserted in
    // world.test.ts ("buildWorld timing budget") rather than by this timeout.
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});

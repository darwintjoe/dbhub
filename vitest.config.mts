import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The 2,000-bundle acceptance test is CPU-bound and flakes past its 20s
    // threshold when many workers compete for the same cores.
    minWorkers: 2,
    maxWorkers: 2,
  },
});

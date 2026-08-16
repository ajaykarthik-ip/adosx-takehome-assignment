import { defineConfig } from "vitest/config";

/**
 * Vitest runs against the library modules only.
 *
 * The comparison logic is a pure module with no React and no DOM, so the tests
 * need no browser environment and no Next.js runtime - `node` is enough, and
 * it keeps the suite fast enough to run on every save.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
});

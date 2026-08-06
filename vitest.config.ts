import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The default worker-thread pool (tinypool) intermittently dies at collection
    // on Windows ("Cannot read properties of undefined (reading 'on')") — a red
    // that isn't a bug poisons the TDD signal. Child-process forks are stable,
    // and our suite spawns child processes anyway (hooks smoke tests).
    pool: "forks",
  },
});

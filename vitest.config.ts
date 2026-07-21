import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Replaces vitest's default exclude, so node_modules/dist must be restated.
    // .claude/** keeps agent worktrees (each a full repo copy) out of the run.
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**"],
  },
});

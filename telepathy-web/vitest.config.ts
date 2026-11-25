import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const projectRoot = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^~~\//, replacement: projectRoot },
      { find: /^~\//, replacement: projectRoot },
    ],
  },
  test: {
    environment: "happy-dom",
    include: ["services/**/*.spec.ts"],
    setupFiles: ["./tests/setup.ts"],
    // The fork pool cannot terminate its worker in this sandbox (kill EACCES).
    pool: "threads",
  },
});

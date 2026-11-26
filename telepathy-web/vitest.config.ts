import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

const projectRoot = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: [
      { find: /^~~\//, replacement: projectRoot },
      { find: /^~\//, replacement: projectRoot },
    ],
  },
  test: {
    environment: "happy-dom",
    include: ["tests/**/*.spec.ts", "services/**/*.spec.ts"],
    setupFiles: ["./tests/setup.ts"],
    // common-web ships raw .vue/.ts sources that must go through Vite's
    // transform pipeline in tests too.
    server: {
      deps: {
        inline: ["@devopsplaybook.io/common-web"],
      },
    },
    // The fork pool cannot terminate its worker in this sandbox (kill EACCES).
    pool: "threads",
  },
});

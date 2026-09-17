import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { compilerOptions } from "./tsconfig.json";

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      Object.entries(compilerOptions.paths).map(([name, [path]]) => [
        name,
        fileURLToPath(new URL(path, import.meta.url)),
      ]),
    ),
  },
});

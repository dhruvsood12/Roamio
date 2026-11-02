// Custom ESM loader for fresh-process tests that need @flightbrain/* package aliases.
// Used by TZ-isolation and fresh-process tests in connection-protection.test.ts.
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve as resolvePath, extname } from "node:path";
import { existsSync } from "node:fs";

const BASE = fileURLToPath(new URL("../..", import.meta.url));

const ALIASES = {
  "@flightbrain/domain": `${BASE}/packages/domain/src/index.ts`,
  "@flightbrain/composer": `${BASE}/packages/composer/src/index.ts`,
  "@flightbrain/orchestrator": `${BASE}/packages/orchestrator/src/index.ts`,
};

export function resolve(specifier, context, nextResolve) {
  if (ALIASES[specifier]) {
    return { url: pathToFileURL(ALIASES[specifier]).href, shortCircuit: true };
  }
  // Handle bare relative imports from our .ts source files (no extension -> try .ts)
  // Only applies when the parent is one of our source files (not node_modules)
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
    const ext = extname(specifier);
    if (!ext && context.parentURL.includes("/packages/")) {
      const parentDir = fileURLToPath(new URL(".", context.parentURL));
      const withTs = resolvePath(parentDir, specifier + ".ts");
      if (existsSync(withTs)) {
        return { url: pathToFileURL(withTs).href, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}

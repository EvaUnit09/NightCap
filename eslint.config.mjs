import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // src/retrieval hides its internals behind index.ts (decision-log #33).
    files: ["src/**/*.{ts,tsx,mts}", "app/**/*.{ts,tsx}", "evaluation/**/*.{ts,mts}", "scripts/**/*.{ts,mts}", "*.ts"],
    ignores: ["src/retrieval/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/retrieval/*", "!**/retrieval/index"],
              message: "Import retrieval only through src/retrieval/index.ts.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored pstack skills (including poteto-mode scripts/*.ts and *.mjs)
    ".cursor/**",
    // Static design-tool export; not app code.
    "docs/design_handoff_Frontend/**",
    ".arena/**",
  ]),
]);

export default eslintConfig;

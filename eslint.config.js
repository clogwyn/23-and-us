// Flat config shared by every workspace package.
// Module boundaries are enforced here so the architecture can't erode silently.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/.next/**", "**/node_modules/**", "**/*.gen.ts"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  // scheduler: pure engine — may depend on @reno/domain only, never on I/O or the app.
  {
    files: ["packages/scheduler/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@reno/db", "@reno/db/*", "@supabase/*", "next", "next/*", "react", "node:*"], message: "scheduler must stay pure: no I/O or framework imports." },
          ],
        },
      ],
    },
  },
  // domain: leaf package — no internal dependencies at all.
  {
    files: ["packages/domain/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["@reno/*", "@supabase/*", "next", "react", "node:*"], message: "domain is a leaf package." }] },
      ],
    },
  },
);

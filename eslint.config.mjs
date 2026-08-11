import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "coverage/**", "vendor/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "off"
    }
  },
  {
    files: ["apps/web-ui/**/*.tsx"],
    rules: { "no-undef": "off" }
  },
  {
    files: ["scripts/**/*.mjs", "eslint.config.mjs", "vitest.config.ts"],
    languageOptions: { globals: { console: "readonly", process: "readonly", fetch: "readonly", setTimeout: "readonly" } }
  }
);

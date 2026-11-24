import comments from "@eslint-community/eslint-plugin-eslint-comments/configs";
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/*
 * Lint, not formatting -- same split as the sibling projects. This config looks for defects and
 * leaves layout alone.
 */
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "test/fixtures/**"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
  comments.recommended,
  {
    // A directive that no longer suppresses anything is an error, so a stale one cannot linger.
    linterOptions: { reportUnusedDisableDirectives: "error" },
    // Every eslint-disable says why after `--`, so a suppression is a decision someone can read.
    rules: { "@eslint-community/eslint-comments/require-description": ["error", { ignore: ["eslint-enable"] }] },
  },
  {
    // Fixtures and hostile-input tests deliberately build malformed shapes.
    files: ["test/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);

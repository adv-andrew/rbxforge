import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "apps/extension/media/webview/**",
      "apps/extension/vendor/**",
      "artifacts/**",
      ".rbxforge-package/**",
      "outputs/**",
      "work/**",
      ".superpowers/**",
      "coverage/**",
    ],
  },
  {
    files: ["**/*.mjs"],
    ...js.configs.recommended,
    languageOptions: {
      globals: globals.node,
    },
  },
  ...tseslint.configs.strict.map((configuration) => ({
    ...configuration,
    files: ["**/*.ts", "**/*.tsx"],
  })),
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "prefer-const": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-empty-object-type": ["error", { allowInterfaces: "always" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["apps/desktop/src/renderer/**/*.ts", "apps/desktop/src/renderer/**/*.tsx"],
    languageOptions: {
      globals: {
        ...globals.browser,
        process: "off",
        Buffer: "off",
      },
    },
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["node:*"], message: "Renderer code must not import Node modules." }] },
      ],
    },
  },
  {
    files: ["apps/desktop/src/renderer/**/*.test.ts", "apps/desktop/src/renderer/**/*.test.tsx"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "no-restricted-imports": "off",
    },
  },
);

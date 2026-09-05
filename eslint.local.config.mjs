import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  { ignores: ["node_modules/**", "dist/**", "release/**", "src/**", ".lavish/**"] },
  {
    files: ["desktop/**/*.js", "scripts/build-local-native.js", "scripts/dev-local.js", "test/local/**/*.js"],
    languageOptions: { sourceType: "commonjs", ecmaVersion: "latest", globals: globals.node },
    rules: { ...js.configs.recommended.rules, "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }], "no-empty": ["error", { allowEmptyCatch: true }] },
  },
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: ["local-ui/**/*.ts", "local-ui/**/*.tsx", "desktop/**/*.d.ts"] })),
  { files: ["local-ui/**/*.ts", "local-ui/**/*.tsx"], languageOptions: { globals: globals.browser } },
  { files: ["local-ui/**/*.js"], languageOptions: { sourceType: "module", globals: { ...globals.browser, AudioWorkletProcessor: "readonly", registerProcessor: "readonly", sampleRate: "readonly" } }, rules: js.configs.recommended.rules },
];

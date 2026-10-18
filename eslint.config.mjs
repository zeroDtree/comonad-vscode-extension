// SPDX-License-Identifier: AGPL-3.0-only
import typescriptEslint from "typescript-eslint";

export default [{
    // Build output is not source: the plugin packages have a `dist` of their own beside their sources.
    ignores: ["**/dist/**", "out/**", "node_modules/**", "packages/comonad-plugin-math/resources/math.js"],
}, {
    files: ["**/*.ts"],
}, {
    plugins: {
        "@typescript-eslint": typescriptEslint.plugin,
    },

    languageOptions: {
        parser: typescriptEslint.parser,
        ecmaVersion: 2022,
        sourceType: "module",
    },

    rules: {
        "@typescript-eslint/naming-convention": ["warn", {
            selector: "import",
            format: ["camelCase", "PascalCase"],
        }],

        curly: "warn",
        eqeqeq: "warn",
        "no-throw-literal": "warn",
        semi: "warn",
    },
}];
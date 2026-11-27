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
}, {
    // The model runtime package is publishable on its own, so its sources must stay
    // host-free: no `src/` host modules (any relative escape resolves through a `src`
    // segment), no `vscode`/`cordis`, and no `@comonad/*` host namespace (the
    // `@comonad/model` alias included — internals import each other relatively).
    files: ["packages/comonad-model/src/**/*.ts"],
    rules: {
        "no-restricted-imports": ["error", {
            paths: [
                { name: "vscode", message: "@comonad/model must not depend on the VS Code API." },
                { name: "cordis", message: "@comonad/model must not depend on the host's service container." },
                { name: "schemastery", message: "@comonad/model must not depend on the host's config framework." },
            ],
            patterns: [{
                group: ["@comonad/*", "**/src/**", "**/src"],
                message: "@comonad/model must stay host-free: import package-internal modules relatively.",
            }],
        }],
    },
}];
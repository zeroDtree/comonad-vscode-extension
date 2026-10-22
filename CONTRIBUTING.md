# Contributing

Comonad is a VS Code extension built as one Cordis plugin tree. This page covers the local loop and
the rules that keep the tree honest.

## Setup

```sh
npm install
npm run compile       # typecheck + lint + bundle
```

Press `F5` to launch the Extension Development Host. Node 22 or newer is required.

To rebuild and install a normal extension build into VS Code:

```sh
./scripts/reinstall.sh            # build, package and install
./scripts/reinstall.sh --build-only
```

## Checks

```sh
npm run check-types
npm run lint
npm run compile-tests && npx mocha --ui tdd out/test/extension.test.js   # fast suite
npm test              # full VS Code test host
```

`npm test` activates the real extension in VS Code. The fast suite runs the real services on a
headless Cordis context with a fake host (`src/test/harness.ts`). A change to a gate, a graph route, a
tool schema or a settings key needs a test.

## Code

- `src/lib/` is pure domain code: no `vscode`, no `cordis`.
- `src/services/` are Cordis services; `src/tools/`, `src/llm/`, `src/ui/` and `src/plugins/` are
  plugins.
- Registrations are effects. If it is not registered through `ctx`, it does not disappear with its
  plugin, and that is a bug.
- Cross-module signals go through typed events (`src/events.ts`), not callbacks.
- Settings are declared in `package.json`, read in `src/services/settings.ts`, and tested against each
  other; a key added on one side only fails the suite.

## Docs

The public docs are VitePress pages under `docs/`. English is the root locale; `docs/zh/` is the
Chinese translation. `docs/internal/` is excluded from the site.

```sh
cd docs
npm install
npm run dev
npm run build
```

When changing user-visible behavior, update the page that owns it — not the README. The README is a
landing page and should stay short.

### Style

- One idea per paragraph; one sentence per line in the source.
- Sentence-case headings; one H1 per page.
- Backticks for identifiers, commands, settings and paths.
- Fenced code blocks carry a language.
- Tables for choices and defaults; avoid long bullet-essays.
- Explain a concept once and link to it elsewhere.
- No screenshots for now; Mermaid diagrams are welcome when they clarify a flow.
- Keep internal notes and status checklists in `docs/internal/`.

## Pull requests

- Keep one change per PR. Include the user-visible effect and the test that covers it.
- Run `npm run check-types`, `npm run lint` and `npm test` before pushing.
- Do not commit generated bundles or `docs/.vitepress/dist`.

## License

By contributing you agree that your contribution is licensed under AGPL-3.0-only.

import hljs from 'highlight.js/lib/common';

/**
 * The code-block highlighter for the chat webview. It is bundled beside `chat.js` and loaded before
 * it, exposing the usual `hljs` global; `chat.js` falls back to its own shell highlighter when the
 * file is absent. The common build covers Python, JavaScript/TypeScript, JSON, shell, C/C++, Java,
 * Go, Rust, SQL, Markdown and the rest of highlight.js's common set.
 */
(globalThis as Record<string, unknown>).hljs = hljs;

import type MarkdownIt from 'markdown-it'

/** Turn ```mermaid fences into the client-side Mermaid component. */
export function mermaidMarkdown(md: MarkdownIt): void {
  const fence = md.renderer.rules.fence!.bind(md.renderer.rules)
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!
    if (token.info.trim() === 'mermaid') {
      const id = `mermaid-${idx}`
      const graph = encodeURIComponent(token.content)
      return `<Suspense>
<template #default>
<Mermaid id="${id}" class="mermaid" graph="${graph}"></Mermaid>
</template>
<template #fallback>Loading…</template>
</Suspense>`
    }
    return fence(tokens, idx, options, env, self)
  }
}

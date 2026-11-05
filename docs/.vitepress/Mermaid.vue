<template>
  <div v-html="svg" :class="props.class"></div>
</template>

<script setup lang="ts">
import mermaid from 'mermaid'
import { onMounted, onUnmounted, ref, toRaw } from 'vue'
import { useData } from 'vitepress'
import { mermaidConfig } from './mermaid-config'

const props = defineProps<{
  graph: string
  id: string
  class?: string
}>()

const svg = ref<string | null>(null)
let observer: MutationObserver | null = null

const { page } = useData()
const mermaidPageTheme = toRaw(page.value).frontmatter.mermaidTheme as string | undefined

async function renderChart(): Promise<void> {
  const dark = document.documentElement.classList.contains('dark')
  const config = { ...mermaidConfig }
  if (mermaidPageTheme) {
    config.theme = mermaidPageTheme
  }
  if (dark) {
    config.theme = 'dark'
  }
  mermaid.initialize(config)
  const code = decodeURIComponent(props.graph)
  const { svg: rendered } = await mermaid.render(props.id, code)
  const salt = Math.random().toString(36).slice(2, 9)
  svg.value = `${rendered} <span style="display: none">${salt}</span>`
}

onMounted(async () => {
  observer = new MutationObserver(() => {
    void renderChart()
  })
  observer.observe(document.documentElement, { attributes: true })
  await renderChart()
})

onUnmounted(() => observer?.disconnect())
</script>

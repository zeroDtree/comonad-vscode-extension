import type { MermaidConfig } from 'mermaid'

/** Site-wide Mermaid init passed to every diagram render. */
export const mermaidConfig: MermaidConfig = {
  securityLevel: 'loose',
  startOnLoad: false,
  layout: 'elk',
  look: 'neo',
  theme: 'redux-color',
  themeVariables: {
    fontSize: '15px',
    // Redux themes name "Recursive Variable", which is not loaded here. A missing
    // face plus VitePress's border-box reset clips the line after <br>.
    fontFamily: 'Inter, "PingFang SC", "Noto Sans SC", ui-sans-serif, system-ui, sans-serif',
  },
  flowchart: {
    useMaxWidth: false,
    htmlLabels: true,
    wrappingWidth: 260,
    nodeSpacing: 32,
    rankSpacing: 52,
    padding: 10,
    curve: 'linear',
  },
  elk: {
    lineHops: 'arc',
  },
}

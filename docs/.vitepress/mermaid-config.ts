import type { MermaidConfig } from 'mermaid'

/** Site-wide Mermaid init passed to every diagram render. */
export const mermaidConfig: MermaidConfig = {
  securityLevel: 'loose',
  startOnLoad: false,
  layout: 'elk',
  elk: {
    lineHops: 'arc',
  },
}

import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

const GITHUB = 'https://github.com/zeroDtree/comonad-vscode-extension'

const config = withMermaid(
  defineConfig({
    title: 'Comonad',
    description: 'A local-first, auditable coding agent for VS Code',
    base: '/comonad-vscode-extension/',
    lastUpdated: true,
    srcExclude: ['internal/**'],
    head: [['meta', { name: 'theme-color', content: '#0f1116' }]],
    themeConfig: {
      socialLinks: [{ icon: 'github', link: GITHUB }],
      editLink: {
        pattern: 'https://github.com/zeroDtree/comonad-vscode-extension/edit/main/docs/:path',
        text: 'Edit this page',
      },
      search: {
        provider: 'local',
        options: {
          locales: {
            zh: {
              translations: {
                button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
                modal: {
                  displayDetails: '显示详细列表',
                  noResultsText: '无法找到相关结果',
                  resetButtonTitle: '清除查询条件',
                  footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
                },
              },
            },
          },
        },
      },
    },
    locales: {
      root: {
        label: 'English',
        lang: 'en-US',
        description: 'A local-first, auditable coding agent for VS Code',
        themeConfig: {
          nav: [
            { text: 'Guide', link: '/guide/chat' },
            { text: 'Reference', link: '/reference/commands' },
            { text: 'GitHub', link: GITHUB },
          ],
          outline: { label: 'On this page' },
          sidebar: [
            {
              text: 'Guide',
              items: [
                { text: 'Overview', link: '/' },
                { text: 'Chat', link: '/guide/chat' },
                { text: 'Safety', link: '/guide/safety' },
                { text: 'Context', link: '/guide/context' },
                { text: 'Graphs', link: '/guide/graphs' },
                { text: 'Checkpoints and review', link: '/guide/checkpoints' },
                { text: 'Content layer', link: '/guide/content' },
                { text: 'Extending', link: '/guide/extend' },
                { text: 'Remote and containers', link: '/guide/remote' },
              ],
            },
            {
              text: 'Reference',
              items: [
                { text: 'Commands', link: '/reference/commands' },
                { text: 'Tools', link: '/reference/tools' },
                { text: 'Settings', link: '/reference/settings' },
              ],
            },
            {
              text: 'Development',
              items: [{ text: 'Architecture and development', link: '/development' }],
            },
          ],
        },
      },
      zh: {
        label: '中文',
        lang: 'zh-CN',
        description: '本地优先、可审计的 VS Code coding agent',
        themeConfig: {
          nav: [
            { text: '指南', link: '/zh/guide/chat' },
            { text: '参考', link: '/zh/reference/commands' },
            { text: 'GitHub', link: GITHUB },
          ],
          outline: { label: '本页目录' },
          docFooter: { prev: '上一页', next: '下一页' },
          returnToTopLabel: '返回顶部',
          sidebarMenuLabel: '菜单',
          darkModeSwitchLabel: '外观',
          lightModeSwitchTitle: '切换到浅色模式',
          darkModeSwitchTitle: '切换到深色模式',
          langMenuLabel: '切换语言',
          sidebar: [
            {
              text: '指南',
              items: [
                { text: '概览', link: '/zh/' },
                { text: '聊天', link: '/zh/guide/chat' },
                { text: '安全', link: '/zh/guide/safety' },
                { text: '上下文', link: '/zh/guide/context' },
                { text: '图', link: '/zh/guide/graphs' },
                { text: '检查点与审查', link: '/zh/guide/checkpoints' },
                { text: '内容层', link: '/zh/guide/content' },
                { text: '扩展', link: '/zh/guide/extend' },
                { text: '远程与容器', link: '/zh/guide/remote' },
              ],
            },
            {
              text: '参考',
              items: [
                { text: '命令', link: '/zh/reference/commands' },
                { text: '工具', link: '/zh/reference/tools' },
                { text: '设置', link: '/zh/reference/settings' },
              ],
            },
            {
              text: '开发',
              items: [{ text: '架构与开发', link: '/zh/development' }],
            },
          ],
        },
      },
    },
  }),
)

// mermaid 11 no longer depends on debug; the plugin still lists it for prebundle.
const include = config.vite?.optimizeDeps?.include
if (include) {
  config.vite!.optimizeDeps!.include = include.filter((id) => id !== 'debug')
}

export default config

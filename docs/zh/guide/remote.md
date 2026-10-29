# 远程与容器

Comonad 是 **workspace extension**。在远程窗口中，VS Code 会把它安装到远程主机，agent 就在那里运行 ——
紧挨着它驱动的文件、shell、git、MCP 服务器和 hooks。窗口只负责渲染结果。这与 Cursor、Copilot 的拆分
方式相同。

## 凭证

API key 存在 VS Code `SecretStorage` 中，即使扩展在远程，它也是客户端侧的：key 由本地 OS keychain
加密，不会写进远程工作区或 `~/.vscode-server`。请求时只读入远程扩展宿主的内存。

已存储的 key 属于**端点**（规范化后的 base URL），所以指向该端点的所有 profile 共用它。`keyEnv` 是
例外 —— 它读取**远程**环境。

## 从远程主机调用模型

base URL 为 `localhost` 的 profile 指向远程机器。要访问你自己电脑上的模型服务器，在
`~/.ssh/config` 中转发：

```text
Host devbox
  HostName devbox.example.com
  RemoteForward 11434 127.0.0.1:11434
```

然后在远程窗口中使用 `http://127.0.0.1:11434/v1`。**Comonad: Configure Model** 在远程保存回环 base
时会警告。

## 沙箱

Linux 使用 `bwrap`，macOS 使用 `sandbox-exec`。两者都不可用时 —— 服务器和 Windows 上很常见 ——
`/status`、聊天和设置面板会显示 **no OS sandbox**，并且除非 Sandbox mode 是 `danger-full-access` 且
Network access policy 为 on，shell 命令会被拒绝。在远程安装 bubblewrap，或在你确实接受无约束命令时
显式选择该组合。

## 其他一切也在远程

会话、审计日志、检查点和 tokenizer 文件都在远程扩展的全局存储中。MCP 服务器和 hooks 在远程启动。
多根工作区使用第一个文件夹作为工作目录；需要时用 `comonad.workingDirectory` 绑定其他文件夹。

## 下一步

- [安全](/zh/guide/safety) —— 沙箱与审批细节
- [设置](/zh/reference/settings) —— `workingDirectory`、`sandboxMode`、`profiles`

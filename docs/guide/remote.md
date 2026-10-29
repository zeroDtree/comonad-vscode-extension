# Remote and containers

Comonad is a **workspace extension**. In a remote window VS Code installs it on the remote host, and
the agent runs there — beside the files, shell, git, MCP servers and hooks it drives. The window only
renders the result. This is the same split Cursor and Copilot use.

## Credentials

API keys are stored with VS Code `SecretStorage`, which is client-side even for a remote extension:
the key is encrypted by your local OS keychain and is not written to the remote workspace or
`~/.vscode-server`. It is read into the remote extension host's memory when a request is made.

A stored key belongs to the **endpoint** (its normalized base URL), so every profile pointing at that
endpoint shares it. `keyEnv` is the exception — it reads the **remote** environment.

## Model calls from a remote host

A profile whose base URL is `localhost` points at the remote machine. To reach a model server on your
own computer, forward it in `~/.ssh/config`:

```text
Host devbox
  HostName devbox.example.com
  RemoteForward 11434 127.0.0.1:11434
```

Then use `http://127.0.0.1:11434/v1` in the remote window. **Comonad: Configure Model** warns when a
loopback base is saved remotely.

## Sandboxing

Linux uses `bwrap`, macOS `sandbox-exec`. When neither is available — common on servers and on
Windows — `/status`, the chat and the settings panel say **no OS sandbox**, and shell commands are
refused unless the sandbox mode is `danger-full-access` and network access is on. Install bubblewrap
on the remote, or choose that combination deliberately when you accept unconfined commands.

## Everything else is remote

Sessions, audit logs, checkpoints and tokenizer files live in the remote extension's global storage.
MCP servers and hooks spawn on the remote. Multi-root workspaces use the first folder as the working
directory; bind another folder with `comonad.workingDirectory` if needed.

## Next

- [Safety](/guide/safety) — sandbox and approval details
- [Settings](/reference/settings) — `workingDirectory`, `sandboxMode`, `profiles`

# claude-proxy

English · [Русский](README.ru.md)

An ACP agent that runs Claude Code inside an editor. The editor starts it over
stdio and talks to it by the [Agent Client Protocol](https://agentclientprotocol.com);
it drives Claude Code through the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript).
The agent works as itself — its own system prompt, tools, settings, `CLAUDE.md`,
skills and subagents — while the editor shows what it does and answers what it asks.

> [!WARNING]
> A turn is paid for by whatever the local Claude Code is logged in to.
> Anthropic [does not allow](https://code.claude.com/docs/en/agent-sdk/overview)
> third-party products to use claude.ai login or subscription limits without its
> approval, so an editor working through this host on a Pro or Max plan puts the
> account at risk.

## What you need

Claude Code, logged in, and Node 22 or newer. The host runs the Claude Code binary
that ships with the SDK; `CLAUDE_CODE_EXECUTABLE` points it at another one.

```bash
git clone https://github.com/GlebSmolyakov/claude-proxy.git
cd claude-proxy
pnpm install
pnpm run build
```

## Wire it into an editor

In JetBrains Air: _task panel > agent picker > Add ACP Agent_. Air opens `acp.json`,
on macOS `~/Library/Application Support/JetBrains/Air/acp.json`. Zed keeps the same
shape under `agent_servers` in its `settings.json`.

```json
{
  "agent_servers": {
    "Claude Code": {
      "command": "node",
      "args": ["/path/to/claude-proxy/dist/index.js"]
    }
  }
}
```

The agent appears in the picker and works in the open project.

## Options

| Option              | Default       | What it sets                                                                           |
| ------------------- | ------------- | -------------------------------------------------------------------------------------- |
| `--permission-mode` | `default`     | Mode of new sessions: `default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions` |
| `--model`           | the CLI's own | Model of every session: an alias or a full id                                          |
| `--idle-minutes`    | `30`          | Stop an agent left unused this long; `0` keeps it running                              |
| `--login`           |               | Hand the terminal to Claude Code's own sign-in                                         |
| `LOG_LEVEL`         | `info`        | `debug` adds the CLI's stderr; everything goes to stderr, stdout carries the protocol  |

## What the editor gets

|                 |                                                                                         |
| --------------- | --------------------------------------------------------------------------------------- |
| The answer      | text and thinking as they are written                                                   |
| Every tool call | a card with its title, the diff of an edit, the result, and the plan the agent keeps    |
| Tokens          | what the context holds and what the turn cost                                           |
| Approval        | a dialog per action, with the modes the session can switch between                      |
| Questions       | the agent's own and an MCP server's, as a form                                          |
| Files           | read and written through the editor's buffers, so unsaved changes count                 |
| Commands        | run in a terminal the editor opens, watched as they go                                  |
| Sessions        | picked up again with `session/load`, closed with `session/close`, and stopped when idle |
| Settings        | model, effort and thinking, and the CLI's slash commands                                |

Whatever the editor says it cannot do stays with the agent: files go to disk,
commands run behind the scenes, and questions are not asked.

## What it does not do

The queue is in [TODO.md](TODO.md). The short of it: a redirected `Bash` has no
shell that remembers `cd`, a background command's output is only in the terminal,
subagents show their tool calls but not their text, and a `url` elicitation is
declined.

## Development

```bash
pnpm test
pnpm run check
```

# claude-proxy

English · [Русский](README.ru.md)

The agent edits a file, you see the diff on a card in your editor and press "allow". The edit lands in the editor's buffer, where you can see it and undo it, instead of going to disk behind your back. Inside runs ordinary Claude Code: its own system prompt, its own tools, `CLAUDE.md`, skills, subagents, your settings and your MCP servers. Outside it speaks [Agent Client Protocol](https://agentclientprotocol.com) to the editor, and the engine is the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript).

> [!WARNING]
> A turn is paid for by whatever the local Claude Code is logged in to. Anthropic [does not allow](https://code.claude.com/docs/en/agent-sdk/overview) third-party products to use claude.ai login or subscription limits without its approval, so an editor working through this host on Pro or Max puts the account at risk.

## Install

You need Node 22 or newer and Claude Code logged in to your account.

```bash
git clone https://github.com/GlebSmolyakov/claude-proxy.git
cd claude-proxy
pnpm install
pnpm run build
```

The Claude Code binary is the one that ships with the SDK. To run the `claude` you installed yourself, put its path in `CLAUDE_CODE_EXECUTABLE`.

## Point an editor at it

In JetBrains Air: _task panel → agent picker → Add ACP Agent_. Air opens `acp.json`, on macOS `~/Library/Application Support/JetBrains/Air/acp.json`. Zed keeps the same shape under `agent_servers` in its `settings.json`.

```json
{
  "agent_servers": {
    "Claude Code": {
      "command": "node",
      "args": ["/Users/you/WebstormProjects/claude-proxy/dist/index.js"]
    }
  }
}
```

The agent shows up in the picker and works in the open project.

## How it works

The editor starts `dist/index.js` as a plain program and talks to it over stdin and stdout with JSON-RPC. Nothing but the protocol goes to stdout; logs go to stderr.

```
editor ──stdio──▶ claude-proxy ──▶ Claude Code (Agent SDK)
   ▲                   │
   └── session events ◀┘   cards, text, permissions, files, terminal
```

### One agent per session

`session/new` sets up a session: the project folder, the permission mode, the model. No process yet. The first prompt starts one, and it stays: later prompts go into the same input stream, while the conversation, its compaction and its context live inside the CLI. A turn pays for no spawn and no transcript replay.

An agent nobody has used for 30 minutes is stopped and its session stays behind. The next prompt starts a new agent and resumes the conversation by the session id, which is also what happens after a process dies mid-work. `session/close` stops the agent at once and hands its terminals back to the editor.

### What the editor gets

Every message from the SDK becomes a `session/update`:

| From the agent           | In the editor                                 |
| ------------------------ | --------------------------------------------- |
| text and thinking        | the answer as it is written                   |
| the start of a tool call | a card for the action                         |
| its input and its result | title, the diff of an edit, output, status    |
| `TodoWrite` and tasks    | the plan as a list                            |
| token counts             | what the context holds and what the turn cost |

A card opens as soon as the tool is named and is refined when its full input arrives: first "Edit", then "Edit src/a.ts" with the diff.

### What the editor gives back

All of this follows what the editor said about itself in `initialize`.

- **Files.** With `fs/read_text_file` and `fs/write_text_file`, the built-in `Read`, `Write` and `Edit` are redirected to them. The agent sees unsaved changes, and its own edits land in the buffer.
- **Terminal.** With `terminal/create`, `Bash` runs in a terminal the editor opens, and that terminal stays on the tool call's card while the command runs.
- **Permissions.** Whatever the session mode and your settings leave open goes to a dialog: "Allow", "Always allow" when the CLI suggested a rule, and "Reject". Reading inside the session's folders passes without a dialog, as the built-in `Read` does.
- **Questions.** With form elicitation, the agent asks through `AskUserQuestion`, and an MCP server's request for input goes the same way. Without it, asking is off.
- **Sign-in.** With terminal authentication, the sign-in list gets an entry that runs `claude auth login`.

What the editor did not claim stays with the agent: files go to disk, commands run out of sight, questions are not asked.

### Session settings

`session/set_mode` switches between `default`, `acceptEdits`, `plan`, `dontAsk` and `bypassPermissions`. `session/set_config_option` changes the model, the effort level and thinking. The model switches on a running agent; effort and thinking are set when an agent starts, so an idle one is stopped for them and the next prompt starts one that has them, with the conversation intact.

The model list starts as the aliases and is replaced by what the account really has once an agent has run. The editor gets the CLI's slash commands at the same time, your own among them; a command typed as a prompt runs and answers as a message from the agent.

### Old sessions

`session/load` reads the conversation the CLI saved and replays it as events: the user's messages, the agent's text and thinking, a card per tool call with its result, the plan. The next prompt then carries on in that same session.

## Options

| Option              | Default       | What it sets                                            |
| ------------------- | ------------- | ------------------------------------------------------- |
| `--permission-mode` | `default`     | Mode of new sessions                                    |
| `--model`           | the CLI's own | Model of every session: an alias or a full id           |
| `--idle-minutes`    | `30`          | When to stop an agent left unused; `0` keeps it running |
| `--login`           |               | Hand the terminal to Claude Code's own sign-in          |
| `LOG_LEVEL`         | `info`        | `debug` adds the CLI's stderr                           |

## What is not here

- A redirected `Bash` has no shell that remembers `cd` between calls, and a background command's output stays in the editor's terminal only.
- Subagents show their tool calls but not their text: ACP 1.4 has no nested transcript to put it in.
- A `url` elicitation from an MCP server is declined: finishing one in a browser needs a channel back that this host does not have.
- Fast mode is not a session option; `query()` has none to carry it.

The rest is in [TODO.md](TODO.md).

## Development

```bash
pnpm test
pnpm run check
```

```
src/
├── index.ts          arguments, the CLI binary, the ACP app on stdio
├── acp-agent.ts      session methods, permissions, questions, the agent's life
├── agent.ts          query() options and the session's input stream
├── session.ts        session state and tool call cards
├── updates.ts        SDK messages → session/update events
├── tools.ts          a card's title, kind, diff and result, and the plan
├── editor-tools.ts   files and commands through the editor
├── terminal.ts       bash in the editor's terminal
├── questions.ts      the agent's and an MCP server's questions as a form
├── config.ts         model, effort, thinking
├── permissions.ts    session modes and the answers a dialog offers
├── prompt.ts         an ACP prompt → the agent's user message
├── models.ts         which model names `--model` takes
└── log.ts            logging to stderr
```

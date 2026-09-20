# What is left

The five steps of the architecture note are done, and so are the model
picker, `session/load` and the agent's own questions. What follows is the
queue, most useful first.

## For real work in an editor

- [ ] **`session/close` and idle sessions.** An agent lives as long as the
      whole connection. Close a tab and its CLI process stays. A day of work
      piles them up.
- [ ] **A terminal for `Bash`.** ACP has `terminal/create`, and the official
      adapter streams a command's output into the editor's terminal. Here the
      output arrives once, whole, as text on the card.
- [ ] **Slash commands.** `available_commands_update` is never sent, so
      `/compact`, `/clear` and the user's own commands reach the model as
      plain text.
- [ ] **`auth_required` when the CLI is not logged in.** Today that is error
      text on a prompt, and the editor has nothing to offer the user.

## Smaller tails

- [ ] The plan starts empty after `session/load`: the replay does not rebuild it.
- [ ] Subagents show only their tool calls; their text is not forwarded.
- [ ] MCP elicitations are still declined by the SDK itself.
- [ ] Thinking level, effort and fast mode are not session config options,
      though the picker they would live in already exists.
- [ ] A tool card carries its output twice, as content and as `rawOutput`.
      On a large file that is traffic for nothing.

## Around the code

- [ ] No README, and the repository is public.
- [ ] No CI.
- [ ] The package is `private`, so the agent is started by the path to
      `dist/index.js`; there is no guide for wiring it into Air or Zed.
- [ ] `docs/agent-host-architecture.ru.md` in claude-max-api-proxy-rs still
      says this host is not implemented and will not be.

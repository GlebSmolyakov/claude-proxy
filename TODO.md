# What is left

The five steps of the architecture note are done, and so is what an editor
needs for daily work: the model picker, `session/load`, the agent's own
questions, closing and idling sessions, a terminal for commands, slash
commands, and a sign-in the editor can act on. What follows is the queue,
most useful first.

## Smaller tails

- [ ] A sign-in cannot be started from the editor. Where the client has
      terminals, the agent could offer an auth method that runs
      `claude auth login` in one.
- [ ] A redirected `Bash` has no shell that remembers `cd` between calls, and
      a background command's output cannot be read back: it only goes to the
      terminal the user watches.
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

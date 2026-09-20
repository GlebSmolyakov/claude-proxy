# What is left

The five steps of the architecture note are done, and so are the model
picker, `session/load` and the agent's own questions. What follows is the
queue, most useful first.

## For real work in an editor

- [ ] **`auth_required` when the CLI is not logged in.** Today that is error
      text on a prompt, and the editor has nothing to offer the user.

## Smaller tails

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

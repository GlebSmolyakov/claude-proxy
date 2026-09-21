# What is left

The five steps of the architecture note are done, and so is what an editor
needs for daily work: the model picker, `session/load`, the agent's own
questions, closing and idling sessions, a terminal for commands, slash
commands, and a sign-in the editor can act on. What follows is the queue,
most useful first.

## Next, in this order

## Smaller tails

- [ ] Air keeps its own MCP server to itself, so the browser tools have not
      been proxied against a live one yet.

- [ ] A background command's output cannot be read back: it only goes to the
      terminal the user watches. ACP terminals have no stdin either, so a
      command the agent should answer is out of reach as well.
- [ ] Subagents show only their tool calls. ACP 1.4 has no nested transcript
      to put their text in, so forwarding it would drop it into the main one;
      their calls already carry `_meta.claudeCode.parentToolUseId`.
- [ ] A `url` elicitation from an MCP server is declined: finishing one in a
      browser needs a channel back that this host does not have.
- [ ] Fast mode is not a session config option. Unlike effort and thinking it
      has no `query()` option to carry it.

## Around the code

- [ ] The package is `private` and nothing is published, so the agent is
      started by the path to `dist/index.js`.
- [ ] No LICENSE file, and the repository is public.
- [ ] `docs/agent-host-architecture.ru.md` in claude-max-api-proxy-rs still
      says this host is not implemented and will not be.

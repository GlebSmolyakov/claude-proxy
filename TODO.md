# What is left

The five steps of the architecture note are done, and so is what an editor
needs for daily work: the model picker, `session/load`, the agent's own
questions, closing and idling sessions, a terminal for commands, slash
commands both the CLI's and this host's own, MCP servers carried over on
request, and a sign-in the editor can act on.

What is left is what the protocol or the CLI gives no way to do, and two
things that need a live run to be sure of.

- [ ] Air keeps its own MCP server to itself, so the browser tools have not
      been proxied against a live one yet.
- [ ] `/rewind` has only met a scripted CLI. Whether a session that idled out
      and resumed still has its checkpoints is a live question.
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

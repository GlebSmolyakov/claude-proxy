# What is left

The five steps of the architecture note are done, and so is what an editor
needs for daily work: the model picker, `session/load`, the agent's own
questions, closing and idling sessions, a terminal for commands, slash
commands, and a sign-in the editor can act on. What follows is the queue,
most useful first.

## Next, in this order

- [ ] **Subscription limits in the editor.** The CLI reports what each window
      has spent and the host drops it. Say it in the chat when a window
      crosses a threshold, and write every reading to the log.
- [ ] **Per-project settings.** Model, mode and idle limit are flags for the
      whole process, while a project is what they belong to. A
      `.claude-proxy.json` next to the code would set them, with the flags as
      the default.
- [ ] **A list of past sessions.** `session/load` is here, `session/list` is
      not, so an editor cannot offer yesterday's conversation. The SDK lists
      sessions, titles them and renames them.
- [ ] **A proxy for Air's browser.** Its own MCP server drives the preview:
      clicks, console, network, screenshots. Worth it when a web project
      needs it, and worth proxying rather than passing through so a
      screenshot lands on the card as a picture.

## Smaller tails

- [ ] A redirected `Bash` has no shell that remembers `cd` between calls, and
      a background command's output cannot be read back: it only goes to the
      terminal the user watches.
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

# DRAFT de issue para anthropics/claude-code (revisar e postar manualmente)

Reproduzido em claude CLI 2.1.224, Windows 11, PowerShell spawn, TUI mode.
Sonda completa: `probe-claude-qa-resume-mcp.mjs` (runs R1–R10, 2026-08-07).
Postar só depois de re-testar na versão corrente do CLI.

---

**Title:** MCP tools are silently missing from a turn that starts before the
MCP handshake completes — even when tools/list is served mid-turn

**Body:**

## Summary

When a turn starts before an MCP server's `initialize`/`tools/list` handshake
has completed, the tools from that server are missing from the entire turn's
tool catalog. If the model then emits a `tool_use` for one of those tools
(e.g. because it is resuming a conversation where the tool was previously
used), the runtime replies "No such tool available". There is no warning that
a configured `--strict-mcp-config` server was not ready when the turn began.

This bites hardest with `--resume`: the resumed conversation "knows" the tool
from its history, so the model calls it on the very first assistant request of
the turn, before any built-in tool round-trip has given the handshake time to
finish.

## Repro (verified on 2.1.224, Windows 11)

1. A minimal streamable-HTTP MCP server that answers `initialize` and
   `tools/list` correctly but with an artificial 4s delay (simulating a busy
   host process).
2. Launch the TUI:
   `claude --model haiku --mcp-config probe.json --strict-mcp-config --permission-mode bypassPermissions --resume <session created earlier with the same config>`
3. Type a short prompt immediately (before the handshake finishes):
   "Call the tool mcp__probe__my_tool ... reply DONE, or NO-TOOL if unavailable."

Observed (server-side log confirms the order of events):

- `initialize` request arrives; response delayed 4s.
- The user turn starts meanwhile.
- `notifications/initialized` + `tools/list` complete DURING the turn — the
  server demonstrably served the tool.
- The model answers NO-TOOL / "No such tool available". The tool never joins
  the running turn.

Control runs: identical spawn with no server delay (or with the prompt typed
after the handshake) works — the tool is listed and called successfully. The
same failure also reproduces on a fresh (non-resumed) session if the prompt is
submitted early, so this is about turn-start vs handshake timing, not resume
per se; resume merely makes the model *try* the tool on request 1.

Additional data point: with a 12s server delay the client appears to give up
on the server entirely (no `tools/list` is ever issued afterwards), still with
no user-visible warning.

## Expected

One of:
- The first assistant request of a turn waits (bounded) for configured
  `--strict-mcp-config` servers to finish their handshake; or
- tools that become available mid-turn are merged into the running turn's
  catalog on the next assistant request; or
- at minimum, a visible warning ("MCP server X was not ready when this turn
  started; its tools are unavailable for this turn").

## Environment

- claude CLI 2.1.224 (also relevant to earlier versions; not a regression as
  far as we can tell — timing-dependent)
- Windows 11 Pro, spawned under ConPTY via PowerShell `-EncodedCommand`
- MCP: streamable HTTP, bearer auth, `--strict-mcp-config`

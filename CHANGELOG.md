# Changelog

Notable changes per release. The packages version independently but ship together.

## 0.1.1 — the first version on npm

`@thinking-treelog/core` 0.1.1 · `@thinking-treelog/cli` 0.1.1 ·
`@thinking-treelog/mcp` 0.1.2

### Fixed

- **The CLI could not start on Node 18 or 20.** `workspace.js` imported
  `zstdDecompressSync` by name from `node:zlib`, and that export only exists from
  Node 22.15. A missing named export fails while the module graph loads, so every
  command broke — including ones that never read a session log. It is a namespace
  import with a lazy accessor now: only `pulse` needs zstd, and only `pulse` fails,
  with a version message instead of a stack trace.
- **`npm pack` for the MCP server left out `tools.mjs`**, so the published tarball
  would have crashed on first run. `server.mjs` imports it.
- **Importing the MCP package started a server.** `createInterface` and the process
  handlers ran at module scope, hanging any tool that merely imported it. The loop
  lives in `start()` and only runs when the file is the process entry point.
- `pulse --demo` reported `0 轮` next to ten messages; a log without `turn/start`
  records now counts one turn per question.
- The demo transcript was anchored to a fixed date, so a week after release it read
  "last active 6 days ago". It is anchored to today.

### Changed

- `treelog weekly` accepts several directories and reports per repo.
- `treelog weekly --since-last-tag` reports by release instead of by calendar week,
  falling back to the day window when no tag exists.
- `weekly_report` MCP tool — the report no longer needs a terminal.

## Unreleased

### Added

- `treelog pulse` — reads the live agent session and prints what you were doing, the tool
  mix and the next move. Works on the dsh session log, `--file <transcript>`, or `--demo`.
- `treelog retro` — writes a Markdown retrospective: what was asked, what finished, a table
  of question scores with what each one left out, and a rewrite for the worst one.
- `treelog rhythm` — reads a repo's git history and reports active days, sprint phases,
  theme mix, whether it has stalled, and what to pick up next.
- `treelog trace` — checks that every decision in a spec has a task in the plan.
- `project_rhythm` and `workspace_pulse` MCP tools.
- Panel: one-click workspace analysis, hover reviews (优点 / 不足 / 下一步), per-node
  annotations, `＋ 创新想法`, double-click to jump back to the message, AI 深评 through your
  own endpoint.
- Question scoring: numbers, acceptance lines, reasons and scope creep, 0–100.

### Changed

- Host decompression is async and batched, so analysing a long session no longer stalls the
  main process.
- The panel detail rail is pinned to the viewport; it used to land off screen because the
  host column is wider than the visible area.
- A click with up to 6px of hand shake is treated as a click, not a pan.
- Session titles are cached by file + mtime.
- `--file` accepts one-turn-per-line exports, not just blank-line separated ones.
- Pasted transcripts use a fixed clock, so the same file always reports the same.
- The LLM key lives in tab memory (`sessionStorage`), not `localStorage`.
- `workspace_pulse` explains an empty machine instead of throwing.

### Fixed

- The dock had no stylesheet outside the panel, so it rendered as unstyled white text.
- Workspace trees were being linted as reasoning chains (131 findings).
- Injected harness reminders and checkpoint digests leaked into the thread.
- zstd sessions are one frame per append; only the first frame was being read.

## 0.1.0

Initial: rule-based extraction, tree layout, branch experiments, Markdown/Mermaid/SARIF/ADR
export, and the reasoning-gap lint with nine rules.

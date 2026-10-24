# Changelog

Notable changes per release. The packages version independently but ship together.

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

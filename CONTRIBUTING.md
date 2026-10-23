# Contributing

Thanks for looking. This project is small and stays that way on purpose.

## Ground rules

- **No new runtime dependencies without a strong reason.** The dsh Client half is loaded
  as a browser module and cannot import npm packages, and the MCP server speaks raw
  JSON-RPC so it installs instantly. Both constraints are load-bearing.
- **The two engines must not drift.** `packages/core` and
  `packages/dsh-plugin/client.js` each carry the extraction engine. Any change to one
  must be mirrored in the other, and `npm run test:consistency` must stay green.
- **Normalisation is not optional.** Anything coming from a model, a paste, or old
  storage is untrusted. New fields need a repair path in `normalizeNodes`.

## Before opening a PR

```bash
npm install
npm run verify
```

`verify` runs the core tests, the client smoke test, the client ⇄ core parity test, and
the MCP tool tests. All of them run in-process — no browser, no network.

## Adding a node type

1. Add it to `TYPE_ORDER` and `TYPE_META` in **both** engines.
2. Add its cue pattern to `TYPE_CUES` (order matters — earlier rules win, and explicit
   questions are handled before the table).
3. Add a colour to the Mermaid `classDef` list.
4. Extend the fixtures in `scripts/consistency.test.mjs` so parity covers it.

## Adding an MCP tool

1. Add the schema to `TOOLS` in `packages/mcp/tools.mjs`.
2. Add the branch to `callTool`.
3. Add a test to `scripts/mcp.test.mjs`.

## Reporting bugs

Include the pasted input that produced the odd tree. Extraction is deterministic in rule
mode, so a reproducible input is usually enough to diagnose it.

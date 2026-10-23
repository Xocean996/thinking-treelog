# Thinking TreeLog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn conversations, design docs and implementation plans into navigable thought trees, and lint them for reasoning gaps in CI.

**Architecture:** A pure engine (extraction, graph, layout, lint) feeds four hosts: a dsh panel, a CLI, an MCP server, and a library. The dsh panel is self-contained because the host loads it as a browser module; a parity test keeps it honest against the engine.

**Tech Stack:** Node 18+, ESM, zero runtime dependencies in the CLI and MCP server, React (host-provided) in the dsh panel.

**Spec:** docs/project-spec.md

## Global Constraints

- No runtime dependencies outside the workspace packages
- The dsh panel must not import npm packages at runtime
- Every finding carries a stable fingerprint: `rule|file|label`
- Node ids are positional (`n1`, `md3`, `p1`) and never user-visible

## Review Focus

- A plan whose tasks declare interfaces nobody produces: `undefined-consume` must fire
- A spec whose Decision section is empty: trace must fall back to node types, not crash
- A 400 KiB markdown corpus: parse must not throw on fenced code or HTML tables
- A Windows path with backslashes: SARIF and annotations must still resolve
- Two corpora with identical geometry: the panel must re-fit when you switch trees

---

### Task 1: Rule extraction and normalisation

**Files:**
- Create: `packages/core/src/index.js`
- Test: `packages/core/test/core.test.js`

**Interfaces:**
- Produces: `extractWithRules(text: string): ThoughtNode[]`
- Produces: `normalizeNodes(raw: unknown[]): ThoughtNode[]`

- [ ] **Step 1: Write the failing test for repaired hostile input**

```js
const repaired = normalizeNodes([{ id: 'a', parentId: 'ghost', text: 'x' }]);
assert.equal(repaired[0].parentId, null);
```

- [ ] **Step 2: Implement `normalizeNodes(raw: unknown[]): ThoughtNode[]` in `packages/core/src/index.js`**

Repair dangling parents, duplicate ids, cycles, unknown types, and out-of-range confidence.

- [ ] **Step 3: Verify the engine suite**

Run: `node packages/core/test/core.test.js`
Expected: PASS with 8 tests

### Task 2: Markdown parsing and reasoning lint

**Files:**
- Create: `packages/core/src/engineering.js`
- Test: `scripts/engineering.test.mjs`

**Interfaces:**
- Consumes: `normalizeNodes(raw: unknown[]): ThoughtNode[]` from Task 1
- Produces: `parseMarkdown(source: string): ThoughtNode[]`
- Produces: `lintTree(nodes: ThoughtNode[]): Finding[]`

- [ ] **Step 1: Run the lint suite against the imperfect ADR fixture**

Run: `node packages/cli/bin/treelog.mjs lint examples/adr-0007-plugin-vs-site.md`
Expected: exit 1 with two `conclusion-without-evidence` errors

- [ ] **Step 2: Verify engineering tests**

Run: `node scripts/engineering.test.mjs`
Expected: PASS with 30 tests

### Task 3: Plan interface lint

**Files:**
- Create: `packages/core/src/plan.js`
- Test: `scripts/plan.test.mjs`

**Interfaces:**
- Produces: `parsePlan(markdown: string): ParsedPlan`
- Produces: `lintPlan(plan: ParsedPlan): PlanFinding[]`

- [ ] **Step 1: Run the plan audit on its own fixture**

Run: `node packages/cli/bin/treelog.mjs plan examples/superpowers-plan.md`
Expected: two errors (signature-mismatch, undefined-consume)

- [ ] **Step 2: Verify plan tests**

Run: `node scripts/plan.test.mjs`
Expected: PASS with 9 tests

### Task 4: Spec-to-plan trace

**Files:**
- Create: `packages/core/src/trace.js`
- Test: `scripts/trace.test.mjs`

**Interfaces:**
- Consumes: `parsePlan(markdown: string): ParsedPlan` from Task 3
- Produces: `traceCoverage(nodes: ThoughtNode[], tasks: PlanTask[]): TraceResult`

- [ ] **Step 1: Trace the fixture spec against the fixture plan**

Run: `node packages/cli/bin/treelog.mjs trace examples/superpowers-spec.md examples/superpowers-plan.md`
Expected: three of four decisions matched, one unmatched

- [ ] **Step 2: Verify trace tests**

Run: `node scripts/trace.test.mjs`
Expected: PASS with 10 tests

### Task 5: CLI

**Files:**
- Create: `packages/cli/bin/treelog.mjs`
- Create: `packages/cli/lib/commands.mjs`
- Test: `scripts/engineering.test.mjs`

**Interfaces:**
- Consumes: `lintTree(nodes: ThoughtNode[]): Finding[]` from Task 2
- Consumes: `lintPlan(plan: ParsedPlan): PlanFinding[]` from Task 3
- Consumes: `traceCoverage(nodes: ThoughtNode[], tasks: PlanTask[]): TraceResult` from Task 4
- Produces: `lintPaths(paths: string[], options: LintOptions): Promise<LintResult>`

- [ ] **Step 1: Run the baseline round-trip**

Run: `node packages/cli/bin/treelog.mjs lint examples/ --baseline-write`
Expected: exit 0, baseline file written

- [ ] **Step 2: Verify the CLI help lists six commands**

Run: `node packages/cli/bin/treelog.mjs --help`
Expected: lint, plan, trace, tree, export, diff

### Task 6: MCP server

**Files:**
- Create: `packages/mcp/server.mjs`
- Create: `packages/mcp/tools.mjs`
- Test: `scripts/mcp.test.mjs`

**Interfaces:**
- Consumes: `lintPlan(plan: ParsedPlan): PlanFinding[]` from Task 3
- Produces: `callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>`

- [ ] **Step 1: Verify the MCP tool suite**

Run: `node scripts/mcp.test.mjs`
Expected: PASS with 13 tests covering eight tools

### Task 7: dsh panel

**Files:**
- Create: `packages/dsh-plugin/client.js`
- Create: `packages/dsh-plugin/cordis.patch.yml`
- Test: `scripts/smoke-client.mjs`

**Interfaces:**
- Consumes: `normalizeNodes(raw: unknown[]): ThoughtNode[]` from Task 1
- Produces: `apply(ctx: ClientContext): void`

- [ ] **Step 1: Verify the panel registers both slots headlessly**

Run: `node scripts/smoke-client.mjs`
Expected: OK with `sidebar.panellist` and `main` registrations

- [ ] **Step 2: Open the panel and import a project folder**

Drag any repository folder onto the panel; a project tree appears in under a second.

- [ ] **Step 3: Verify parity between the panel and the engine**

Run: `node scripts/consistency.test.mjs`
Expected: PASS with 6 parity tests

### Task 8: Enterprise plumbing

**Files:**
- Create: `treelog.config.example.json`
- Create: `treelog.schema.json`
- Create: `action.yml`

**Interfaces:**
- Produces: `loadConfig(options: LoadOptions): Promise<TreelogConfig>`

- [ ] **Step 1: Verify config discovery and presets**

Run: `node scripts/engineering.test.mjs`
Expected: PASS, including `loadConfig expands presets`

---

## Innovation

What this project does that the neighbouring tools do not:

1. **The plan is the artifact being audited.** Every linter in this space checks prose. This one also parses `### Task` / `Consumes` / `Produces` and checks the *interface graph* — the exact thing `writing-plans` asks a human to self-review and the exact place signature drift hides.
2. **Two engines, one contract.** The dsh panel cannot import npm packages, so it carries its own copy of the engine. A parity test asserts byte-identical output across extraction, layout, lint, plan lint and both export formats. Copies are a risk; an unguarded copy is a bug.
3. **A tree you can stand inside.** Time-travel reveal by creation order, fly-to on click, and arrow-key roaming. Reasoning is navigated, not scrolled.
4. **Coverage tracing without an LLM.** Spec decisions are matched to plan tasks lexically (CJK bigrams + latin words), scoped to the spec's Decision section, and reported as a pointer rather than a verdict. No API key, no token cost, no hallucinated "covered".
5. **Baseline by fingerprint, not by line.** Findings are identified by `rule|file|label`, so renaming a heading does not resurface a hundred historical findings — the failure mode that gets linters uninstalled in week one.
6. **Local project import.** Drop a folder and get a tree of its docs, modules and superpowers plans. No server, no upload, no indexing service.

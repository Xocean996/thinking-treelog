# Plan auditing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audit a superpowers plan for interface drift before anyone writes code.

**Architecture:** Parse the plan markdown into tasks plus a Consumes/Produces graph, then lint that graph.

**Tech Stack:** Node, ESM, no runtime dependencies.

**Spec:** docs/superpowers/specs/2026-10-23-audit-design.md

## Global Constraints

- Node >= 18
- No runtime dependencies

## Review Focus

---

### Task 1: Plan parser

**Files:**
- Create: `src/parse.js`
- Test: `tests/parse.test.js`

**Interfaces:**
- Produces: `parsePlan(markdown: string): Plan`

- [ ] **Step 1: Write the failing test**

```js
assert.equal(parsePlan(MD).tasks.length, 3);
```

- [ ] **Step 2: Implement `parsePlan(markdown: string): Plan` in `src/parse.js`**

Walk the lines, track the current task and interface block.

- [ ] **Step 3: Run test to verify it passes**

Run: `node --test tests/parse.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: add plan parser"
```

### Task 2: Interface linter

**Files:**
- Create: `src/lint.js`

**Interfaces:**
- Consumes: `parsePlan(markdown: string): Plan` from Task 1
- Produces: `lintPlan(plan: Plan): Finding[]`

- [ ] **Step 1: Write the failing test**

```js
assert.ok(lintPlan(plan).some((f) => f.rule === 'undefined-consume'));
```

- [ ] **Step 2: Implement `lintPlan(plan: Plan): Finding[]` in `src/lint.js`**

### Task 3: Report renderer

**Files:**
- Create: `src/report.js`

**Interfaces:**
- Consumes: `lintPlan(plan): Finding[]` from Task 2
- Consumes: `formatFindings(findings: Finding[]): string` from Task 1

- [ ] **Step 1: Run the renderer against the example plan**

Run: `node bin/treelog.mjs plan examples/plan.md`
Expected: a findings table on stdout

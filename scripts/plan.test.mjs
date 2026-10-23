import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { lintPlan, parseInterface, parsePlan, planToTree } from '../packages/core/src/plan.js';
import { lintPlanFile, planTreeText } from '../packages/cli/lib/commands.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(resolve(here, '../examples/superpowers-plan.md'), 'utf8');

const io = { readFile: async () => FIXTURE };

test('parsePlan reads the plan header', () => {
  const plan = parsePlan(FIXTURE);
  assert.match(plan.title, /Plan auditing/);
  assert.match(plan.goal, /interface drift/);
  assert.match(plan.architecture, /Consumes\/Produces/);
  assert.match(plan.techStack, /Node/);
  assert.match(plan.spec, /audit-design\.md/);
  assert.equal(plan.constraints.length, 2);
  assert.equal(plan.reviewFocus.length, 0);
});

test('parsePlan extracts tasks, files, interfaces and steps', () => {
  const plan = parsePlan(FIXTURE);
  assert.equal(plan.tasks.length, 3);

  const [parser, linter, report] = plan.tasks;
  assert.equal(parser.id, 1);
  assert.equal(parser.title, 'Plan parser');
  assert.deepEqual(parser.files.create, ['src/parse.js']);
  assert.deepEqual(parser.files.test, ['tests/parse.test.js']);
  assert.equal(parser.produces[0].symbol, 'parsePlan');
  assert.equal(parser.produces[0].signature, 'parsePlan(markdown: string): Plan');
  assert.equal(parser.steps.length, 4);
  assert.equal(parser.steps[0].done, false);
  assert.equal(parser.steps[0].text, 'Write the failing test');

  assert.equal(linter.consumes[0].fromTask, 1);
  assert.equal(report.consumes.length, 2);
});

test('parseInterface understands code spans and "from Task N"', () => {
  const parsed = parseInterface('`buildTree(nodes: Node[]): Tree` from Task 2');
  assert.equal(parsed.symbol, 'buildTree');
  assert.equal(parsed.signature, 'buildTree(nodes: Node[]): Tree');
  assert.equal(parsed.fromTask, 2);

  const bare = parseInterface('emitReport');
  assert.equal(bare.symbol, 'emitReport');
  assert.equal(bare.fromTask, null);
});

test('lintPlan finds the interface drift a human review misses', () => {
  const plan = parsePlan(FIXTURE);
  const findings = lintPlan(plan);
  const rules = findings.map((f) => f.rule);

  assert.ok(rules.includes('undefined-consume'), 'formatFindings is produced by nobody');
  assert.ok(rules.includes('signature-mismatch'), 'lintPlan is consumed with a different signature');
  assert.ok(rules.includes('task-without-verification'), 'Task 2 has no run step');
  assert.ok(rules.includes('review-focus-empty'));

  const mismatch = findings.find((f) => f.rule === 'signature-mismatch');
  assert.equal(mismatch.severity, 'error');
  assert.equal(mismatch.taskId, 3);
  assert.match(mismatch.message, /lintPlan/);
});

test('lintPlan is quiet on a clean plan', () => {
  const clean = `# Clean Plan

**Goal:** nothing to fix

## Review Focus

- untested input: empty file

### Task 1: Only task

**Files:**
- Create: \`src/a.js\`

**Interfaces:**
- Produces: \`doThing(x: number): number\`

- [ ] **Step 1: Run it**

Run: \`node src/a.js\`
Expected: PASS
`;
  const findings = lintPlan(parsePlan(clean), { rules: { 'unused-produce': false } });
  assert.deepEqual(findings, []);
});

test('lintPlan reports a produce that nobody consumes only when asked', () => {
  const orphan = parsePlan(`# Orphan Plan

**Goal:** one producer, no consumer

### Task 1: Only task

**Files:**
- Create: \`a.js\`

**Interfaces:**
- Produces: \`onlyMine(): void\`

- [ ] **Step 1: Run it**

Run: \`node a.js\`
Expected: PASS
`);

  const quiet = lintPlan(orphan).filter((f) => f.rule === 'unused-produce');
  assert.equal(quiet.length, 0, 'unused-produce is opt-in');

  const loud = lintPlan(orphan, { rules: { 'unused-produce': true } }).filter(
    (f) => f.rule === 'unused-produce',
  );
  assert.equal(loud.length, 1);
  assert.match(loud[0].message, /onlyMine/);
});

test('lintPlan localises messages', () => {
  const plan = parsePlan(FIXTURE);
  const zh = lintPlan(plan, { locale: 'zh' });
  assert.ok(zh.some((f) => f.message.includes('没有可执行的验证步骤')));
});

test('planToTree renders one node per task and step', () => {
  const plan = parsePlan(FIXTURE);
  const nodes = planToTree(plan);
  const stepCount = plan.tasks.reduce((n, t) => n + t.steps.length, 0);
  assert.equal(nodes.length, 1 + plan.tasks.length + stepCount);

  const root = nodes[0];
  assert.equal(root.parentId, null);
  const taskNodes = nodes.filter((n) => n.parentId === root.id);
  assert.equal(taskNodes.length, plan.tasks.length);
});

test('CLI helpers produce text and exit codes', async () => {
  const lint = await lintPlanFile('examples/superpowers-plan.md', { readFile: io.readFile });
  assert.equal(lint.findings.length, 4);
  assert.equal(lint.exitCode, 1);
  assert.match(lint.text, /signature-mismatch/);

  const tree = await planTreeText('examples/superpowers-plan.md', { readFile: io.readFile });
  assert.match(tree.text, /Task 1: Plan parser/);
  assert.match(tree.text, /├──|└──/);

  const json = await lintPlanFile('p.md', { readFile: io.readFile, format: 'json' });
  const parsed = JSON.parse(json.text);
  assert.equal(parsed.summary.error, 2);
});

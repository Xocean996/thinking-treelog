import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { TOOLS, callTool } from '../packages/mcp/tools.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PLAN_MD = readFileSync(resolve(here, '../examples/superpowers-plan.md'), 'utf8');
const SPEC_MD = readFileSync(resolve(here, '../examples/superpowers-spec.md'), 'utf8');

const SAMPLE =
  '我们应该把思维树做成插件。因为用户不会为了复盘专门打开一个新网站。' +
  '但是，插件的受众只有 dsh 用户。如果目标是先验证需求，那么插件形态反馈更快。' +
  '因此，第一版应该先做插件。';

function firstText(result) {
  assert.ok(result && Array.isArray(result.content));
  assert.equal(result.content[0].type, 'text');
  return result.content[0].text;
}

test('tool catalogue exposes the ten documented tools', () => {
  const names = TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'build_thought_tree',
    'lint_plan',
    'lint_thought_tree',
    'project_rhythm',
    'thought_tree_adr',
    'thought_tree_markdown',
    'thought_tree_mermaid',
    'thought_tree_stats',
    'trace_coverage',
    'workspace_pulse',
  ]);
  for (const tool of TOOLS) {
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 20, `${tool.name} needs a real description`);
    assert.equal(tool.inputSchema.type, 'object');
  }
});

test('build_thought_tree returns a valid, normalized tree', async () => {
  const payload = JSON.parse(firstText(await callTool('build_thought_tree', { text: SAMPLE })));

  assert.equal(payload.extractor, 'rule');
  assert.ok(Array.isArray(payload.nodes));
  assert.ok(payload.nodes.length >= 5);
  assert.ok(payload.title.length > 0);

  const ids = new Set(payload.nodes.map((n) => n.id));
  assert.equal(ids.size, payload.nodes.length, 'node ids must be unique');

  const roots = payload.nodes.filter((n) => n.parentId === null);
  assert.ok(roots.length >= 1);

  const validTypes = new Set([
    'question', 'claim', 'assumption', 'evidence', 'constraint', 'conclusion', 'action',
  ]);
  for (const node of payload.nodes) {
    assert.ok(validTypes.has(node.type), `bad type: ${node.type}`);
    assert.ok(node.confidence >= 0 && node.confidence <= 1);
    if (node.parentId !== null) assert.ok(ids.has(node.parentId), `dangling parent on ${node.id}`);
  }
});

test('markdown and mermaid accept a bare node array', async () => {
  const built = JSON.parse(firstText(await callTool('build_thought_tree', { text: SAMPLE })));

  const markdown = firstText(await callTool('thought_tree_markdown', { nodes: built.nodes }));
  assert.match(markdown, /^# /m);
  assert.ok(markdown.includes('节点数'));

  const mermaid = firstText(await callTool('thought_tree_mermaid', { nodes: built.nodes }));
  assert.match(mermaid, /^flowchart LR/m);
  assert.ok(mermaid.includes('-->'));
});

test('markdown accepts a full tree object with its title', async () => {
  const built = JSON.parse(firstText(await callTool('build_thought_tree', { text: SAMPLE })));
  const markdown = firstText(await callTool('thought_tree_markdown', { tree: built }));
  assert.ok(markdown.startsWith(`# ${built.title}`));
});

test('stats reports structure', async () => {
  const built = JSON.parse(firstText(await callTool('build_thought_tree', { text: SAMPLE })));
  const stats = JSON.parse(firstText(await callTool('thought_tree_stats', { tree: built })));

  assert.equal(stats.nodeCount, built.nodes.length);
  assert.ok(stats.depth >= 2);
  assert.ok(stats.branchCount >= 2);
  assert.ok(stats.averageConfidence > 0);
  assert.ok(Array.isArray(stats.lowConfidence));
});

test('lint_thought_tree reports gaps and a severity summary', async () => {
  const built = JSON.parse(firstText(await callTool('build_thought_tree', { text: SAMPLE })));
  const payload = JSON.parse(firstText(await callTool('lint_thought_tree', { tree: built })));

  assert.ok(Array.isArray(payload.findings));
  assert.equal(typeof payload.summary.error, 'number');
  assert.equal(typeof payload.summary.warning, 'number');

  for (const finding of payload.findings) {
    assert.ok(typeof finding.rule === 'string');
    assert.ok(['error', 'warning', 'info'].includes(finding.severity));
    assert.ok(typeof finding.message === 'string' && finding.message.length > 0);
  }
});

test('lint_thought_tree flags a bare conclusion', async () => {
  const payload = JSON.parse(
    firstText(
      await callTool('lint_thought_tree', {
        nodes: [{ id: 'a', parentId: null, text: '直接上线', type: 'conclusion', confidence: 0.9 }],
      }),
    ),
  );
  assert.ok(payload.findings.some((f) => f.rule === 'conclusion-without-evidence'));
  assert.equal(payload.summary.error, 1);
});

test('thought_tree_adr renders the three sections', async () => {
  const built = JSON.parse(firstText(await callTool('build_thought_tree', { text: SAMPLE })));
  const adr = firstText(await callTool('thought_tree_adr', { tree: built, id: '0012' }));

  assert.match(adr, /^# 0012\./m);
  assert.match(adr, /## Context/);
  assert.match(adr, /## Decision/);
  assert.match(adr, /## Consequences/);
});

test('lint_plan reports interface drift', async () => {
  const payload = JSON.parse(firstText(await callTool('lint_plan', { markdown: PLAN_MD })));

  assert.equal(payload.tasks, 3);
  assert.ok(payload.findings.some((f) => f.rule === 'signature-mismatch'));
  assert.ok(payload.findings.some((f) => f.rule === 'undefined-consume'));
  assert.equal(payload.summary.error, 2);
});

test('lint_plan rejects a document with no tasks', async () => {
  await assert.rejects(
    () => callTool('lint_plan', { markdown: '# just a doc\n\nsome prose' }),
    /no tasks/i,
  );
});

test('trace_coverage reports the decision with no task', async () => {
  const text = firstText(await callTool('trace_coverage', { spec: SPEC_MD, plan: PLAN_MD }));

  assert.match(text, /3\/4 decisions/);
  assert.match(text, /Capture the current conversation/);
  assert.match(text, /Task 2: Interface linter/);
});

test('trace_coverage requires both documents', async () => {
  await assert.rejects(() => callTool('trace_coverage', { spec: SPEC_MD }), /spec.*plan|required/i);
});

test('project_rhythm reports a pulse for the current repository', async () => {
  const text = firstText(await callTool('project_rhythm', { path: '.' }));

  assert.match(text, /项目节奏|project rhythm/);
  assert.match(text, /阶段|phases/);
});

test('invalid input fails loudly instead of returning junk', async () => {
  await assert.rejects(() => callTool('build_thought_tree', { text: '   ' }), /text.*required/i);
  await assert.rejects(() => callTool('thought_tree_markdown', { nodes: 'nope' }), /nodes array/i);
  await assert.rejects(() => callTool('does_not_exist', {}), /unknown tool/i);
});

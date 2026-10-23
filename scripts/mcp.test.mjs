import test from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS, callTool } from '../packages/mcp/tools.mjs';

const SAMPLE =
  '我们应该把思维树做成插件。因为用户不会为了复盘专门打开一个新网站。' +
  '但是，插件的受众只有 dsh 用户。如果目标是先验证需求，那么插件形态反馈更快。' +
  '因此，第一版应该先做插件。';

function firstText(result) {
  assert.ok(result && Array.isArray(result.content));
  assert.equal(result.content[0].type, 'text');
  return result.content[0].text;
}

test('tool catalogue exposes the four documented tools', () => {
  const names = TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'build_thought_tree',
    'thought_tree_markdown',
    'thought_tree_mermaid',
    'thought_tree_stats',
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

test('invalid input fails loudly instead of returning junk', async () => {
  await assert.rejects(() => callTool('build_thought_tree', { text: '   ' }), /text.*required/i);
  await assert.rejects(() => callTool('thought_tree_markdown', { nodes: 'nope' }), /nodes array/i);
  await assert.rejects(() => callTool('does_not_exist', {}), /unknown tool/i);
});

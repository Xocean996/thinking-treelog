import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeTree,
  buildGraph,
  classifySentence,
  computeLayout,
  extractWithRules,
  normalizeNodes,
  pathTo,
  splitSentences,
  toMarkdown,
  toMermaid,
} from '../src/index.js';

const SAMPLE = [
  '我们应该把思维树做成插件。',
  '因为用户不会为了复盘专门打开一个新网站。',
  '但是，插件的受众只有 dsh 用户。',
  '如果目标是先验证需求，那么插件形态反馈更快。',
  '因此，第一版应该先做插件。',
  '下一步需要决定默认的提取方式。',
].join('');

test('splitSentences keeps Chinese terminators and drops fragments', () => {
  const sentences = splitSentences(SAMPLE);
  assert.equal(sentences.length, 6);
  assert.ok(sentences[0].endsWith('。'));
});

test('classifySentence recognises the main reasoning moves', () => {
  assert.equal(classifySentence('因此，第一版应该先做插件。'), 'conclusion');
  assert.equal(classifySentence('因为用户不会打开新网站。'), 'evidence');
  assert.equal(classifySentence('如果目标是先验证需求。'), 'assumption');
  assert.equal(classifySentence('下一步需要决定默认的提取方式。'), 'action');
  assert.equal(classifySentence('是否应该现在做？'), 'question');
  assert.equal(classifySentence('这是一个普通的陈述。'), 'claim');
});

test('extractWithRules produces a rooted, well-parented tree', () => {
  const nodes = extractWithRules(SAMPLE);
  assert.equal(nodes.length, 6);

  const roots = nodes.filter((n) => n.parentId === null);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].id, nodes[0].id);

  const ids = new Set(nodes.map((n) => n.id));
  for (const node of nodes) {
    if (node.parentId !== null) assert.ok(ids.has(node.parentId), `dangling parent on ${node.id}`);
  }

  // The rebuttal forks instead of chaining straight on.
  const forked = nodes.filter((n) => n.branchId !== 'main');
  assert.ok(forked.length >= 1, 'expected at least one forked branch');
});

test('normalizeNodes repairs dangling parents, cycles and junk fields', () => {
  const repaired = normalizeNodes([
    { id: 'a', parentId: 'missing', text: 'lonely', type: 'bogus', confidence: 5 },
    { id: 'b', parentId: 'c', text: 'cycle one' },
    { id: 'c', parentId: 'b', text: 'cycle two' },
    { id: 'a', parentId: null, text: 'duplicate id' },
    { text: '' },
    null,
  ]);

  assert.equal(repaired.length, 4);
  const ids = repaired.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique');

  const first = repaired[0];
  assert.equal(first.parentId, null);
  assert.equal(first.type, 'claim');
  assert.equal(first.confidence, 1);

  // The b <-> c cycle must have been broken.
  const graph = buildGraph(repaired);
  assert.ok(graph.roots.length >= 1);
  for (const node of repaired) {
    let cursor = node.parentId;
    let steps = 0;
    while (cursor !== null && steps < 50) {
      assert.notEqual(cursor, node.id, 'cycle survived normalisation');
      cursor = repaired.find((n) => n.id === cursor)?.parentId ?? null;
      steps += 1;
    }
  }
});

test('buildGraph supports multiple roots and keeps a stable order', () => {
  const nodes = normalizeNodes([
    { id: 'r1', parentId: null, text: 'root one' },
    { id: 'r2', parentId: null, text: 'root two' },
    { id: 'c1', parentId: 'r1', text: 'child of one' },
  ]);
  const graph = buildGraph(nodes);
  assert.deepEqual(graph.roots, ['r1', 'r2']);
  assert.equal(graph.order.length, 3);
  assert.deepEqual(pathTo(graph, 'c1').map((n) => n.id), ['r1', 'c1']);
});

test('computeLayout keeps siblings on distinct rows and links parent to child', () => {
  const nodes = extractWithRules(SAMPLE);
  const layout = computeLayout(nodes);

  assert.equal(layout.nodes.length, nodes.length);
  const rowsByDepth = new Map();
  for (const entry of layout.nodes) {
    if (!rowsByDepth.has(entry.depth)) rowsByDepth.set(entry.depth, new Set());
    rowsByDepth.get(entry.depth).add(entry.y);
  }
  for (const [depth, rows] of rowsByDepth) {
    const atDepth = layout.nodes.filter((n) => n.depth === depth).length;
    assert.equal(rows.size, atDepth, `overlapping rows at depth ${depth}`);
  }

  for (const link of layout.links) {
    assert.ok(link.target.node.parentId === link.source.node.id);
    assert.match(link.d, /^M /);
  }
  assert.ok(layout.width > 0 && layout.height > 0);
});

test('toMarkdown and toMermaid render every node', () => {
  const nodes = extractWithRules(SAMPLE);
  const tree = { title: '插件还是网站', nodes };

  const markdown = toMarkdown(tree);
  assert.match(markdown, /^# 插件还是网站/m);
  for (const node of nodes) assert.ok(markdown.includes(node.label.slice(0, 8)));

  const mermaid = toMermaid(tree);
  assert.match(mermaid, /^flowchart LR/m);
  for (const node of nodes) assert.ok(mermaid.includes(`${node.id}[`));
  assert.ok(mermaid.includes('-->'));
});

test('analyzeTree reports depth, type mix and branches', () => {
  const nodes = extractWithRules(SAMPLE);
  const analysis = analyzeTree({ title: 't', nodes });

  assert.equal(analysis.nodeCount, nodes.length);
  assert.ok(analysis.depth >= 2);
  assert.ok(Object.keys(analysis.byType).length >= 2);
  assert.ok(analysis.branchCount >= 2);
  assert.ok(analysis.averageConfidence > 0 && analysis.averageConfidence <= 1);
});

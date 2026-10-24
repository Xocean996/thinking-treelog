import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeTree,
  buildGraph,
  computeLayout,
  extractWithRules,
  normalizeNodes,
  pathTo,
  toMarkdown,
  toMermaid,
} from '../packages/core/src/index.js';
import { diffTrees, lintTree, parseMarkdown, toAdr } from '../packages/core/src/engineering.js';
import { lintPlan, parsePlan } from '../packages/core/src/plan.js';

/**
 * Shape contracts for the public API.
 *
 * These exist because the same mistake was made three times in one session:
 * writing a probe that assumed `extractWithRules` returned `{ nodes }` (it
 * returns an array) and that `diffTrees` returned `changed` (it returns
 * `modified`). The calls "failed" and looked like bugs in the library.
 *
 * A wrong assumption about a return shape is indistinguishable from a broken
 * function until something pins the shape down.
 */

const TEXT = '因为用户不会为了复盘一次对话打开新网站，所以插件更合适。但如果插件只能给 dsh 用户用，传播就受限。';

const NODES = normalizeNodes([
  { id: 'a', parentId: null, label: 'root', text: 'root', type: 'claim' },
  { id: 'b', parentId: 'a', label: 'child', text: 'child', type: 'evidence' },
]);

test('extractWithRules returns a node array, not an object', () => {
  const out = extractWithRules(TEXT);
  assert.ok(Array.isArray(out), 'extractWithRules must return an array');
  assert.ok(out.length > 0);
  assert.equal(typeof out[0].id, 'string');
});

test('normalizeNodes returns an array of nodes', () => {
  assert.ok(Array.isArray(normalizeNodes(NODES)));
  assert.ok(Array.isArray(normalizeNodes(null)));
});

test('buildGraph returns nodeMap / childrenOf / roots / order', () => {
  const graph = buildGraph(NODES);
  assert.deepEqual(Object.keys(graph).sort(), ['childrenOf', 'nodeMap', 'order', 'roots']);
  assert.ok(graph.nodeMap instanceof Map);
  assert.ok(graph.childrenOf instanceof Map);
  assert.ok(Array.isArray(graph.roots));
  assert.ok(Array.isArray(graph.order));
});

test('computeLayout returns nodes / links / graph / width / height', () => {
  const layout = computeLayout(NODES);
  assert.deepEqual(Object.keys(layout).sort(), ['graph', 'height', 'links', 'nodes', 'width']);
  assert.equal(typeof layout.width, 'number');
  assert.equal(typeof layout.height, 'number');
  assert.ok(Array.isArray(layout.nodes));
  assert.ok(Array.isArray(layout.links));
  assert.ok(layout.graph.nodeMap instanceof Map);
  assert.ok(Object.hasOwn(layout.nodes[0], 'x'));
  assert.ok(Object.hasOwn(layout.nodes[0], 'y'));
  assert.ok(Object.hasOwn(layout.nodes[0], 'depth'));
  assert.ok(Object.hasOwn(layout.nodes[0], 'node'));
});

test('pathTo returns an array of nodes, root first', () => {
  const graph = buildGraph(NODES);
  const path = pathTo(graph, 'b');
  assert.ok(Array.isArray(path));
  assert.equal(path[0].id, 'a');
  assert.equal(path[path.length - 1].id, 'b');
});

test('diffTrees returns added / removed / modified / moved / summary', () => {
  const diff = diffTrees(NODES, NODES);
  assert.deepEqual(Object.keys(diff).sort(), ['added', 'modified', 'moved', 'removed', 'summary']);
  assert.equal(diff.summary.before, 2);
  assert.equal(diff.summary.after, 2);
});

test('lintTree and lintPlan return finding arrays', () => {
  assert.ok(Array.isArray(lintTree(NODES)));
  assert.ok(Array.isArray(lintPlan(parsePlan(''))));
});

test('parseMarkdown returns a node array', () => {
  const parsed = parseMarkdown('# Title\n\nSome text.\n\n## Section\n\n- a\n- b\n');
  assert.ok(Array.isArray(parsed), 'parseMarkdown returns the nodes themselves, not { nodes }');
  assert.ok(parsed.length > 0);
  assert.equal(typeof parsed[0].id, 'string');
});

test('parsePlan returns an object with tasks', () => {
  const plan = parsePlan('### Task 1: do the thing\n\n**Files:** `a.js`\n\n- [ ] **Step 1:** write it\n  Run: `npm test`\n');
  assert.equal(typeof plan, 'object');
  assert.ok(Array.isArray(plan.tasks));
  assert.ok(Object.hasOwn(plan.tasks[0], 'steps'));
});

test('analyzeTree returns counts and a per-type breakdown', () => {
  const stats = analyzeTree({ title: 't', nodes: NODES });
  assert.equal(typeof stats, 'object');
  assert.equal(typeof stats.nodeCount, 'number');
  assert.equal(typeof stats.depth, 'number');
  assert.equal(typeof stats.byType, 'object');
  assert.equal(stats.nodeCount, 2);
});

test('exporters return strings, including for an empty tree', () => {
  for (const value of [
    toMarkdown({ title: 't', nodes: NODES }),
    toMermaid({ title: 't', nodes: NODES }),
    toAdr({ title: 't', nodes: NODES }),
    toMarkdown({ title: 't', nodes: [] }),
    toMermaid({ title: 't', nodes: [] }),
    toAdr({ title: 't', nodes: [] }),
  ]) {
    assert.equal(typeof value, 'string');
    assert.ok(value.length > 0, 'an empty tree still produces a document');
  }
});

test('extractWithRules never throws on degenerate input', () => {
  for (const input of ['', '   ', '。。。', '?', 'a'.repeat(5000)]) {
    const out = extractWithRules(input);
    assert.ok(Array.isArray(out), `extractWithRules(${JSON.stringify(input.slice(0, 8))}) must not throw`);
  }
});

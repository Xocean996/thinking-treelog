import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  buildGraph,
  computeLayout,
  extractWithRules,
  normalizeNodes,
  toMarkdown,
  toMermaid,
} from '../packages/core/src/index.js';
import { lintTree } from '../packages/core/src/engineering.js';

/**
 * The dsh Client half is a self-contained browser module, so it carries its own
 * copy of the engine. This test is the guard against the two copies drifting:
 * both must produce byte-identical results for the same inputs.
 */

const here = dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(resolve(here, '../packages/dsh-plugin/client.js'), 'utf8');

function loadClientInternals() {
  globalThis.__TTL_TEST__ = true;
  globalThis.__TTL_INTERNALS__ = undefined;

  const fakeReact = {
    createElement: (...args) => ({ args }),
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
  };

  let loaded = null;
  const fakeWindow = {
    __ModuleLoader__: {
      load(module) {
        loaded = module;
      },
    },
  };

  const runner = new Function('window', 'require', 'document', 'localStorage', clientSource);
  runner(
    fakeWindow,
    (id) => {
      if (id === 'react') return fakeReact;
      throw new Error(`unexpected require: ${id}`);
    },
    { createElement: () => ({}) },
    { getItem: () => null, setItem: () => {} },
  );

  assert.ok(loaded, 'client never called window.__ModuleLoader__.load');
  const plugin = loaded.factory((id) => {
    if (id === 'react') return fakeReact;
    throw new Error(`unexpected require: ${id}`);
  });
  assert.ok(plugin && typeof plugin.apply === 'function');

  assert.ok(globalThis.__TTL_INTERNALS__, 'client did not expose its test internals');
  return globalThis.__TTL_INTERNALS__;
}

const FIXTURES = [
  '我们应该把思维树做成插件。因为用户不会为了复盘专门打开一个新网站。但是插件的受众只有 dsh 用户。如果目标是先验证需求，那么插件形态反馈更快。因此第一版应该先做插件。',
  'First, we should measure the pain. Data shows 80% of users never revisit a chat. However, the plugin audience is narrower. Therefore we ship the plugin first.',
  '我认为这个方案可行。数据显示转化率提升了 12%。因此应该扩大投放。但是预算有限。下一步需要评估 ROI。',
  '',
];

const internals = loadClientInternals();

function stripTimestamps(nodes) {
  return nodes.map((node) => ({ ...node, createdAt: 0 }));
}

test('client and core agree on rule extraction', () => {
  for (const [index, fixture] of FIXTURES.entries()) {
    const core = stripTimestamps(extractWithRules(fixture));
    const client = stripTimestamps(internals.extractWithRules(fixture));
    assert.deepEqual(client, core, `fixture ${index} diverged`);
  }
});

test('client and core agree on normalisation of hostile input', () => {
  const hostile = [
    { id: 'a', parentId: 'ghost', text: 'dangling', type: 'nope', confidence: 9 },
    { id: 'b', parentId: 'c', text: 'cycle a' },
    { id: 'c', parentId: 'b', text: 'cycle b' },
    { id: 'a', parentId: null, text: 'duplicate' },
    { tags: ['x'], text: 'no id, tags only' },
  ];
  assert.deepEqual(
    stripTimestamps(internals.normalizeNodes(hostile)),
    stripTimestamps(normalizeNodes(hostile)),
  );
});

test('client and core agree on graph topology and layout geometry', () => {
  const fixture = FIXTURES[0];
  const coreNodes = extractWithRules(fixture);
  const clientNodes = internals.extractWithRules(fixture);

  const coreGraph = buildGraph(coreNodes);
  const clientGraph = internals.buildGraph(clientNodes);
  assert.deepEqual(clientGraph.roots, coreGraph.roots);
  assert.deepEqual(clientGraph.order, coreGraph.order);

  const coreLayout = computeLayout(coreNodes);
  const clientLayout = internals.computeLayout(clientNodes);

  assert.equal(clientLayout.nodes.length, coreLayout.nodes.length);
  assert.equal(clientLayout.links.length, coreLayout.links.length);
  for (let i = 0; i < coreLayout.nodes.length; i += 1) {
    assert.equal(clientLayout.nodes[i].node.id, coreLayout.nodes[i].node.id);
    assert.equal(clientLayout.nodes[i].x, coreLayout.nodes[i].x);
    assert.equal(clientLayout.nodes[i].y, coreLayout.nodes[i].y);
  }
  for (let i = 0; i < coreLayout.links.length; i += 1) {
    assert.equal(clientLayout.links[i].d, coreLayout.links[i].d);
  }
});

test('client and core agree on Markdown and Mermaid exports', () => {
  for (const fixture of FIXTURES.slice(0, 3)) {
    const tree = { title: '对比导出', nodes: extractWithRules(fixture) };
    const clientTree = { title: '对比导出', nodes: internals.extractWithRules(fixture) };
    assert.equal(internals.treeToMarkdown(clientTree), toMarkdown(tree));
    assert.equal(internals.treeToMermaid(clientTree), toMermaid(tree));
  }
});

test('client and core agree on reasoning lint findings', () => {
  for (const fixture of FIXTURES.slice(0, 3)) {
    const nodes = extractWithRules(fixture);
    assert.deepEqual(internals.lintTree(nodes), lintTree(nodes), 'lint findings diverged');
  }

  // Also cover the engineering metadata that only the panel can set.
  const withStatus = normalizeNodes([
    { id: 'a', parentId: null, text: '采用方案 A', type: 'conclusion', confidence: 0.4 },
    { id: 'b', parentId: 'a', text: '旧方案 B', type: 'claim', status: 'rejected' },
    { id: 'c', parentId: 'b', text: '旧方案 B 的细节', type: 'claim' },
  ]);
  assert.deepEqual(internals.lintTree(withStatus), lintTree(withStatus));
});

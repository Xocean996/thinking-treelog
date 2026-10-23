import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Project import lives inside the dsh Client module, which the host loads as a
 * browser module. We exercise the pure tree-building half headlessly; the drop
 * and folder-picker wiring can only be checked in the running panel.
 */

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '../packages/dsh-plugin/client.js'), 'utf8');
const PLAN = readFileSync(resolve(here, '../examples/superpowers-plan.md'), 'utf8');

function loadInternals() {
  globalThis.__TTL_TEST__ = true;
  const fakeReact = {
    createElement: (...args) => ({ args }),
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
  };
  let loaded = null;
  const runner = new Function('window', 'require', 'document', 'localStorage', source);
  runner(
    { __ModuleLoader__: { load: (m) => { loaded = m; } } },
    (id) => {
      if (id === 'react') return fakeReact;
      throw new Error(`unexpected require: ${id}`);
    },
    { createElement: () => ({}) },
    { getItem: () => null, setItem: () => {} },
  );
  loaded.factory((id) => {
    if (id === 'react') return fakeReact;
    throw new Error(`unexpected require: ${id}`);
  });
  return globalThis.__TTL_INTERNALS__;
}

const internals = loadInternals();

const PROJECT = [
  {
    path: 'my-app/package.json',
    text: JSON.stringify({
      name: 'my-app',
      description: 'A demo project',
      dependencies: { react: '19.0.0', vite: '7.0.0' },
      scripts: { test: 'vitest run' },
    }),
  },
  { path: 'my-app/README.md', text: '# My App\n\nDoes things.' },
  { path: 'my-app/src/index.js', text: 'export {}' },
  { path: 'my-app/src/util.js', text: 'export {}' },
  { path: 'my-app/docs/superpowers/specs/2026-01-01-design.md', text: '# Plugin design\n\nSome context.' },
  { path: 'my-app/docs/superpowers/plans/2026-01-01-build.md', text: PLAN },
  { path: 'my-app/docs/notes.md', text: '# Notes\n\n- one\n- two' },
  { path: 'my-app/node_modules/dep/README.md', text: '# dep' },
];

test('buildProjectTree roots the tree at the package name', () => {
  const built = internals.buildProjectTree(PROJECT.filter((f) => !f.path.includes('node_modules')));
  assert.equal(built.title, 'my-app · project');
  assert.equal(built.nodes[0].parentId, null);
  assert.match(built.nodes[0].text, /demo project/);
});

test('buildProjectTree records the stack and the test command', () => {
  const built = internals.buildProjectTree(PROJECT.filter((f) => !f.path.includes('node_modules')));
  const stack = built.nodes.find((n) => n.label.startsWith('Stack:'));
  assert.ok(stack, 'expected a stack node');
  assert.equal(stack.type, 'constraint');
  assert.match(stack.text, /react/);

  const testNode = built.nodes.find((n) => n.label.startsWith('Test:'));
  assert.ok(testNode, 'expected a test-command node');
  assert.equal(testNode.type, 'evidence');
});

test('buildProjectTree groups specs, plans and docs', () => {
  const built = internals.buildProjectTree(PROJECT.filter((f) => !f.path.includes('node_modules')));
  const labels = built.nodes.map((n) => n.label);

  assert.ok(labels.includes('Specs (1)'));
  assert.ok(labels.includes('Plans (1)'));
  // README.md and docs/notes.md are neither specs nor plans.
  assert.ok(labels.includes('Docs (2)'));

  // The plan's tasks become nodes under the plan node.
  const planNode = built.nodes.find((n) => n.label === 'Plans (1)');
  const planChild = built.nodes.find((n) => n.parentId === planNode.id);
  const taskNodes = built.nodes.filter((n) => n.parentId === planChild.id);
  assert.ok(taskNodes.length >= 3);
  assert.match(taskNodes[0].label, /^Task \d+:/);
});

test('buildProjectTree tolerates a missing package.json', () => {
  const built = internals.buildProjectTree([
    { path: 'bare/README.md', text: '# Bare' },
  ]);
  assert.match(built.title, /bare/);
  assert.ok(built.nodes.length >= 2);
  assert.ok(!built.nodes.some((n) => n.label.startsWith('Stack:')));
});

test('buildProjectTree explains an empty project instead of emitting a bare root', () => {
  const built = internals.buildProjectTree([]);
  assert.ok(built.nodes.length >= 2);
  assert.ok(built.nodes.some((n) => /No readable/i.test(n.label)));
});

test('readDocTitle takes the first h1', () => {
  assert.equal(internals.readDocTitle('# Hello\n\ntext'), 'Hello');
  assert.equal(internals.readDocTitle('no heading'), '');
});

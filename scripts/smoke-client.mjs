/**
 * Headless smoke test for the dsh Client half.
 *
 * Loads client.js with a stubbed module loader and React, runs the plugin's
 * apply(), and prints every slot registration. No browser required.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '../packages/dsh-plugin/client.js'), 'utf8');

let loaded = null;
const fakeWindow = {
  __ModuleLoader__: {
    load(module) {
      loaded = module;
    },
  },
};
const fakeReact = {
  createElement: (...args) => ({ args }),
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
};

const runner = new Function('window', 'require', 'document', 'localStorage', source);
runner(
  fakeWindow,
  (id) => {
    if (id === 'react') return fakeReact;
    throw new Error(`unexpected require: ${id}`);
  },
  { createElement: () => ({}) },
  { getItem: () => null, setItem: () => {} },
);

if (!loaded) throw new Error('client.js never called window.__ModuleLoader__.load');
if (loaded.id !== '@thinking-treelog/dsh-plugin') {
  throw new Error(
    `module id must equal the package name for the loader to find it, got: ${loaded.id}`,
  );
}

const plugin = loaded.factory((id) => {
  if (id === 'react') return fakeReact;
  throw new Error(`unexpected require: ${id}`);
});

if (!plugin || typeof plugin.apply !== 'function') throw new Error('factory did not return apply()');

const registrations = [];
const disposers = [];
const ctx = {
  slots: {
    inject(slot, callback) {
      registrations.push({ kind: 'inject', slot });
      callback();
      return () => {};
    },
    register(options, component) {
      registrations.push({
        kind: 'register',
        slot: options.name,
        id: options.id ?? null,
        key: options.key ?? null,
        order: options.order ?? null,
        componentType: typeof component,
      });
      return () => {};
    },
  },
};

plugin.apply(ctx);
disposers.forEach((fn) => fn());

const expected = [
  { slot: 'sidebar.panellist', via: 'id', value: 'thinking-treelog' },
  { slot: 'main', via: 'key', value: 'thinking-treelog' },
];

for (const want of expected) {
  const hit = registrations.find(
    (r) => r.kind === 'register' && r.slot === want.slot && r[want.via] === want.value,
  );
  if (!hit) {
    console.error('registrations:', JSON.stringify(registrations, null, 2));
    throw new Error(`missing registration for ${want.slot} (${want.via}=${want.value})`);
  }
  if (hit.componentType !== 'function') {
    throw new Error(`component for ${want.slot} is ${hit.componentType}, expected a function`);
  }
}

console.log('OK — plugin factory and slot registrations are valid');
console.log(JSON.stringify(registrations, null, 2));

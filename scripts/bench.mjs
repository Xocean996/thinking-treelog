/**
 * Benchmark the parser and linter against a real corpus of markdown files.
 *
 * Usage:
 *   node scripts/bench.mjs <dir> [--json]
 *
 * Reports wall time, per-file cost, the slowest files, and total findings. It is
 * also a robustness check: a parser that throws on real-world markdown fails here.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { parseMarkdown, lintTree } from '../packages/core/src/engineering.js';

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      out.push(...walk(full));
    } else if (/\.mdx?$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith('--'));
const asJson = args.includes('--json');

if (!root) {
  process.stderr.write('usage: node scripts/bench.mjs <dir> [--json]\n');
  process.exit(2);
}

const files = walk(root);
if (!files.length) {
  process.stderr.write(`no markdown files under ${root}\n`);
  process.exit(2);
}

const rows = [];
let totalBytes = 0;
let totalMs = 0;
let totalNodes = 0;
let totalFindings = 0;
let failures = 0;

const suiteStart = performance.now();

for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  const bytes = statSync(file).size;
  totalBytes += bytes;

  const started = performance.now();
  try {
    const nodes = parseMarkdown(raw);
    const findings = lintTree(nodes);
    const elapsed = performance.now() - started;

    totalMs += elapsed;
    totalNodes += nodes.length;
    totalFindings += findings.length;
    rows.push({ file, bytes, nodes: nodes.length, findings: findings.length, ms: elapsed });
  } catch (error) {
    failures += 1;
    rows.push({ file, bytes, error: String(error?.message ?? error) });
  }
}

const suiteMs = performance.now() - suiteStart;
rows.sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0));

const summary = {
  files: files.length,
  bytes: totalBytes,
  parseAndLintMs: Number(totalMs.toFixed(1)),
  wallMs: Number(suiteMs.toFixed(1)),
  nodes: totalNodes,
  findings: totalFindings,
  failures,
  meanMs: Number((totalMs / files.length).toFixed(2)),
  p95Ms: Number((rows[Math.floor(rows.length * 0.05)]?.ms ?? 0).toFixed(2)),
  bytesPerSecond: Math.round(totalBytes / (totalMs / 1000)),
};

if (asJson) {
  process.stdout.write(`${JSON.stringify({ summary, slowest: rows.slice(0, 5) }, null, 2)}\n`);
} else {
  process.stdout.write(
    [
      `corpus: ${root}`,
      `files:  ${summary.files}  (${(summary.bytes / 1024).toFixed(0)} KiB)`,
      `time:   ${summary.parseAndLintMs} ms parse+lint  (wall ${summary.wallMs} ms)`,
      `mean:   ${summary.meanMs} ms/file   p95: ${summary.p95Ms} ms`,
      `rate:   ${(summary.bytesPerSecond / 1024).toFixed(0)} KiB/s`,
      `nodes:  ${summary.nodes}   findings: ${summary.findings}   failures: ${summary.failures}`,
      '',
      'slowest:',
      ...rows
        .slice(0, 5)
        .map((row) =>
          row.error
            ? `  ✖ ${relative(process.cwd(), row.file)} — ${row.error}`
            : `  ${String(row.ms.toFixed(1)).padStart(7)} ms  ${String(row.nodes).padStart(4)} nodes  ${relative(process.cwd(), row.file)}`,
        ),
    ].join('\n') + '\n',
  );
}

if (failures > 0) process.exit(1);

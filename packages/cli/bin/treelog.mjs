#!/usr/bin/env node
/**
 * treelog — lint design docs for reasoning gaps, and turn them into trees.
 *
 * Zero runtime dependencies beyond the workspace core package.
 */

import { writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXIT_CODES,
  baselineDocument,
  diffPaths,
  exportTree,
  lintPaths,
  lintPlanFile,
  loadBaseline,
  loadConfig,
  loadTree,
  planTreeText,
  renderAsciiTree,
} from '../lib/commands.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8'));

const USAGE = `treelog ${pkg.version} — thought-tree lint for design docs

Usage:
  treelog lint <files...> [options]     Check documents for reasoning gaps (CI-ready)
  treelog plan <file> [options]         Audit a structured implementation plan
                                        (superpowers writing-plans format)
  treelog tree <file>                   Print the thought tree as ASCII
  treelog export <file> [options]       Export md | mermaid | adr | json | stats
  treelog diff <before> <after>         Compare two revisions of a decision

Options:
  --format <fmt>      lint: text | json | sarif | github | junit   (default text)
                      export: md | mermaid | adr | json | stats    (default md)
                      diff: text | json                             (default text)
  --tree              plan: print the plan as an ASCII tree instead of linting
  --lang <en|zh>      Message language (default: config, else en)
  --config <file>     Config file (default: nearest treelog.config.json)
  --preset <name>     recommended | strict | relaxed
  --baseline <file>   Ignore findings recorded in this baseline file
  --baseline-write    Accept everything now and write a baseline file
  --max-depth <n>     Maximum decision-chain depth (default 8)
  --min-confidence    Minimum confidence for conclusions (default 0.5)
  --fail-on <level>   error (default) | warning | never
  -o, --out <file>    Write to a file instead of stdout
  -h, --help          Show this help
  -v, --version       Show the version

File types:
  .md/.markdown  parsed by headings and lists (ADR-aware)
  .json          an existing tree ({nodes} or a node array)
  other / -      natural-language sentences (- reads stdin)

Suppress in a document:
  <!-- treelog-ignore -->                        silence this whole file
  <!-- treelog-ignore conclusion-without-evidence -->   silence one rule

Exit codes:
  0 no errors   1 errors found   2 usage error

Examples:
  treelog lint docs/adr/*.md --format sarif -o treelog.sarif
  treelog lint design.md --fail-on warning
  treelog lint docs/**/*.md --baseline .treelog-baseline.json
  treelog lint docs/ --baseline-write
  treelog export design.md --format adr
  treelog diff design.v1.md design.v2.md
`;

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '-h' || token === '--help') {
      args.flags.help = true;
      continue;
    }
    if (token === '-v' || token === '--version') {
      args.flags.version = true;
      continue;
    }
    if (token === '-o' || token === '--out') {
      args.flags.out = argv[++i];
      continue;
    }
    if (token.startsWith('--')) {
      const [name, inline] = token.slice(2).split('=');
      const camel = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (inline !== undefined) {
        args.flags[camel] = inline;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          args.flags[camel] = next;
          i += 1;
        } else {
          args.flags[camel] = true;
        }
      }
      continue;
    }
    args._.push(token);
  }
  return args;
}

async function main() {
  const argv = process.argv.slice(2);
  const { _, flags } = parseArgs(argv);

  if (flags.help || _.length === 0) {
    process.stdout.write(USAGE);
    return EXIT_CODES.ok;
  }
  if (flags.version) {
    process.stdout.write(`${pkg.version}\n`);
    return EXIT_CODES.ok;
  }

  const command = _[0];
  const files = _.slice(1);

  if (command === 'lint') {
    if (!files.length) {
      process.stderr.write('treelog lint needs at least one file\n');
      return EXIT_CODES.usage;
    }
    for (const file of files) {
      if (file !== '-' && !existsSync(file) && !file.includes('*')) {
        process.stderr.write(`file not found: ${file}\n`);
        return EXIT_CODES.usage;
      }
    }

    const config = await loadConfig({
      cwd: process.cwd(),
      configPath: typeof flags.config === 'string' ? flags.config : undefined,
    });
    if (typeof flags.preset === 'string') {
      // Re-expand the preset while keeping explicit rule overrides.
      const { PRESETS } = await import('@thinking-treelog/core/engineering');
      config.rules = { ...(PRESETS[flags.preset] ?? {}), ...(config.rules ?? {}) };
    }

    const baselinePath =
      (typeof flags.baseline === 'string' ? flags.baseline : null) ?? config.baseline;
    const writingBaseline = flags.baselineWrite === true;
    const baseline =
      baselinePath && !writingBaseline ? await loadBaseline(baselinePath) : new Set();

    const result = await lintPaths(files, {
      format: typeof flags.format === 'string' ? flags.format : 'text',
      config,
      locale: typeof flags.lang === 'string' ? flags.lang : config.locale,
      maxDepth: flags.maxDepth ? Number(flags.maxDepth) : undefined,
      minConclusionConfidence: flags.minConfidence ? Number(flags.minConfidence) : undefined,
      baseline,
      color: process.stdout.isTTY === true,
      version: pkg.version,
    });

    if (flags.out) await writeFile(flags.out, result.text, 'utf8');
    else process.stdout.write(`${result.text}\n`);

    if (writingBaseline) {
      const target = baselinePath ?? '.treelog-baseline.json';
      await writeFile(target, baselineDocument(result.allFindings), 'utf8');
      process.stderr.write(
        `treelog: wrote baseline with ${result.allFindings.length} finding(s) to ${target}\n`,
      );
      return EXIT_CODES.ok;
    }

    const failOn = typeof flags.failOn === 'string' ? flags.failOn : config.failOn ?? 'error';
    if (failOn === 'never') return EXIT_CODES.ok;
    if (failOn === 'warning') {
      return result.summary.error + result.summary.warning > 0 ? EXIT_CODES.findings : EXIT_CODES.ok;
    }
    return result.summary.error > 0 ? EXIT_CODES.findings : EXIT_CODES.ok;
  }

  if (command === 'plan') {
    if (!files.length) {
      process.stderr.write('treelog plan needs a plan file\n');
      return EXIT_CODES.usage;
    }
    const mode = flags.tree === true ? 'tree' : 'lint';

    if (mode === 'tree') {
      const { text } = await planTreeText(files[0]);
      if (flags.out) await writeFile(flags.out, text, 'utf8');
      else process.stdout.write(`${text}\n`);
      return EXIT_CODES.ok;
    }

    const result = await lintPlanFile(files[0], {
      format: typeof flags.format === 'string' ? flags.format : 'text',
      locale: typeof flags.lang === 'string' ? flags.lang : 'en',
      color: process.stdout.isTTY === true,
      version: pkg.version,
    });

    if (flags.out) await writeFile(flags.out, result.text, 'utf8');
    else process.stdout.write(`${result.text}\n`);

    const failOn = typeof flags.failOn === 'string' ? flags.failOn : 'error';
    if (failOn === 'never') return EXIT_CODES.ok;
    if (failOn === 'warning') {
      return result.summary.error + result.summary.warning > 0 ? EXIT_CODES.findings : EXIT_CODES.ok;
    }
    return result.summary.error > 0 ? EXIT_CODES.findings : EXIT_CODES.ok;
  }

  if (command === 'tree') {
    if (!files.length) {
      process.stderr.write('treelog tree needs a file\n');
      return EXIT_CODES.usage;
    }
    const tree = await loadTree(files[0]);
    const text = `${tree.title}\n${renderAsciiTree(tree.nodes)}\n\n${tree.nodes.length} node(s)`;
    if (flags.out) await writeFile(flags.out, text, 'utf8');
    else process.stdout.write(`${text}\n`);
    return EXIT_CODES.ok;
  }

  if (command === 'export') {
    if (!files.length) {
      process.stderr.write('treelog export needs a file\n');
      return EXIT_CODES.usage;
    }
    const text = await exportTree(files[0], {
      format: typeof flags.format === 'string' ? flags.format : 'md',
      adr: {
        id: typeof flags.id === 'string' ? flags.id : undefined,
        status: typeof flags.status === 'string' ? flags.status : undefined,
      },
    });
    if (flags.out) await writeFile(flags.out, text, 'utf8');
    else process.stdout.write(`${text}\n`);
    return EXIT_CODES.ok;
  }

  if (command === 'diff') {
    if (files.length < 2) {
      process.stderr.write('treelog diff needs two files\n');
      return EXIT_CODES.usage;
    }
    const result = await diffPaths(files[0], files[1], {
      format: typeof flags.format === 'string' ? flags.format : 'text',
    });
    if (flags.out) await writeFile(flags.out, result.text, 'utf8');
    else process.stdout.write(`${result.text}\n`);
    return EXIT_CODES.ok;
  }

  process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
  return EXIT_CODES.usage;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`treelog: ${error?.message ?? error}\n`);
    process.exit(EXIT_CODES.usage);
  });

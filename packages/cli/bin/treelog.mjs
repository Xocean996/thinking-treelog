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
  diffPaths,
  exportTree,
  lintPaths,
  loadTree,
  renderAsciiTree,
} from '../lib/commands.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8'));

const USAGE = `treelog ${pkg.version} — thought-tree lint for design docs

用法:
  treelog lint <文件...> [选项]        检查推理缺口（可进 CI）
  treelog tree <文件>                  以 ASCII 形式打印思维树
  treelog export <文件> [选项]         导出 md / mermaid / adr / json / stats
  treelog diff <旧文件> <新文件>       对比两版决策结构

选项:
  --format <fmt>     lint: text|json|sarif（默认 text）
                     export: md|mermaid|adr|json|stats（默认 md）
                     diff: text|json（默认 text）
  --max-depth <n>    lint 允许的最大决策链深度（默认 8）
  --min-confidence   lint 结论最低置信度（默认 0.5）
  --fail-on <level>  error（默认）| warning | never
  -o, --out <file>   写入文件而不是 stdout
  -h, --help         显示帮助
  -v, --version      显示版本

文件类型:
  .md/.markdown  按标题与列表解析成树
  .json          读取已有的树（{nodes} 或节点数组）
  其他 / -       按自然语言句子提取（- 表示 stdin）

退出码:
  0 没有 error   1 发现 error   2 用法错误

示例:
  treelog lint docs/adr/*.md --format sarif -o treelog.sarif
  treelog lint design.md --fail-on warning
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
      process.stderr.write('treelog lint 需要至少一个文件\n');
      return EXIT_CODES.usage;
    }
    for (const file of files) {
      if (file !== '-' && !existsSync(file)) {
        process.stderr.write(`文件不存在：${file}\n`);
        return EXIT_CODES.usage;
      }
    }

    const result = await lintPaths(files, {
      format: typeof flags.format === 'string' ? flags.format : 'text',
      maxDepth: flags.maxDepth ? Number(flags.maxDepth) : undefined,
      minConclusionConfidence: flags.minConfidence ? Number(flags.minConfidence) : undefined,
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
      process.stderr.write('treelog tree 需要一个文件\n');
      return EXIT_CODES.usage;
    }
    const tree = await loadTree(files[0]);
    const text = `${tree.title}\n${renderAsciiTree(tree.nodes)}\n\n${tree.nodes.length} 个节点`;
    if (flags.out) await writeFile(flags.out, text, 'utf8');
    else process.stdout.write(`${text}\n`);
    return EXIT_CODES.ok;
  }

  if (command === 'export') {
    if (!files.length) {
      process.stderr.write('treelog export 需要一个文件\n');
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
      process.stderr.write('treelog diff 需要两个文件\n');
      return EXIT_CODES.usage;
    }
    const result = await diffPaths(files[0], files[1], {
      format: typeof flags.format === 'string' ? flags.format : 'text',
    });
    if (flags.out) await writeFile(flags.out, result.text, 'utf8');
    else process.stdout.write(`${result.text}\n`);
    return EXIT_CODES.ok;
  }

  process.stderr.write(`未知命令：${command}\n\n${USAGE}`);
  return EXIT_CODES.usage;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`treelog: ${error?.message ?? error}\n`);
    process.exit(EXIT_CODES.usage);
  });

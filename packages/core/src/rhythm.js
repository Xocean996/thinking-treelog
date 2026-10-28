/**
 * @thinking-treelog/core/rhythm
 *
 * Reads a working project's pulse and turns it into a thought tree:
 * where the work has been, how fast it is moving, where it stalled, and what
 * is still open. Node-only (git + fs); the dsh panel cannot reach these APIs,
 * so this is exposed through the CLI and the MCP server, whose output lands in
 * the conversation.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const DAY_MS = 86400000;

const THEME_RULES = [
  { theme: 'feature', re: /^(feat|feature|add|implement)\b|新增|实现|添加/i },
  { theme: 'fix', re: /^(fix|bugfix|hotfix|repair)\b|修复|修正/i },
  { theme: 'docs', re: /^(docs?|readme|document)\b|文档|说明/i },
  { theme: 'refactor', re: /^(refactor|restructure|cleanup)\b|重构|整理/i },
  { theme: 'test', re: /^(test|spec|coverage)\b|测试/i },
  { theme: 'chore', re: /^(chore|build|ci|deps|release|bump)\b|构建|发布/i },
];

/** @param {string} subject */
export function themeOf(subject) {
  for (const rule of THEME_RULES) {
    if (rule.re.test(String(subject).trim())) return rule.theme;
  }
  return 'other';
}

/**
 * @param {string} dir
 * @param {number} limit
 * @returns {{hash: string, timestamp: number, subject: string}[]}
 */
export function readGitLog(dir, limit = 60) {
  try {
    const raw = execFileSync(
      'git',
      ['-C', dir, 'log', `-n${limit}`, '--pretty=format:%h%x1f%at%x1f%s'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 },
    );
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, ts, subject] = line.split('\x1f');
        return { hash, timestamp: Number(ts) * 1000, subject: subject || '' };
      })
      .filter((c) => Number.isFinite(c.timestamp));
  } catch {
    return [];
  }
}

/**
 * Per-commit file changes, for the questions a weekly report actually asks:
 * which files moved, and whether a code change shipped without touching tests.
 *
 * `git log --numstat` prints a NUL-free record per commit: a header line
 * (`\x01<hash>`) followed by `add \t del \t path` lines. Directories are skipped
 * because they carry no signal about risk.
 *
 * @param {string} dir
 * @param {number} limit
 * @returns {Map<string, {files: {path: string, added: number, deleted: number}[]}>}
 */
export function readCommitFiles(dir, limit = 60) {
  const out = new Map();
  try {
    const raw = execFileSync(
      'git',
      ['-C', dir, 'log', `-n${limit}`, '--numstat', '--pretty=format:\x01%h', '--no-renames'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 12000, maxBuffer: 16 * 1024 * 1024 },
    );

    let current = null;
    for (const line of raw.split('\n')) {
      const trimmed = line.replace(/\r$/, '');
      if (trimmed.startsWith('\x01')) {
        current = { files: [] };
        out.set(trimmed.slice(1).trim(), current);
        continue;
      }
      if (!current || !trimmed.trim()) continue;
      const parts = trimmed.split('\t');
      if (parts.length < 3) continue;
      const added = parts[0] === '-' ? 0 : Number(parts[0]);
      const deleted = parts[1] === '-' ? 0 : Number(parts[1]);
      const path = parts[2];
      if (!Number.isFinite(added) || !Number.isFinite(deleted)) continue;
      current.files.push({ path, added, deleted });
    }
  } catch {
    return out;
  }
  return out;
}

/** A file is a test when it lives in a test dir or carries a test suffix. */
export function isTestPath(path) {
  const value = String(path || '').replace(/\\/g, '/');
  return /(^|\/)(__tests__|tests?|spec)\//i.test(value) || /\.(test|spec)\.[a-z]+$/i.test(value);
}

/** Source files that carry behaviour: TS/JS/Python/Go/Rust/Java/Kotlin, not docs or config. */
export function isSourcePath(path) {
  const value = String(path || '').replace(/\\/g, '/');
  if (/(^|\/)(node_modules|dist|build|coverage|vendor)\//.test(value)) return false;
  if (/\.(md|txt|json|ya?ml|toml|lock|svg|png|jpg|gif)$/i.test(value)) return false;
  return /\.(js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|kt|rb|php|c|cc|cpp|h|hpp|swift|scala|sh)$/i.test(
    value,
  );
}

/** Fallback pulse when the directory is not a git repo. */
function readMtimePulse(dir, limit = 60) {
  const skip = /(^|\/)(node_modules|\.git|dist|build|coverage)(\/|$)/;
  const out = [];
  const walk = (current, depth) => {
    if (depth > 3 || out.length > 400) return;
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (skip.test(full)) continue;
      if (entry.isDirectory()) walk(full, depth + 1);
      else {
        try {
          const st = statSync(full);
          out.push({ path: full, timestamp: st.mtimeMs });
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(resolve(dir), 0);
  out.sort((a, b) => b.timestamp - a.timestamp);
  return out.slice(0, limit);
}

const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

/**
 * @param {string} dir
 * @param {{ commits?: {timestamp:number,subject:string}[], now?: number, limit?: number }} [options]
 */
export function analyzeRhythm(dir, options = {}) {
  const now = options.now ?? Date.now();
  const commits = options.commits ?? readGitLog(dir, options.limit ?? 60);
  const source = commits.length ? 'git' : 'mtime';
  const events = commits.length
    ? commits
    : readMtimePulse(dir).map((file) => ({
        hash: '',
        timestamp: file.timestamp,
        subject: `edited ${file.path.split(/[\\/]/).slice(-1)[0]}`,
      }));

  if (!events.length) {
    return {
      project: basename(resolve(dir)),
      source,
      commits: [],
      phases: [],
      themes: {},
      activeDays: 0,
      spanDays: 0,
      cadencePerDay: 0,
      lastAgoDays: null,
      stalled: false,
      streakDays: 0,
      message: 'No git history and no readable files.',
    };
  }

  const sorted = [...events].sort((a, b) => b.timestamp - a.timestamp);
  const newest = sorted[0].timestamp;
  const oldest = sorted[sorted.length - 1].timestamp;
  const spanDays = Math.max(1, Math.round((newest - oldest) / DAY_MS) || 1);
  const lastAgoDays = Math.max(0, Math.round((now - newest) / DAY_MS));

  const dayCounts = new Map();
  for (const event of sorted) {
    const key = dayKey(event.timestamp);
    dayCounts.set(key, (dayCounts.get(key) || 0) + 1);
  }
  const activeDays = dayCounts.size;

  // Streak: consecutive days up to today, allowing today to be idle-but-recent.
  let streakDays = 0;
  for (let i = 0; i < 90; i += 1) {
    const key = dayKey(now - i * DAY_MS);
    if (dayCounts.has(key)) streakDays += 1;
    else if (i > 0) break;
  }

  // Phases: split where the gap between consecutive events exceeds two days.
  const phases = [];
  let current = null;
  const ascending = [...sorted].reverse();
  for (const event of ascending) {
    if (!current || event.timestamp - current.end > 2 * DAY_MS) {
      if (current) phases.push(current);
      current = { start: event.timestamp, end: event.timestamp, count: 0, themes: {}, samples: [] };
    }
    current.end = event.timestamp;
    current.count += 1;
    const theme = themeOf(event.subject);
    current.themes[theme] = (current.themes[theme] || 0) + 1;
    if (current.samples.length < 3) current.samples.push(event.subject);
  }
  if (current) phases.push(current);

  const themes = {};
  for (const event of sorted) {
    const theme = themeOf(event.subject);
    themes[theme] = (themes[theme] || 0) + 1;
  }

  return {
    project: basename(resolve(dir)),
    source,
    commits: sorted,
    phases,
    themes,
    activeDays,
    spanDays,
    cadencePerDay: Number((sorted.length / spanDays).toFixed(2)),
    lastAgoDays,
    stalled: lastAgoDays >= 3,
    streakDays,
    newest,
    oldest,
  };
}

const fmtDate = (ts) => new Date(ts).toISOString().slice(0, 10);

/**
 * Turn the pulse into thought-tree nodes so it renders on the same canvas.
 *
 * @param {ReturnType<typeof analyzeRhythm>} analysis
 */
export function rhythmToTree(analysis) {
  const nodes = [];
  const now = Date.now();
  let seq = 0;

  const push = (parentId, label, text, type, extra) => {
    seq += 1;
    nodes.push({
      id: `rh${seq}`,
      parentId,
      label: String(label).slice(0, 30),
      text: text || label,
      type,
      confidence: 0.8,
      branchId: 'main',
      createdAt: now + seq,
      tags: [],
      ...(extra || {}),
    });
    return nodes[nodes.length - 1];
  };

  const root = push(
    null,
    `${analysis.project} · 项目节奏`,
    `${analysis.commits.length} 次活动 · ${analysis.activeDays} 个活跃日 · ${analysis.spanDays} 天跨度`,
    'claim',
    { isSection: true },
  );

  push(
    root.id,
    analysis.stalled ? `停滞 ${analysis.lastAgoDays} 天` : `最近活动 ${analysis.lastAgoDays} 天前`,
    analysis.stalled
      ? `最后一次改动在 ${analysis.lastAgoDays} 天前，节奏已经断档`
      : `仍在推进，连续 ${analysis.streakDays} 天有改动`,
    analysis.stalled ? 'constraint' : 'evidence',
  );

  const phaseGroup = push(root.id, `阶段（${analysis.phases.length}）`, '按中断切分的冲刺段', 'claim', {
    isSection: true,
  });
  analysis.phases.slice(-6).forEach((phase) => {
    const top = Object.entries(phase.themes).sort((a, b) => b[1] - a[1])[0];
    const node = push(
      phaseGroup.id,
      `${fmtDate(phase.start)} → ${fmtDate(phase.end)}`,
      `${phase.count} 次改动，主线是 ${top ? top[0] : 'other'}`,
      'action',
    );
    phase.samples.forEach((sample) => push(node.id, sample, sample, 'action'));
  });

  const themeGroup = push(root.id, '主线分布', '按提交主题归类', 'claim', { isSection: true });
  Object.entries(analysis.themes)
    .sort((a, b) => b[1] - a[1])
    .forEach(([theme, count]) => {
      push(themeGroup.id, `${theme} × ${count}`, `${count} 次 ${theme} 类改动`, count >= 3 ? 'conclusion' : 'evidence');
    });

  return nodes;
}

/**
 * @param {ReturnType<typeof analyzeRhythm>} analysis
 * @param {{ locale?: 'en'|'zh' }} [context]
 */
export function formatRhythm(analysis, context = {}) {
  const zh = context.locale !== 'en';
  const lines = [];

  lines.push(`${analysis.project} — ${zh ? '项目节奏' : 'project rhythm'}`);
  lines.push(
    zh
      ? `  ${analysis.commits.length} 次活动 · ${analysis.activeDays} 个活跃日 · 跨度 ${analysis.spanDays} 天 · 日均 ${analysis.cadencePerDay}`
      : `  ${analysis.commits.length} events · ${analysis.activeDays} active days · span ${analysis.spanDays}d · ${analysis.cadencePerDay}/day`,
  );

  if (analysis.message) {
    lines.push(`  ${analysis.message}`);
    return lines.join('\n');
  }

  lines.push('');
  lines.push(
    zh
      ? `当前：${analysis.stalled ? `⚠ 停滞 ${analysis.lastAgoDays} 天` : `连续 ${analysis.streakDays} 天有改动`}`
      : `now: ${analysis.stalled ? `stalled ${analysis.lastAgoDays}d` : `${analysis.streakDays}d streak`}`,
  );

  lines.push('');
  lines.push(zh ? '阶段：' : 'phases:');
  analysis.phases.slice(-6).forEach((phase) => {
    const top = Object.entries(phase.themes).sort((a, b) => b[1] - a[1])[0];
    lines.push(
      `  ${fmtDate(phase.start)} → ${fmtDate(phase.end)}  ${String(phase.count).padStart(2)} 次  ${top ? top[0] : 'other'}`,
    );
  });

  lines.push('');
  lines.push(zh ? '主线：' : 'themes:');
  Object.entries(analysis.themes)
    .sort((a, b) => b[1] - a[1])
    .forEach(([theme, count]) => {
      lines.push(`  ${theme.padEnd(9)} ${count}`);
    });

  lines.push('');
  lines.push(
    zh
      ? analysis.stalled
        ? `建议：先处理断档——从最后一条「${analysis.commits[0].subject}」接上，或者明确放弃它。`
        : `建议：保持当前节奏，下一步接着「${analysis.commits[0].subject}」推进。`
      : analysis.stalled
        ? `pick up from: "${analysis.commits[0].subject}" or explicitly drop it`
        : `next: continue from "${analysis.commits[0].subject}"`,
  );

  return lines.join('\n');
}

/**
 * Build the week's facts from git, without the prose.
 *
 * This is what a weekly report needs and what the person writing it cannot
 * reconstruct from memory: what shipped, whether it landed with tests, which
 * files absorbed the effort, and whether the pattern is healthy.
 *
 * @param {string} dir
 * @param {{ days?: number, now?: number, commits?: any[], fileMap?: Map<string, any> }} [options]
 */
/**
 * The most recent tag and when it was cut.
 *
 * Teams report per release, not per calendar week: "since v1.2.0" is the range a
 * reviewer recognises.
 *
 * @param {string} dir
 * @returns {{tag: string, timestamp: number} | null}
 */
export function readLastTag(dir) {
  const run = (args) =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 6000,
    }).trim();
  try {
    const tag = run(['describe', '--tags', '--abbrev=0']);
    if (!tag) return null;
    const stamp = Number(run(['log', '-1', '--format=%at', tag]));
    if (!Number.isFinite(stamp) || stamp <= 0) return null;
    return { tag, timestamp: stamp * 1000 };
  } catch {
    return null;
  }
}

export function weeklyFacts(dir, options = {}) {
  const days = options.days ?? 7;
  const now = options.now ?? Date.now();

  // Opt-in: `--since-last-tag`. Defaulting to the tag would silently change what
  // "weekly" means for every repository that has any tag.
  const tag = options.sinceTag ? readLastTag(dir) : null;
  const since = tag ? tag.timestamp : now - days * DAY_MS;

  const allCommits = options.commits ?? readGitLog(dir, 400);
  const fileMap = options.fileMap ?? readCommitFiles(dir, 400);
  const commits = allCommits.filter((c) => c.timestamp >= since).sort((a, b) => a.timestamp - b.timestamp);

  const files = new Map();
  const themes = {};
  const untested = [];
  let added = 0;
  let deleted = 0;

  for (const commit of commits) {
    const theme = themeOf(commit.subject);
    themes[theme] = (themes[theme] || 0) + 1;

    const changed = (fileMap.get(commit.hash) || {}).files || [];
    const sources = [];
    let hasTest = false;
    for (const file of changed) {
      added += file.added;
      deleted += file.deleted;
      const entry = files.get(file.path) || { path: file.path, touched: 0, added: 0, deleted: 0 };
      entry.touched += 1;
      entry.added += file.added;
      entry.deleted += file.deleted;
      files.set(file.path, entry);
      if (isTestPath(file.path)) hasTest = true;
      else if (isSourcePath(file.path)) sources.push(file.path);
    }

    // A commit that changed real source and no test is the risk worth naming.
    if (sources.length && !hasTest) {
      untested.push({
        hash: commit.hash,
        subject: commit.subject,
        sources: sources.slice(0, 3),
        sourceCount: sources.length,
      });
    }
  }

  // Day buckets, so consecutive workdays and lost weekends both become visible.
  const byDay = new Map();
  for (const commit of commits) {
    const key = new Date(commit.timestamp).toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) || 0) + 1);
  }
  const activeDays = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  // Late-night work: a habit that predicts next week's bugs better than velocity.
  const lateCommits = commits.filter((c) => {
    const hour = new Date(c.timestamp).getHours();
    return hour >= 23 || hour < 5;
  });

  return {
    dir: resolve(dir),
    days,
    since,
    now,
    tag: tag ? tag.tag : '',
    commits,
    commitCount: commits.length,
    themes,
    totalAdded: added,
    totalDeleted: deleted,
    files: [...files.values()].sort((a, b) => b.touched - a.touched).slice(0, 12),
    activeDays,
    untested: untested.slice(0, 10),
    untestedCount: untested.length,
    lateNight: lateCommits.length,
    lateNightSamples: lateCommits.slice(-3).map((c) => c.subject).filter(Boolean),
    fixes: themes.fix || 0,
    features: themes.feature || 0,
    churn: commits.length ? Number(((deleted / Math.max(1, added)) * 100).toFixed(0)) : 0,
  };
}

const fmtShortDate = (stamp) => new Date(stamp).toISOString().slice(5, 10);

/**
 * Render the weekly report as Markdown, ready to paste into a tracker or a chat.
 *
 * Written in the order a reader cares about: what moved, what it cost, what
 * looks risky, and one thing to change.
 *
 * @param {ReturnType<typeof weeklyFacts>} facts
 * @param {{ locale?: 'zh'|'en', name?: string }} [options]
 */
export function formatWeekly(facts, options = {}) {
  const zh = options.locale !== 'en';
  const lines = [];
  const project = options.name || basename(facts.dir) || 'project';

  const range =
    facts.activeDays.length > 0
      ? `${facts.activeDays[0][0]} → ${facts.activeDays[facts.activeDays.length - 1][0]}`
      : `${fmtShortDate(facts.since)} → ${fmtShortDate(facts.now)}`;

  lines.push(zh ? `# 周报 · ${project}` : `# Weekly · ${project}`);
  lines.push('');
  const scope = facts.tag
    ? zh
      ? `自 ${facts.tag}`
      : `since ${facts.tag}`
    : zh
      ? `近 ${facts.days} 天`
      : `last ${facts.days} days`;
  lines.push(zh ? `周期：${range}（${scope}）` : `Range: ${range} (${scope})`);
  lines.push('');

  if (!facts.commitCount) {
    lines.push(zh ? '这一周没有提交记录。' : 'No commits in this window.');
    return lines.join('\n');
  }

  lines.push(
    zh
      ? `**${facts.commitCount} 次提交 · ${facts.activeDays.length} 个活跃日 · +${facts.totalAdded} / −${facts.totalDeleted} 行**`
      : `**${facts.commitCount} commits · ${facts.activeDays.length} active days · +${facts.totalAdded} / −${facts.totalDeleted} lines**`,
  );
  lines.push('');

  // 1. What shipped.
  lines.push(zh ? '## 交付了什么' : '## What shipped');
  lines.push('');
  const themeLabel = zh
    ? { feature: '功能', fix: '修复', docs: '文档', refactor: '重构', test: '测试', chore: '构建', other: '其他' }
    : { feature: 'feature', fix: 'fix', docs: 'docs', refactor: 'refactor', test: 'test', chore: 'chore', other: 'other' };

  Object.entries(facts.themes)
    .sort((a, b) => b[1] - a[1])
    .forEach(([theme, count]) => {
      lines.push(`- ${themeLabel[theme] || theme}：${count} 次`);
    });
  lines.push('');

  // 2. Where the effort went.
  if (facts.files.length) {
    lines.push(zh ? '## 精力花在哪' : '## Where the effort went');
    lines.push('');
    lines.push(zh ? '| 文件 | 改动次数 | 新增 | 删除 |' : '| file | touched | added | deleted |');
    lines.push('|---|---|---|---|');
    facts.files.slice(0, 8).forEach((file) => {
      lines.push(`| \`${file.path}\` | ${file.touched} | +${file.added} | −${file.deleted} |`);
    });
    lines.push('');
  }

  // 3. Risk.
  const risks = [];
  if (facts.untestedCount) {
    risks.push(
      zh
        ? `**${facts.untestedCount} 次改动只动了源码、没动测试**——这是最值得在评审里说清楚的部分。`
        : `**${facts.untestedCount} commits changed source without touching tests.**`,
    );
    // Rendered as a sub-list, so each sample carries its own indentation.
    facts.untested.slice(0, 3).forEach((item) => {
      risks.push(`\n  - \`${item.hash}\` ${item.subject || ''}`);
    });
    risks.push('');
  }
  if (facts.churn > 60) {
    risks.push(
      zh
        ? `删除行占新增行的 ${facts.churn}%——返工偏多，可以考虑先把接口定下来再写实现。`
        : `Deletions are ${facts.churn}% of additions — high rework.`,
    );
  }
  if (facts.lateNight >= 3) {
    risks.push(
      zh
        ? `${facts.lateNight} 次提交在 23 点后——连续熬夜通常会在两周内变成 bug。`
        : `${facts.lateNight} commits after 23:00.`,
    );
  }
  if (facts.activeDays.length && facts.days >= 5 && facts.activeDays.length <= 1) {
    risks.push(
      zh
        ? `近 ${facts.days} 天只有 ${facts.activeDays.length} 天有提交——工作被压缩到了一天。`
        : `Only ${facts.activeDays.length} active day in ${facts.days}.`,
    );
  }

  if (risks.length) {
    lines.push(zh ? '## 需要说明的' : '## Worth explaining');
    lines.push('');
    risks.forEach((risk) => {
      if (!risk) return;
      // Sample lines already carry their own indent.
      lines.push(risk.startsWith('\n') ? risk.slice(1) : `- ${risk}`);
    });
    lines.push('');
  }

  // 4. One thing to change. A weekly report with ten action items gets none done.
  const worstFile = facts.files[0];
  const advice = [];
  if (facts.untestedCount) {
    advice.push(
      zh
        ? `补 1 条针对最高频改动文件的测试${worstFile ? `（\`${worstFile.path}\`）` : ''}。`
        : `Add one test for the most-touched file${worstFile ? ` (\`${worstFile.path}\`)` : ''}.`,
    );
  }
  if (facts.fixes > facts.features) {
    advice.push(
      zh
        ? '修复多于功能说明在还债：下周先挑一个反复出问题的地方做一次结构性修复。'
        : 'More fixes than features: pick one recurring area and fix it structurally.',
    );
  }
  if (facts.lateNight >= 3) {
    advice.push(zh ? '把最难的活放到上午，23 点后只做收尾。' : 'Move the hard work to the morning.');
  }
  if (!advice.length) {
    advice.push(zh ? '保持节奏；下周把一件没做完的事收尾，别开新线。' : 'Keep the pace; finish one open item.');
  }

  lines.push(zh ? '## 下周只改一件事' : '## One change next week');
  lines.push('');
  advice.slice(0, 1).forEach((item) => lines.push(`- ${item}`));
  lines.push('');

  lines.push('---');
  lines.push(
    zh
      ? '由 `treelog weekly` 从 git 历史生成；数字可直接进周报，判断请自己复核。'
      : 'Generated by `treelog weekly` from git history.',
  );

  return lines.join('\n');
}

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

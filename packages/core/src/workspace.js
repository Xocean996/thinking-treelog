/**
 * @thinking-treelog/core/workspace
 *
 * Reads what is actually happening in a dsh workspace by decoding its session
 * logs (`~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd`), then
 * reports the thread of work and what to do next.
 *
 * The log is one zstd frame per append, so it must be split on the frame magic
 * before decompressing; the sync API only reads the first frame.
 *
 * Node-only: the dsh panel cannot read the filesystem.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const DAY_MS = 86400000;

/** @param {string} [home] */
export function sessionsRoot(home = homedir()) {
  return join(home, '.dsh', 'sessions');
}

/**
 * Decode the tail of a session log. Newest appends are at the end of the file.
 *
 * @param {string} file
 * @param {{ maxFrames?: number, fromTail?: boolean }} [options]
 * @returns {any[]}
 */
export function decodeSession(file, options = {}) {
  const maxFrames = options.maxFrames ?? 1500;
  const headFrames = options.headFrames ?? 0;
  const fromTail = options.fromTail !== false;

  const buf = readFileSync(file);
  const offsets = [];
  let at = buf.indexOf(MAGIC);
  while (at !== -1) {
    offsets.push(at);
    at = buf.indexOf(MAGIC, at + 4);
  }
  if (!offsets.length) return [];

  // The session header and the first title live at the head; recent messages at
  // the tail. Read both without decompressing the whole log.
  const wanted = new Set();
  for (let i = 0; i < Math.min(headFrames, offsets.length); i += 1) wanted.add(i);
  const tailStart = fromTail ? Math.max(0, offsets.length - maxFrames) : 0;
  for (let i = tailStart; i < offsets.length; i += 1) wanted.add(i);

  const records = [];
  for (const i of [...wanted].sort((a, b) => a - b)) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length;
    try {
      const text = zstdDecompressSync(buf.subarray(offsets[i], end)).toString('utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line));
        } catch {
          /* ignore a truncated line */
        }
      }
    } catch {
      /* a frame that fails to decode does not abort the read */
    }
  }

  records.sort((a, b) => (a.time || 0) - (b.time || 0) || (a.seq || 0) - (b.seq || 0));
  return records;
}

/**
 * @param {string} root
 * @returns {{workspace: string, sessions: {id: string, file: string, mtime: number, size: number}[], mtime: number}[]}
 */
export function listWorkspaces(root) {
  const out = [];
  let workspaces = [];
  try {
    workspaces = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const wsDir = join(root, workspace.name);
    const sessions = [];
    let entries = [];
    try {
      entries = readdirSync(wsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of entries) {
      if (!session.isDirectory()) continue;
      const dir = join(wsDir, session.name);
      let files = [];
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      const target = files.find((f) => f.endsWith('.zstd'));
      if (!target) continue;
      const full = join(dir, target);
      try {
        const st = statSync(full);
        sessions.push({ id: session.name, file: full, mtime: st.mtimeMs, size: st.size });
      } catch {
        /* skip */
      }
    }
    if (!sessions.length) continue;
    sessions.sort((a, b) => b.mtime - a.mtime);
    out.push({ workspace: workspace.name, sessions, mtime: sessions[0].mtime });
  }

  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

const textOf = (parts) =>
  (Array.isArray(parts) ? parts : [])
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

// The harness injects reminders and turn timestamps into user messages; they are
// not part of what the person asked.
const NOISE_RE =
  /^(<system-reminder>|Time sampled while preparing|Current runtime context\.|\[model changed:|\[skill\])/i;
const isNoise = (text) => NOISE_RE.test(String(text).trim());

/**
 * @param {any[]} records
 */
export function analyzeConversation(records) {
  let session = null;
  let title = '';
  let lastAt = null;
  let turns = 0;
  let todos = [];
  const messages = [];
  const tools = {};

  for (const rec of records) {
    if (typeof rec.time === 'number') lastAt = Math.max(lastAt || 0, rec.time);

    switch (rec.type) {
      case 'session':
        session = rec;
        break;
      case 'session/title':
        if (rec.data && typeof rec.data.title === 'string' && rec.data.title.trim()) {
          title = rec.data.title.trim();
        }
        break;
      case 'user/message': {
        const text = textOf(rec.data && rec.data.content);
        if (text && !isNoise(text)) messages.push({ role: 'user', text, time: rec.time || 0 });
        break;
      }
      case 'assistant/message': {
        const text = textOf(rec.data && rec.data.message && rec.data.message.content);
        if (text) messages.push({ role: 'assistant', text, time: rec.time || 0 });
        break;
      }
      case 'tool/call':
        if (rec.data && rec.data.name) tools[rec.data.name] = (tools[rec.data.name] || 0) + 1;
        break;
      case 'todo/write':
        if (rec.data && Array.isArray(rec.data.todos)) todos = rec.data.todos;
        break;
      case 'turn/start':
        if (rec.data && Number.isFinite(rec.data.turn)) turns = Math.max(turns, rec.data.turn);
        break;
      default:
        break;
    }
  }

  const userMessages = messages.filter((m) => m.role === 'user');
  // The title record can sit in an early frame; fall back to the first question.
  if (!title && userMessages.length) title = short(userMessages[0].text, 28);

  return {
    id: (session && session.id) || '',
    cwd: (session && session.cwd) || '',
    title,
    startedAt: (session && session.createdAt) || null,
    lastAt,
    turns,
    messages,
    userMessages,
    tools,
    todos,
    toolCalls: Object.values(tools).reduce((a, b) => a + b, 0),
  };
}

/**
 * Pick the workspace/session that matches `cwd`, or the most recently touched one.
 *
 * @param {{workspace: string, sessions: any[], mtime: number}[]} workspaces
 * @param {{ cwd?: string, sessionId?: string }} [want]
 */
export function pickSession(workspaces, want = {}) {
  const target = (want.cwd || '').toLowerCase().replace(/[\\/]+$/, '');

  for (const entry of workspaces) {
    for (const session of entry.sessions) {
      if (want.sessionId && session.id === want.sessionId) {
        return { workspace: entry.workspace, session };
      }
    }
  }

  if (target) {
    for (const entry of workspaces) {
      for (const session of entry.sessions) {
        try {
          // The session header (with cwd) is in the first frame, not the last.
          const records = decodeSession(session.file, { maxFrames: 2, fromTail: false });
          const found = records.find((r) => r.type === 'session');
          const cwd =
            found && typeof found.cwd === 'string'
              ? found.cwd.toLowerCase().replace(/[\\/]+$/, '')
              : '';
          if (cwd && (cwd === target || cwd.startsWith(target) || target.startsWith(cwd))) {
            return { workspace: entry.workspace, session };
          }
        } catch {
          /* skip */
        }
      }
    }
  }

  const first = workspaces[0];
  return first ? { workspace: first.workspace, session: first.sessions[0] } : null;
}

const short = (text, max = 46) => {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
};

/**
 * The thread of work: what the session has been about, turn by turn.
 *
 * @param {ReturnType<typeof analyzeConversation>} analysis
 * @param {{ maxThreads?: number }} [options]
 */
export function threadOf(analysis, options = {}) {
  const max = options.maxThreads ?? 8;
  return analysis.userMessages.slice(-max).map((message, index) => ({
    index: index + 1,
    time: message.time,
    summary: short(message.text, 52),
  }));
}

/**
 * Suggestions: superpowers moves plus this project's own angle.
 *
 * @param {ReturnType<typeof analyzeConversation>} analysis
 * @param {{ now?: number, hasTrees?: boolean }} [options]
 */
export function suggestNext(analysis, options = {}) {
  const now = options.now ?? Date.now();
  const out = [];

  const pending = (analysis.todos || []).filter((todo) => todo && todo.status !== 'completed');
  if (pending.length) {
    out.push({
      kind: 'superpowers',
      move: 'executing-plans',
      title: `接着做完「${short(pending[0].content, 30)}」`,
      why: '未完成的 todo 是唯一明确的下一步；别开新线。',
    });
  } else if (analysis.turns > 3) {
    out.push({
      kind: 'superpowers',
      move: 'writing-plans',
      title: '把当前方向固化成一份计划',
      why: '聊了很多轮却没有 todo，说明还在发散，没有可验收的任务。',
    });
  }

  const idleDays = analysis.lastAt ? Math.floor((now - analysis.lastAt) / DAY_MS) : null;
  if (idleDays !== null && idleDays >= 3) {
    out.push({
      kind: 'superpowers',
      move: 'finishing-a-development-branch',
      title: `这段工作停了 ${idleDays} 天`,
      why: '要么接上最后一条，要么明确放弃——悬着的分支比失败的分支更贵。',
    });
  }

  if (analysis.toolCalls >= 12) {
    out.push({
      kind: 'superpowers',
      move: 'systematic-debugging',
      title: `这轮有 ${analysis.toolCalls} 次工具调用`,
      why: '调用密度这么高时，先写假设再动手，比继续试错便宜。',
    });
  }

  out.push({
    kind: 'treelog',
    move: 'treelog lint',
    title: '给这段对话留一张决策树',
    why: '把散落的选择变成带类型的节点，lint 会指出哪些结论还没有论据。',
  });

  out.push({
    kind: 'treelog',
    move: 'treelog trace',
    title: '对照 spec 检查覆盖',
    why: '如果这段工作有设计文档，trace 能列出哪些决策在计划里没有对应任务。',
  });

  return out;
}

/**
 * @param {ReturnType<typeof analyzeConversation>} analysis
 * @param {ReturnType<typeof suggestNext>} suggestions
 * @param {{ thread?: ReturnType<typeof threadOf> }} [extra]
 */
export function formatPulse(analysis, suggestions, extra = {}) {
  const lines = [];
  const thread = extra.thread || threadOf(analysis);

  lines.push(`工作区脉络 · ${analysis.title || '(未命名会话)'}`);
  if (analysis.cwd) lines.push(`  ${analysis.cwd}`);
  lines.push(
    `  ${analysis.turns} 轮 · ${analysis.messages.length} 条消息 · ${analysis.toolCalls} 次工具调用`,
  );
  if (analysis.lastAt) {
    const idle = Math.floor((Date.now() - analysis.lastAt) / DAY_MS);
    lines.push(idle === 0 ? '  今天仍在推进' : `  最近一次活动在 ${idle} 天前`);
  }

  if (thread.length) {
    lines.push('');
    lines.push('在做什么（最近的提问）：');
    thread.forEach((item) => lines.push(`  ${String(item.index).padStart(2)}. ${item.summary}`));
  }

  const toolTop = Object.entries(analysis.tools || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  if (toolTop.length) {
    lines.push('');
    lines.push('怎么在做：');
    lines.push(`  ${toolTop.map(([name, count]) => `${name}×${count}`).join('  ')}`);
  }

  const pending = (analysis.todos || []).filter((todo) => todo && todo.status !== 'completed');
  if (pending.length) {
    lines.push('');
    lines.push('还没做完：');
    pending.slice(0, 4).forEach((todo) => lines.push(`  ○ ${short(todo.content, 40)}`));
  }

  lines.push('');
  lines.push('建议：');
  suggestions.forEach((item, index) => {
    const tag = item.kind === 'superpowers' ? '［superpowers］' : '［treelog］';
    lines.push(`  ${index + 1}. ${tag} ${item.title}`);
    lines.push(`     ${item.why}`);
  });

  return lines.join('\n');
}

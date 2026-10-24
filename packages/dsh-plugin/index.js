/**
 * Host half of Thinking TreeLog.
 *
 * The Client half runs in the page sandbox and cannot read `~/.dsh/sessions` or
 * run git. This half runs in the Host process, serves a tiny loopback HTTP
 * endpoint, and lets the panel ask for an analysis of the workspace it is in.
 *
 * Endpoints (127.0.0.1 only, permissive CORS for the local page):
 *   GET /health          -> { ok, version }
 *   GET /pulse?cwd=...   -> workspace thread + suggestions + tree nodes
 */

import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { homedir } from 'node:os';
import { join } from 'node:path';

const VERSION = '0.4.0';
const PORT = Number(process.env.TTL_PORT) || 17866;
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const DAY_MS = 86400000;
const NOISE_RE =
  /^(<system-reminder>|Time sampled while preparing|Current runtime context\.|\[model changed:|\[skill\])/i;

const short = (text, max = 40) => {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
};

function sessionsRoot() {
  return join(homedir(), '.dsh', 'sessions');
}

function decodeSession(file, maxFrames = 1500, headFrames = 6) {
  const buf = readFileSync(file);
  const offsets = [];
  let at = buf.indexOf(MAGIC);
  while (at !== -1) {
    offsets.push(at);
    at = buf.indexOf(MAGIC, at + 4);
  }
  if (!offsets.length) return [];

  const wanted = new Set();
  for (let i = 0; i < Math.min(headFrames, offsets.length); i += 1) wanted.add(i);
  for (let i = Math.max(0, offsets.length - maxFrames); i < offsets.length; i += 1) wanted.add(i);

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
          /* ignore */
        }
      }
    } catch {
      /* ignore a bad frame */
    }
  }
  records.sort((a, b) => (a.time || 0) - (b.time || 0) || (a.seq || 0) - (b.seq || 0));
  return records;
}

function listWorkspaces(root) {
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const workspace of entries) {
    if (!workspace.isDirectory()) continue;
    const wsDir = join(root, workspace.name);
    let sessions = [];
    try {
      sessions = readdirSync(wsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const found = [];
    for (const session of sessions) {
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
        found.push({ id: session.name, file: full, mtime: st.mtimeMs });
      } catch {
        /* skip */
      }
    }
    if (!found.length) continue;
    found.sort((a, b) => b.mtime - a.mtime);
    out.push({ workspace: workspace.name, sessions: found, mtime: found[0].mtime });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function pickSession(workspaces, wantCwd) {
  const target = String(wantCwd || '').toLowerCase().replace(/[\\/]+$/, '');
  if (target) {
    for (const entry of workspaces) {
      for (const session of entry.sessions) {
        try {
          const head = decodeSession(session.file, { maxFrames: 2, headFrames: 2 });
          const sessionRecord = head.find((r) => r.type === 'session');
          const cwd =
            sessionRecord && typeof sessionRecord.cwd === 'string'
              ? sessionRecord.cwd.toLowerCase().replace(/[\\/]+$/, '')
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

const textOf = (parts) =>
  (Array.isArray(parts) ? parts : [])
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

function analyze(records) {
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
        if (text && !NOISE_RE.test(text)) {
          messages.push({ role: 'user', text, time: rec.time || 0, seq: rec.seq });
        }
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
  if (!title && userMessages.length) title = short(userMessages[0].text, 28);

  return {
    id: (session && session.id) || '',
    cwd: (session && session.cwd) || '',
    title,
    lastAt,
    turns,
    messages,
    userMessages,
    tools,
    todos,
    toolCalls: Object.values(tools).reduce((a, b) => a + b, 0),
  };
}

function suggestNext(analysis, now = Date.now()) {
  const out = [];
  const pending = (analysis.todos || []).filter((t) => t && t.status !== 'completed');

  if (pending.length) {
    out.push({
      kind: 'superpowers',
      move: 'executing-plans',
      title: `接着做完「${short(pending[0].content, 28)}」`,
      why: '未完成的 todo 是唯一明确的下一步；别开新线。',
      novelty: 'treelog 可以把这一步的推理画成节点，做完后 lint 一次看有没有缺论据。',
    });
  } else if (analysis.turns > 3) {
    out.push({
      kind: 'superpowers',
      move: 'writing-plans',
      title: '把当前方向固化成一份计划',
      why: '聊了很多轮却没有 todo，说明还在发散，没有可验收的任务。',
      novelty: '写完计划用 treelog trace 对照 spec，能立刻看出哪条决策没人接。',
    });
  }

  const idleDays = analysis.lastAt ? Math.floor((now - analysis.lastAt) / DAY_MS) : null;
  if (idleDays !== null && idleDays >= 3) {
    out.push({
      kind: 'superpowers',
      move: 'finishing-a-development-branch',
      title: `这段工作停了 ${idleDays} 天`,
      why: '要么接上最后一条，要么明确放弃——悬着的分支比失败的分支更贵。',
      novelty: 'treelog rhythm 会把断档画成一条时间轴，让“放弃”成为一个可见的决定。',
    });
  }

  if (analysis.toolCalls >= 12) {
    out.push({
      kind: 'superpowers',
      move: 'systematic-debugging',
      title: `这轮有 ${analysis.toolCalls} 次工具调用`,
      why: '调用密度这么高时，先写假设再动手，比继续试错便宜。',
      novelty: '把假设写成 assumption 节点，验证完再挂 evidence，lint 会阻止你跳步。',
    });
  }

  out.push({
    kind: 'treelog',
    move: 'treelog lint',
    title: '给这段对话留一张决策树',
    why: '把散落的选择变成带类型的节点，lint 会指出哪些结论还没有论据。',
    novelty: '这是本项目的主张：对话是过程，树才是可审计的产物。',
  });

  return out;
}

/**
 * Classify what stage of work a question belongs to, and name the superpowers
 * skill that owns that stage. This is what makes a node self-check rather than
 * just display.
 */
function stageOf(text) {
  const value = String(text || '');
  if (/报错|错误|bug|失败|调试|排查|不工作|fix|error|debug|broken/i.test(value)) {
    return {
      stage: 'debug',
      skill: 'systematic-debugging',
      why: '这段在排查问题：先写假设再验证，别直接改。',
    };
  }
  if (/测试|验证|确认|验收|test|verify|coverage/i.test(value)) {
    return {
      stage: 'verify',
      skill: 'verification-before-completion',
      why: '这段需要证据：先跑命令再下结论。',
    };
  }
  if (/审查|评审|review|看看有没有问题/i.test(value)) {
    return {
      stage: 'review',
      skill: 'requesting-code-review',
      why: '这段适合交给一个没参与的人审。',
    };
  }
  if (/计划|步骤|拆解|任务|路线|plan|roadmap/i.test(value)) {
    return {
      stage: 'plan',
      skill: 'writing-plans',
      why: '这段在拆工作：写成可验收的任务再动手。',
    };
  }
  if (/实现|写|改|重构|加一个|build|implement|refactor/i.test(value)) {
    return {
      stage: 'build',
      skill: 'executing-plans',
      why: '这段在落地：按任务逐条推进，别顺手开新线。',
    };
  }
  return {
    stage: 'design',
    skill: 'brainstorming',
    why: '这段在找方向：先把问题问清楚，再决定做什么。',
  };
}

function pulseToTree(analysis, suggestions) {
  const nodes = [];
  const now = Date.now();
  let seq = 0;

  const push = (parentId, label, text, type, note, extra) => {
    seq += 1;
    const node = {
      id: `wp${seq}`,
      parentId,
      label: short(label, 26),
      text: text || label,
      type,
      confidence: 0.8,
      branchId: 'main',
      createdAt: now + seq,
      tags: [],
      note: note || '',
      ...(extra || {}),
    };
    nodes.push(node);
    return node;
  };

  const root = push(
    null,
    analysis.title || '当前工作区',
    analysis.title || '当前工作区',
    'claim',
    `${analysis.turns} 轮对话 · ${analysis.toolCalls} 次工具调用 · ${analysis.cwd || ''}`,
  );

  const threadNode = push(
    root.id,
    '在做的事',
    '最近的提问构成主线',
    'claim',
    '按时间顺序读：每一问都是这条线的一个节点。',
  );
  analysis.userMessages.slice(-8).forEach((message, index) => {
    const stage = stageOf(message.text);
    push(
      threadNode.id,
      `${index + 1}. ${short(message.text, 20)}`,
      message.text,
      'action',
      `阶段：${stage.stage} · 推荐技能：${stage.skill}\n${stage.why}`,
      { seq: message.seq, messageText: message.text, skill: stage.skill },
    );
  });

  const toolNode = push(
    root.id,
    '怎么在做',
    '工具调用分布',
    'evidence',
    '工具分布说明这段工作的重心：edit 多=改造，read/grep 多=探查，pwsh 多=验证。',
  );
  Object.entries(analysis.tools || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .forEach(([name, count]) => {
      push(toolNode.id, `${name} × ${count}`, `${count} 次 ${name} 调用`, 'evidence', `出现 ${count} 次`);
    });

  const suggestNode = push(
    root.id,
    '下一步',
    'superpowers 建议 + 本项目视角',
    'action',
    '每条建议都附带一个可执行的 treelog 检查，避免只给口号。',
  );
  suggestions.forEach((item) => {
    push(
      suggestNode.id,
      item.title,
      item.why,
      item.kind === 'superpowers' ? 'action' : 'conclusion',
      `${item.why}\n\n创新点：${item.novelty}`,
    );
  });

  return nodes;
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function handle(req, res) {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/health') {
    return send(res, 200, { ok: true, version: VERSION });
  }

  if (url.pathname !== '/pulse') {
    return send(res, 404, { ok: false, error: 'not found' });
  }

  try {
    const workspaces = listWorkspaces(sessionsRoot());
    if (!workspaces.length) return send(res, 404, { ok: false, error: 'no sessions' });

    const cwd = url.searchParams.get('cwd') || process.cwd();
    const picked = pickSession(workspaces, cwd);
    if (!picked) return send(res, 404, { ok: false, error: 'no matching session' });

    const records = decodeSession(picked.session.file);
    const analysis = analyze(records);
    const suggestions = suggestNext(analysis);
    const tree = pulseToTree(analysis, suggestions);

    return send(res, 200, {
      ok: true,
      workspace: picked.workspace,
      sessionId: picked.session.id,
      analysis: {
        title: analysis.title,
        cwd: analysis.cwd,
        turns: analysis.turns,
        messages: analysis.messages.length,
        toolCalls: analysis.toolCalls,
        tools: analysis.tools,
        todos: analysis.todos,
        lastAt: analysis.lastAt,
      },
      suggestions,
      tree,
    });
  } catch (error) {
    return send(res, 500, { ok: false, error: String(error && error.message) });
  }
}

/** Host half entry point. */
export function apply(ctx) {
  let server = null;
  try {
    server = createServer((req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
        });
        res.end();
        return;
      }
      handle(req, res);
    });
    server.on('error', () => {
      /* port taken: the panel degrades to its offline modes */
    });
    server.listen(PORT, '127.0.0.1');
  } catch {
    server = null;
  }

  const dispose = () => {
    try {
      if (server) server.close();
    } catch {
      /* ignore */
    }
  };

  try {
    if (ctx && typeof ctx.effect === 'function') ctx.effect(() => dispose);
    else if (ctx && typeof ctx.on === 'function') ctx.on('dispose', dispose);
  } catch {
    /* the server is best-effort */
  }
}

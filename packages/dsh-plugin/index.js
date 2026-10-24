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
import { readdirSync, statSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { zstdDecompress } from 'node:zlib';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';

const zstdDecompressAsync = promisify(zstdDecompress);

// Keep in step with package.json; /health reports it, and a mismatch makes every
// bug report ambiguous about which build the user is running.
const VERSION = '0.1.0';
const PORT = Number(process.env.TTL_PORT) || 17866;
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const DAY_MS = 86400000;
export const NOISE_RE =
  /^(<system-reminder>|Time sampled while preparing|Current runtime context\.|This is an automatically generated checkpoint|\[model changed:|\[skill\])/i;

/** Whole days between two instants on the local calendar, matching the hour histogram. */
function localDayDiff(fromTs, toTs = Date.now()) {
  const from = new Date(fromTs);
  const to = new Date(toTs);
  from.setHours(0, 0, 0, 0);
  to.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / DAY_MS));
}

const short = (text, max = 40) => {
  // Code points, not UTF-16 units.
  const chars = Array.from(String(text == null ? '' : text).replace(/\s+/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
};

export function sessionsRoot() {
  return join(homedir(), '.dsh', 'sessions');
}

/**
 * Decode the tail (plus the head) of a session log without freezing the Host.
 *
 * Decompression is CPU-bound and this runs inside the dsh main process, so each
 * frame goes through the async zstd API in small batches: the event loop gets a
 * turn between batches instead of stalling for a second.
 */
export async function decodeSession(file, maxFrames = 1500, headFrames = 6) {
  const buf = await readFile(file);
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

  const order = [...wanted].sort((a, b) => a - b);
  const records = [];
  const BATCH = 24;

  for (let start = 0; start < order.length; start += BATCH) {
    const batch = order.slice(start, start + BATCH);
    const decoded = await Promise.all(
      batch.map(async (i) => {
        const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length;
        try {
          return (await zstdDecompressAsync(buf.subarray(offsets[i], end))).toString('utf8');
        } catch {
          return '';
        }
      }),
    );
    for (const text of decoded) {
      if (!text) continue;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line));
        } catch {
          /* ignore */
        }
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
  }

  records.sort((a, b) => (a.time || 0) - (b.time || 0) || (a.seq || 0) - (b.seq || 0));
  return records;
}

/** Only the first frame: the session header. Cheap enough for a directory scan. */
export async function readSessionHeader(file) {
  const handle = await open(file, 'r');
  try {
    const probe = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
    if (!bytesRead) return null;
    const slice = probe.subarray(0, bytesRead);
    const second = slice.indexOf(MAGIC, 4);
    const frame = second === -1 ? slice : slice.subarray(0, second);
    try {
      const text = (await zstdDecompressAsync(frame)).toString('utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (record.type === 'session') return record;
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  } finally {
    await handle.close();
  }
}

/** Titles are re-read on every panel open; key them by file + mtime. */
const titleCache = new Map();

export async function sessionTitle(file, mtime) {
  const key = `${file}:${mtime}`;
  const cached = titleCache.get(key);
  if (cached !== undefined) return cached;

  let title = '';
  try {
    const head = await decodeSession(file, 10, 10);
    const record = head.find((r) => r.type === 'session/title');
    if (record && record.data && record.data.title) title = record.data.title;
    if (!title) {
      const firstAsk = head.find((r) => r.type === 'user/message');
      if (firstAsk) title = short(textOf(firstAsk.data && firstAsk.data.content), 22);
    }
  } catch {
    /* ignore */
  }

  titleCache.set(key, title);
  if (titleCache.size > 400) {
    titleCache.delete(titleCache.keys().next().value);
  }
  return title;
}

export function listWorkspaces(root) {
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

export async function pickSession(workspaces, wantCwd, sessionId) {
  if (sessionId) {
    for (const entry of workspaces) {
      const found = entry.sessions.find((session) => session.id === sessionId);
      if (found) return { workspace: entry.workspace, session: found };
    }
  }

  const target = String(wantCwd || '').toLowerCase().replace(/[\\/]+$/, '');
  if (target) {
    for (const entry of workspaces) {
      for (const session of entry.sessions) {
        try {
          // The header alone is enough to match a cwd, and it is one frame.
          const header = await readSessionHeader(session.file);
          const cwd =
            header && typeof header.cwd === 'string'
              ? header.cwd.toLowerCase().replace(/[\\/]+$/, '')
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

export function analyze(records) {
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

export function suggestNext(analysis, now = Date.now()) {
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

  const idleDays = analysis.lastAt ? localDayDiff(analysis.lastAt, now) : null;
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
export function classifyStage(text) {
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

/**
 * A written review for one question: what it does well, what it leaves out, and
 * the concrete next move. Deterministic on purpose — a review that changes every
 * time you look is not a review.
 */
export function reviewOf(text, stage) {
  const value = String(text || '');
  const pros = [];
  const cons = [];
  const next = [];

  if (/\d+/.test(value)) pros.push('带了具体数字或规模，可以据此判断');
  if (/优先|取舍|权衡|tradeoff/i.test(value)) pros.push('有取舍意识，不是全都要');
  if (/因为|所以|由于|因此/.test(value)) pros.push('给了理由，不只是下结论');
  if (/不要|避免|别|除了/.test(value)) pros.push('划了边界，说明不做什么');
  if (value.length >= 40) pros.push('描述足够完整，场景能还原');
  if (!pros.length) pros.push('意图清楚，方向可辨');

  if (value.length < 20) cons.push('信息量偏少，缺上下文');
  if (!/(完成|验收|跑通|通过|看到|输出|能用)/.test(value)) {
    cons.push('没有验收标准，"做完"无法判断');
  }
  if (/同时|以及|还有|顺便/.test(value)) cons.push('塞了多个目标，容易只做一半');
  if (!/(现在|目前|已经|现状|之前)/.test(value)) cons.push('没交代现状，看不出差距');
  if (stage === 'design' && !/(方案|选项|备选|对比)/.test(value)) {
    cons.push('只要一个答案，没留备选');
  }
  if (!cons.length) cons.push('缺少明确的下一步指向');

  const nextByStage = {
    design: ['写一句“完成时能跑通什么”', '列 2-3 个备选再选'],
    plan: ['把第 1 步写成任务卡：文件 + 测试 + 验收', '标出哪一步可以并行'],
    build: ['先写一个会失败的测试', '把改动拆成 30 分钟以内的块'],
    debug: ['写一条可证伪的假设', '先复现，再动代码'],
    verify: ['列出预期输出并逐条对照', '留一条能重跑的命令'],
    review: ['指定一个没参与的人来审', '先看接口再看实现'],
  };
  next.push(...(nextByStage[stage] || nextByStage.design));
  if (cons.some((item) => item.includes('验收'))) next.push('补一行验收标准');

  // A rough structural score: does this ask contain what a good ask needs?
  let score = 50;
  if (/\d+/.test(value)) score += 10;
  if (/优先|取舍|权衡|tradeoff/i.test(value)) score += 8;
  if (/因为|所以|由于|因此/.test(value)) score += 8;
  if (/(完成|验收|跑通|通过|输出|能用|acceptance|accept|done when|verify|passes|should return|works when)/i.test(value)) score += 14;
  if (value.length >= 40) score += 8;
  if (/同时|以及|还有|顺便/.test(value)) score -= 12;
  if (!/(现在|目前|已经|现状|之前)/.test(value)) score -= 6;
  score = Math.max(10, Math.min(98, score));

  const acceptance = {
    design: '完成时能拿出 2 个备选，并说明各自的代价',
    plan: '完成时有一份可执行的任务清单，每步带验收',
    build: '完成时测试通过，且能跑通一个真实场景',
    debug: '完成时能复现→定位→修复，并留下一条回归测试',
    verify: '完成时每条预期输出都能对上',
    review: '完成时有一个没参与的人给出具体意见',
  }[stage] || '完成时能跑通一个具体场景';

  const rewrite = `「${short(value, 34)}」\n验收：${acceptance}。\n约束：只改一处，其余保持不动。`;

  return {
    pros: pros.slice(0, 3),
    cons,
    next: next.slice(0, 3),
    score,
    rewrite,
  };
}

export function pulseToTree(analysis, suggestions) {
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
    const stage = classifyStage(message.text);
    const review = reviewOf(message.text, stage.stage);
    push(
      threadNode.id,
      `${index + 1}. ${short(message.text, 20)}`,
      message.text,
      'action',
      `阶段：${stage.stage} · 推荐技能：${stage.skill}\n${stage.why}`,
      { seq: message.seq, messageText: message.text, skill: stage.skill, review },
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
    const advice = push(
      suggestNode.id,
      item.title,
      item.why,
      item.kind === 'superpowers' ? 'action' : 'conclusion',
      `${item.why}`,
      { move: item.move },
    );
    // The innovation angle becomes a virtual child you can edit or delete.
    push(
      advice.id,
      `创新：${short(item.novelty, 16)}`,
      item.novelty,
      'conclusion',
      '自动生成的创新视角。可以编辑、加批注，或直接删掉。',
      { virtual: true },
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      data += chunk;
      if (data.length > 2_000_000) {
        // Reject before destroying: `end` never fires after destroy(), which used
        // to leave this promise pending forever.
        settled = true;
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(data);
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

async function handle(req, res) {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/health') {
    return send(res, 200, { ok: true, version: VERSION });
  }

  if (url.pathname === '/deep-review') {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' });
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const text = String(body.text || '').slice(0, 4000);
      const baseUrl = String(body.baseUrl || '').replace(/\/+$/, '');
      const apiKey = String(body.apiKey || '');
      const model = String(body.model || '');
      if (!text) return send(res, 400, { ok: false, error: 'text required' });
      if (!baseUrl || !apiKey || !model) {
        return send(res, 400, { ok: false, error: 'baseUrl / apiKey / model required' });
      }

      const llm = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0.4,
          max_tokens: 700,
          messages: [
            {
              role: 'system',
              content:
                '你是严格的工程评审。输出三段，每段两行，不要客套、不要总结：\n' +
                '优点：\n- ...\n- ...\n不足：\n- ...\n- ...\n下一步：\n- ...\n- ...',
            },
            { role: 'user', content: text },
          ],
        }),
      });

      if (!llm.ok) {
        const detail = await llm.text().catch(() => '');
        return send(res, 502, { ok: false, error: `LLM ${llm.status}: ${detail.slice(0, 200)}` });
      }

      const payload = await llm.json();
      const content =
        (payload.choices && payload.choices[0] && payload.choices[0].message
          ? payload.choices[0].message.content
          : '') || '';
      return send(res, 200, { ok: true, review: content });
    } catch (error) {
      return send(res, 500, { ok: false, error: String(error && error.message) });
    }
  }

  if (url.pathname === '/sessions') {
    try {
      const workspaces = listWorkspaces(sessionsRoot());
      const payload = [];
      for (const entry of workspaces.slice(0, 12)) {
        let cwd = '';
        try {
          const header = await readSessionHeader(entry.sessions[0].file);
          cwd = (header && header.cwd) || '';
        } catch {
          /* ignore */
        }
        const sessions = [];
        for (const session of entry.sessions.slice(0, 20)) {
          sessions.push({
            id: session.id,
            title: await sessionTitle(session.file, session.mtime),
            mtime: session.mtime,
          });
        }
        payload.push({ workspace: entry.workspace, cwd, sessions });
      }
      return send(res, 200, { ok: true, workspaces: payload });
    } catch (error) {
      return send(res, 500, { ok: false, error: String(error && error.message) });
    }
  }

  if (url.pathname !== '/pulse') {
    return send(res, 404, { ok: false, error: 'not found' });
  }

  try {
    const workspaces = listWorkspaces(sessionsRoot());
    if (!workspaces.length) return send(res, 404, { ok: false, error: 'no sessions' });

    const cwd = url.searchParams.get('cwd') || process.cwd();
    const sessionId = url.searchParams.get('session') || '';
    const picked = await pickSession(workspaces, cwd, sessionId || undefined);
    if (!picked) return send(res, 404, { ok: false, error: 'no matching session' });

    const records = await decodeSession(picked.session.file);
    const analysis = analyze(records);
    const suggestions = suggestNext(analysis);
    const tree = pulseToTree(analysis, suggestions);

    const hours = new Array(24).fill(0);
    for (const message of analysis.userMessages) {
      if (message.time) hours[new Date(message.time).getHours()] += 1;
    }
    const scores = tree
      .filter((node) => node.review && typeof node.review.score === 'number')
      .map((node) => node.review.score);
    const averageScore = scores.length
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : 0;

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
      hourHistogram: hours,
      averageScore,
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
      handle(req, res).catch((error) => {
        try {
          send(res, 500, { ok: false, error: String(error && error.message) });
        } catch {
          /* response already sent */
        }
      });
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

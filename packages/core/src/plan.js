/**
 * @thinking-treelog/core/plan
 *
 * Parser and linter for structured implementation plans — the shape produced by
 * the superpowers `writing-plans` skill, but generic enough for any plan that
 * declares tasks, ordered steps, files, and Consumes/Produces interfaces.
 *
 * The valuable part is the interface graph: a plan states which symbols each
 * task consumes and produces, but nothing checks that graph. These rules do.
 */

export const PLAN_RULES = {
  'undefined-consume': {
    severity: 'error',
    description: 'A task consumes a symbol no task produces',
  },
  'signature-mismatch': {
    severity: 'error',
    description: 'The same symbol is declared with two different signatures',
  },
  'task-without-verification': {
    severity: 'warning',
    description: 'A task has no runnable verification step',
  },
  'task-without-files': {
    severity: 'warning',
    description: 'A task lists no files to create or modify',
  },
  'review-focus-empty': {
    severity: 'warning',
    description: 'No review focus recorded for a multi-task plan',
  },
  'code-block-heavy': {
    severity: 'info',
    description: 'Code blocks dominate the plan — write signatures, not bodies',
  },
  'unused-produce': {
    severity: 'info',
    description: 'A task produces a symbol nothing consumes',
    defaultOff: true,
  },
};

const TASK_RE = /^###\s+Task\s+(\d+)\s*[:：]\s*(.+?)\s*$/i;
const STEP_RE = /^\s*-\s*\[([ xX])\]\s*(?:\*\*)?Step\s+(\d+)\s*[:：]?\s*(?:\*\*)?\s*(.*)$/;
const FIELD_RE = /^\s*\*\*([A-Za-z][A-Za-z ]*?)\s*[:：]?\*\*\s*[:：]?\s*(.*)$/;
const LIST_ITEM_RE = /^\s*[-*]\s+(.+)$/;

/**
 * @typedef {Object} PlanInterface
 * @property {string} symbol
 * @property {string} signature
 * @property {number|null} fromTask
 */

/**
 * @typedef {Object} PlanStep
 * @property {number} index
 * @property {string} text
 * @property {boolean} done
 * @property {number} line
 */

/**
 * @typedef {Object} PlanTask
 * @property {number} id
 * @property {string} title
 * @property {number} line
 * @property {{create: string[], modify: string[], test: string[]}} files
 * @property {PlanInterface[]} consumes
 * @property {PlanInterface[]} produces
 * @property {PlanStep[]} steps
 */

/**
 * @typedef {Object} ParsedPlan
 * @property {string} title
 * @property {string} goal
 * @property {string} architecture
 * @property {string} techStack
 * @property {string} spec
 * @property {string[]} constraints
 * @property {string[]} reviewFocus
 * @property {PlanTask[]} tasks
 */

const EXTERNAL_HINTS = /^(node:|fs$|path$|os$|url$|http|https|react$|vue$|express|jest|vitest|pytest|npm|git$)/i;

/**
 * Pull a symbol name and signature out of an interface line.
 * Accepts `` `foo(a: string): number` from Task 2 `` or `` foo from Task 2 ``.
 *
 * @param {string} text
 * @returns {PlanInterface}
 */
export function parseInterface(text) {
  const raw = String(text).trim();
  const code = raw.match(/`([^`]+)`/);
  const body = (code ? code[1] : raw).trim();
  const nameMatch = body.match(/^([A-Za-z_$][\w$]*)/);
  const fromMatch = raw.match(/from\s+Task\s+(\d+)/i);
  return {
    symbol: nameMatch ? nameMatch[1] : body.split(/[\s(]/)[0] || body,
    signature: body,
    fromTask: fromMatch ? Number(fromMatch[1]) : null,
  };
}

function normalizeSignature(signature) {
  return String(signature).replace(/\s+/g, '').toLowerCase();
}

/**
 * @param {string} markdown
 * @returns {ParsedPlan}
 */
export function parsePlan(markdown) {
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');

  /** @type {ParsedPlan} */
  const plan = {
    title: '',
    goal: '',
    architecture: '',
    techStack: '',
    spec: '',
    constraints: [],
    reviewFocus: [],
    tasks: [],
    totalLines: lines.length,
    fenceLines: 0,
  };

  /** @type {PlanTask|null} */
  let task = null;
  /** 'files' | 'consumes' | 'produces' | null */
  let section = null;
  /** 'constraints' | 'review' | null */
  let listSection = null;
  let inFence = false;

  const pushTask = () => {
    if (task) plan.tasks.push(task);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineNo = i + 1;

    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      plan.fenceLines += 1;
      continue;
    }
    if (inFence) {
      plan.fenceLines += 1;
      continue;
    }

    if (!plan.title) {
      const h1 = line.match(/^#\s+(.+?)\s*$/);
      if (h1) {
        plan.title = h1[1];
        continue;
      }
    }

    const taskMatch = line.match(TASK_RE);
    if (taskMatch) {
      pushTask();
      task = {
        id: Number(taskMatch[1]),
        title: taskMatch[2].trim(),
        line: lineNo,
        files: { create: [], modify: [], test: [] },
        consumes: [],
        produces: [],
        steps: [],
      };
      section = null;
      listSection = null;
      continue;
    }

    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      section = null;
      listSection = /constraint/i.test(heading[1])
        ? 'constraints'
        : /review\s*focus/i.test(heading[1])
          ? 'reviewFocus'
          : null;
      continue;
    }

    if (task) {
      const stepMatch = line.match(STEP_RE);
      if (stepMatch) {
        task.steps.push({
          index: Number(stepMatch[2]),
          // Strip the closing bold marker: "**Step 1: Do it**" -> "Do it"
          text: stepMatch[3].replace(/\*+\s*$/, '').trim(),
          done: stepMatch[1].toLowerCase() === 'x',
          line: lineNo,
        });
        section = null;
        continue;
      }

      const field = line.match(FIELD_RE);
      if (field) {
        const name = field[1].trim().toLowerCase();
        const value = field[2].trim();
        if (name === 'files') section = 'files';
        else if (name === 'interfaces') section = null;
        else section = null;
        void value;
        continue;
      }

      if (/^\s*-\s*(Create|Modify|Test)\s*[:：]/i.test(line)) {
        const kind = line.match(/^\s*-\s*(Create|Modify|Test)\s*[:：]\s*(.+)$/i);
        if (kind) {
          const bucket = kind[1].toLowerCase();
          const value = kind[2].trim().replace(/`/g, '');
          if (bucket === 'create') task.files.create.push(value);
          else if (bucket === 'modify') task.files.modify.push(value);
          else task.files.test.push(value);
        }
        continue;
      }

      const iface = line.match(/^\s*-\s*(Consumes|Produces)\s*[:：]\s*(.+)$/i);
      if (iface) {
        const parsed = parseInterface(iface[2]);
        if (/consumes/i.test(iface[1])) task.consumes.push(parsed);
        else task.produces.push(parsed);
        continue;
      }
      // Continuation lines inside an interface list keep their indentation.
      if (section && LIST_ITEM_RE.test(line)) continue;
    }

    const item = line.match(LIST_ITEM_RE);
    if (item && listSection) {
      plan[listSection].push(item[1].trim());
      continue;
    }

    const headerField = line.match(/^\*\*(Goal|Architecture|Tech Stack|Spec)\s*[:：]?\*\*\s*[:：]?\s*(.*)$/i);
    if (headerField) {
      const key = headerField[1].toLowerCase().replace(/\s+/g, '');
      const value = headerField[2].trim();
      if (key === 'goal') plan.goal = value;
      else if (key === 'architecture') plan.architecture = value;
      else if (key === 'techstack') plan.techStack = value;
      else if (key === 'spec') plan.spec = value;
      continue;
    }
  }

  pushTask();
  return plan;
}

/**
 * @typedef {Object} PlanFinding
 * @property {string} rule
 * @property {'error'|'warning'|'info'} severity
 * @property {string} message
 * @property {string} [hint]
 * @property {number|null} taskId
 * @property {string} [nodeLabel]
 * @property {number} [line]
 */

const isVerificationStep = (text) =>
  /(^|\b)(run|execute|运行)\b|expected\s*:|verify it (passes|fails)|should (pass|fail)/i.test(text);

/**
 * Lint a parsed plan.
 *
 * @param {ParsedPlan} plan
 * @param {{ locale?: 'en'|'zh', rules?: Record<string, boolean|string> }} [options]
 * @returns {PlanFinding[]}
 */
export function lintPlan(plan, options = {}) {
  const locale = options.locale === 'zh' ? 'zh' : 'en';
  const overrides = options.rules ?? {};
  /** @type {PlanFinding[]} */
  const findings = [];

  const msg = {
    en: {
      'undefined-consume': (v) => `Task ${v.task} consumes "${v.symbol}" but no task produces it`,
      'signature-mismatch': (v) =>
        `"${v.symbol}" is declared as "${v.expected}" but consumed as "${v.actual}"`,
      'task-without-verification': (v) => `Task ${v.task} "${v.title}" has no runnable verification step`,
      'task-without-files': (v) => `Task ${v.task} "${v.title}" lists no files`,
      'review-focus-empty': () => `Multi-task plan has an empty Review Focus section`,
      'unused-produce': (v) => `Task ${v.task} produces "${v.symbol}" but nothing consumes it`,
      'code-block-heavy': (v) =>
        `Code blocks are ${v.percent}% of the plan — write signatures, not bodies`,
    },
    zh: {
      'undefined-consume': (v) => `Task ${v.task} 消费了「${v.symbol}」，但没有任何 Task 生产它`,
      'signature-mismatch': (v) => `「${v.symbol}」声明为「${v.expected}」，却被当作「${v.actual}」使用`,
      'task-without-verification': (v) => `Task ${v.task}「${v.title}」没有可执行的验证步骤`,
      'task-without-files': (v) => `Task ${v.task}「${v.title}」没有列出文件`,
      'review-focus-empty': () => `多任务计划缺少 Review Focus 段`,
      'unused-produce': (v) => `Task ${v.task} 生产了「${v.symbol}」，但没人消费`,
      'code-block-heavy': (v) => `代码块占计划的 ${v.percent}% —— 写签名，不要写实现`,
    },
  }[locale];

  const hints = {
    en: {
      'undefined-consume': 'Either add a Produces line to the owning task, or fix the Consumes name',
      'signature-mismatch': 'Make both sides use the same signature',
      'task-without-verification': 'Add a step with a command and expected output',
      'task-without-files': 'List the files this task creates or modifies',
      'review-focus-empty': 'Name the inputs or failure modes the spec leaves untested',
      'unused-produce': 'Remove it, or mark it as public API',
      'code-block-heavy': 'Replace bodies with signatures, test names and assertions',
    },
    zh: {
      'undefined-consume': '要么在对应 Task 补上 Produces，要么改掉 Consumes 的名字',
      'signature-mismatch': '让两边使用同一个签名',
      'task-without-verification': '补一个带命令和预期输出的步骤',
      'task-without-files': '列出这个 Task 创建或修改的文件',
      'review-focus-empty': '写出 spec 没有覆盖的输入或失败模式',
      'unused-produce': '删掉它，或者标注为公共 API',
      'code-block-heavy': '把实现体换成签名、测试名和断言',
    },
  }[locale];

  const add = (rule, taskId, vars = {}, line) => {
    const override = overrides[rule];
    if (override === false || override === 'off') return;
    const meta = PLAN_RULES[rule];
    if (meta?.defaultOff && override !== true && override === undefined) return;
    const severity =
      override === 'error' || override === 'warning' || override === 'info'
        ? override
        : meta?.severity ?? 'warning';
    findings.push({
      rule,
      severity,
      message: msg[rule](vars),
      hint: hints[rule],
      taskId: taskId ?? null,
      nodeLabel: taskId ? `Task ${taskId}` : '',
      ...(Number.isFinite(line) ? { line } : {}),
    });
  };

  // Index producers.
  /** @type {Map<string, {taskId: number, signature: string}[]>} */
  const producers = new Map();
  for (const task of plan.tasks) {
    for (const iface of task.produces) {
      if (!producers.has(iface.symbol)) producers.set(iface.symbol, []);
      producers.get(iface.symbol).push({ taskId: task.id, signature: iface.signature });
    }
  }

  const consumed = new Set();

  for (const task of plan.tasks) {
    for (const iface of task.consumes) {
      consumed.add(iface.symbol);
      const makers = producers.get(iface.symbol);

      if (!makers || makers.length === 0) {
        if (iface.fromTask !== null || !EXTERNAL_HINTS.test(iface.symbol)) {
          add('undefined-consume', task.id, { task: task.id, symbol: iface.symbol }, task.line);
        }
        continue;
      }

      if (iface.fromTask !== null && !makers.some((m) => m.taskId === iface.fromTask)) {
        add('undefined-consume', task.id, { task: task.id, symbol: iface.symbol }, task.line);
        continue;
      }

      const expected = makers[0].signature;
      if (normalizeSignature(expected) !== normalizeSignature(iface.signature)) {
        add(
          'signature-mismatch',
          task.id,
          { symbol: iface.symbol, expected, actual: iface.signature },
          task.line,
        );
      }
    }

    // Two producers of the same symbol with different signatures is also a bug.
    const seen = new Map();
    for (const iface of task.produces) {
      const previous = seen.get(iface.symbol);
      if (previous && normalizeSignature(previous) !== normalizeSignature(iface.signature)) {
        add(
          'signature-mismatch',
          task.id,
          { symbol: iface.symbol, expected: previous, actual: iface.signature },
          task.line,
        );
      }
      seen.set(iface.symbol, iface.signature);
    }

    const hasVerification = task.steps.some((step) => isVerificationStep(step.text));
    if (!hasVerification) {
      add('task-without-verification', task.id, { task: task.id, title: task.title }, task.line);
    }

    const fileCount = task.files.create.length + task.files.modify.length + task.files.test.length;
    if (fileCount === 0) {
      add('task-without-files', task.id, { task: task.id, title: task.title }, task.line);
    }
  }

  for (const [symbol, makers] of producers) {
    if (consumed.has(symbol)) continue;
    for (const maker of makers) {
      add('unused-produce', maker.taskId, { task: maker.taskId, symbol }, undefined);
    }
  }

  if (plan.tasks.length > 1 && plan.reviewFocus.length === 0) {
    add('review-focus-empty', null, {});
  }

  // A plan that is mostly code has written the program instead of describing it.
  if (plan.totalLines > 0) {
    const percent = Math.round((plan.fenceLines / plan.totalLines) * 100);
    if (percent > 50) add('code-block-heavy', null, { percent });
  }

  return findings;
}

/**
 * Turn a plan into thought-tree nodes so it can be rendered by the same canvas.
 *
 * @param {ParsedPlan} plan
 * @returns {import('./index.js').ThoughtNode[]}
 */
export function planToTree(plan) {
  /** @type {import('./index.js').ThoughtNode[]} */
  const nodes = [];
  const now = Date.now();
  let seq = 0;

  const push = (parentId, label, text, type, extra = {}) => {
    seq += 1;
    const node = {
      id: `p${seq}`,
      parentId,
      label,
      text,
      type,
      confidence: 0.8,
      branchId: 'main',
      createdAt: now + seq,
      tags: [],
      ...extra,
    };
    nodes.push(node);
    return node;
  };

  const root = push(null, plan.title || 'Implementation plan', plan.goal || plan.title, 'claim', {
    isSection: true,
  });

  for (const task of plan.tasks) {
    const taskNode = push(
      root.id,
      `Task ${task.id}: ${task.title}`,
      task.title,
      'action',
      { isSection: true, line: task.line },
    );
    for (const step of task.steps) {
      push(
        taskNode.id,
        step.text || `Step ${step.index}`,
        step.text,
        isVerificationStep(step.text) ? 'evidence' : 'action',
        { line: step.line },
      );
    }
  }

  return nodes;
}

/**
 * A recorded session used by `treelog pulse --demo`.
 *
 * It is a real transcript shape (the same record types the dsh session log
 * stores), so the demo runs through the exact pipeline as a live read — the only
 * difference is where the records come from.
 *
 * The questions are deliberately uneven: some state a measurement and an
 * acceptance line, some are vague. That is what makes the review meaningful.
 */

const MINUTE = 60_000;
const BASE = Date.UTC(2026, 9, 22, 9, 0, 0);

/** @param {number} minute */
const at = (minute) => BASE + minute * MINUTE;

/**
 * @param {string} text
 * @param {number} minute
 * @param {number} seq
 */
const ask = (text, minute, seq) => ({
  type: 'user/message',
  seq,
  time: at(minute),
  data: { content: [{ type: 'text', text }] },
});

/**
 * @param {string} name
 * @param {number} minute
 * @param {number} seq
 */
const tool = (name, minute, seq) => ({ type: 'tool/call', seq, time: at(minute), data: { name } });

export const DEMO_RECORDS = [
  {
    type: 'session',
    version: 4,
    id: 'session-demo-checkout',
    createdAt: at(0),
    cwd: '/demo/checkout-service',
  },
  { type: 'session/title', seq: 1, time: at(1), data: { title: '给结算服务加一次重试' } },

  ask(
    '支付回调偶尔丢，我想加重试。先看看现在是怎么处理的，别改任何东西。',
    2,
    2,
  ),
  tool('read', 3, 3),
  tool('grep', 3, 4),
  {
    type: 'assistant/message',
    seq: 5,
    time: at(5),
    data: {
      message: {
        content: [
          {
            type: 'text',
            text:
              '回调落在 `POST /payments/callback`，没有重试，异常直接吞掉。' +
              '丢失发生在 handler 抛错时，日志里只有一行 warn。',
          },
        ],
      },
    },
  },

  ask(
    'QPS 200 时丢 0.3%，想 5 秒内重试 3 次。不要动下游幂等，验收：压测 1000 次零丢失。',
    7,
    6,
  ),
  tool('read', 8, 7),
  tool('edit', 12, 8),
  tool('edit', 14, 9),
  {
    type: 'todo/write',
    seq: 10,
    time: at(15),
    data: {
      todos: [
        { content: '给回调加退避重试', status: 'completed' },
        { content: '压测 1000 次验证零丢失', status: 'in_progress' },
        { content: '补一条回归测试', status: 'pending' },
      ],
    },
  },

  ask('这个再优化一下', 18, 11),
  tool('edit', 19, 12),
  tool('edit', 21, 13),
  tool('pwsh', 24, 14),
  {
    type: 'assistant/message',
    seq: 15,
    time: at(26),
    data: {
      message: {
        content: [
          {
            type: 'text',
            text: '改完了：退避 200ms / 600ms / 1.8s，失败进死信队列。压测脚本还没跑。',
          },
        ],
      },
    },
  },

  ask(
    '跑一下压测，把 1000 次的失败数和 p99 都打出来。不通过就回滚。',
    28,
    16,
  ),
  tool('pwsh', 29, 17),
  tool('pwsh', 33, 18),
  {
    type: 'assistant/message',
    seq: 19,
    time: at(35),
    data: {
      message: {
        content: [
          {
            type: 'text',
            text: '1000 次里 0 次丢失，p99 从 480ms 升到 510ms。重试生效，延迟增幅 6%。',
          },
        ],
      },
    },
  },

  ask('顺手把死信队列也接了吧，还有监控面板、告警规则，一并加上', 38, 20),
  tool('edit', 40, 21),
  tool('edit', 44, 22),
  tool('pwsh', 47, 23),
  {
    type: 'assistant/message',
    seq: 24,
    time: at(49),
    data: {
      message: {
        content: [{ type: 'text', text: '死信队列接好了，监控和告警还没做。' }],
      },
    },
  },

  ask('先停。把已经做的写进 README，剩下的列成后续任务。', 52, 25),
];

/** One line describing what the demo is meant to demonstrate. */
export const DEMO_HINT =
  '示例会话：一段真实的结算服务改造记录，包含清晰提问与含糊提问各一半。';

# 上线推广材料

Star 不是"提交到某个市场"换来的。GitHub 没有这样的入口。Star 来自**有人看见、
试了、觉得有用**。这份文件是让前两步发生的材料。

按"转化率 ÷ 成本"排序，先做能做的。

---

## 已经做完的（仓库侧）

- 首屏有图，而且图是 `render-demo.py` 从真实输出生成的，不会和工具对不上
- About 描述一行说得清是什么
- 18 个 topics：`thought-tree` `reasoning` `mcp` `llm` `prompt-engineering`
  `session-analysis` `weekly-report` `sarif` `decision-record` `dsh` …
- 三枚 npm 徽章 + CI 徽章，`npx` 命令真的能跑
- Discussions 已开启
- 两个 Release，CHANGELOG 写清了每个修复的原因

**GitHub 搜索靠 topics 和 description**，这两项已经到位。剩下的是把人带过来。

---

## 一、手动上传 social preview（2 分钟，效果最直接）

GitHub 不能通过 API 设置社交预览图，只能网页操作：

1. 打开 https://github.com/Xocean996/thinking-treelog/settings
2. 找到 **Social preview** → Upload an image
3. 选 `docs/social-preview.png`（1280×640，已生成）

**为什么值得做**：任何人在 Twitter / 微信 / Slack / Discord 里贴这个链接，都会展开
一张卡片。没有图就只有一个灰底文字块，点击率差一个量级。

---

## 二、提交到 awesome list（长期流量，一次性成本）

这些列表被大量订阅，是 MCP/CLI 类项目的主要冷启动来源。每个都需要一个 PR。

| 列表 | 提交位置 | 说明 |
|---|---|---|
| [awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) | README 的 Servers 章节 | 改动最小、命中率最高，因为你有 11 个 MCP 工具 |
| [awesome-ai-devtools](https://github.com/microsoft/awesome-ai-devtools) | Tools 章节 | 编辑器/CLI 类 AI 工具 |
| [awesome-cli-apps](https://github.com/agarrharr/awesome-cli-apps) | Development 章节 | 纯 CLI 工具 |
| [awesome-nodejs](https://github.com/sindresorhus/awesome-nodejs) | Packages 章节 | 门槛较高，star 数够再试 |

**PR 格式（照这个写，别自夸）**：

```markdown
- [thinking-treelog](https://github.com/Xocean996/thinking-treelog) - Reads the
  reasoning out of an AI session: typed thought trees, reasoning-gap lint, question
  scoring, and a weekly report generated from git history.
```

一句话、说清是什么、不吹。

---

## 三、发布帖（一次性，决定第一个 24 小时）

### Hacker News（英文，Show HN）

标题（必须朴素，HN 反感营销腔）：

```
Show HN: Read the reasoning out of an AI coding session
```

正文：

```
I kept losing the reasoning of long AI sessions. The code survives; the decision,
the abandoned branch and the badly-phrased question that cost twenty minutes do not.

This reads the session log you already have (dsh today; plain text or markdown via
--file) and prints: the thread of questions, a score per question with what it left
out and a rewrite, the tool mix, unfinished todos, and one next step.

Two parts I have not seen elsewhere:

- reasoning-gap lint on the resulting tree: a conclusion with no evidence child, an
  assumption never verified, a rejected option that still has children
- a weekly report from git, where "changed source without touching tests" is a
  first-class finding rather than something you notice in review

No API key, no server, everything offline. Node 22.15+ for the session reader,
Node 18+ for the rest.

  npx -y @thinking-treelog/cli pulse --demo

Repo: https://github.com/Xocean996/thinking-treelog

I am unsure whether question scoring is useful or just novel — it is the part I
would most like criticised.
```

最后那句很重要：**主动请求批评**比请求 star 有效得多，HN 上真诚的自我怀疑会换来真正的讨论。

### Reddit

- r/commandline —— 只发 CLI 部分，别贴 AI 标签
- r/LocalLLaMA —— 强调离线、无需 API key
- r/ExperiencedDevs —— 讲"周报"这个具体痛点，不要讲技术

标题示例：

```
I got tired of reconstructing my week from memory, so treelog weekly reads it from git
```

### 中文（掘金 / 知乎 / V2EX）

标题走"痛点+具体产出"，不写"重磅开源"：

```
我把 AI 对话的推理过程做成了可以回溯的树，还顺手解决了周报
```

开头直接上图和命令，不要铺垫。

V2EX 的 `/go/create` 节点对开源项目比较友好，但**标题必须诚实**，V2EX 对标题党
反应很差。

---

## 四、等真实用户，再写"对比"

现在的 README 有 `How it differs` 章节，但那是**我推的**，不是**别人问的**。

真正能带来 star 的是：有人在 issue 里问"这和 X 有什么区别"，你把回答写回去。
那说明有人真的在比较，也说明项目进入了候选名单。

---

## 五、不要做的事

- **不要买 star、不要互 star 群**。GitHub 会识别，且会毁掉项目的可信度。
- **不要在没有用户时写"被 XXX 使用"**。
- **不要天天发**。同一个渠道两周内只发一次，否则被当 spam。
- **不要隐藏未完成的部分**。`dsh-plugin` 的双击问题我在 README 里写明了——
  一个承认缺口的项目比一个完美的宣传页更值得 star。

---

## 现实预期

一个没有社交账号、没有既有受众的仓库，第一个月通常是 **10–50 star**，除非在 HN
或 Reddit 上进了首页。

真正的分水岭是：**有没有人用它并提 issue**。一个来自陌生人的 issue，价值高于
一百个 star。

所以优先级是：

1. social preview（10 分钟，影响每一次分享）
2. awesome-mcp-servers 的 PR（一次，长期）
3. 一次 HN / Reddit 发布（一天，决定爆发）
4. 等反馈，修，再发

前三步我可以帮你写好全部文案，但**提交动作需要你的账号**——PR 要用你的
GitHub 身份，HN 和 Reddit 要你的账号，否则会被当成营销机器人。

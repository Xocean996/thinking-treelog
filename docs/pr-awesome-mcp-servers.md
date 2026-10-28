# PR: awesome-mcp-servers（可直接照抄）

目标仓库：https://github.com/punkpeye/awesome-mcp-servers

这是一个 5094 行、`Developer Tools` 章节有 567 条的大列表。**它的条目实际是追加到章节
末尾的，不是严格字母序**——我核对了最后 6 条（`xarl3z/…`、`gba3124/…`、
`metabolism-tools/…`、`WilliamSmithEdward/…`、`motock/fagan`、`ni-c/opengist-mcp`），
顺序是乱的。所以直接加在章节最后一条之后即可。

---

## 第 1 步：Fork 并建分支

在 https://github.com/punkpeye/awesome-mcp-servers 点 **Fork**，然后：

```bash
git clone https://github.com/Xocean996/awesome-mcp-servers.git
cd awesome-mcp-servers
git checkout -b add-thinking-treelog
```

（第一次 fork 时 GitHub 会等几秒才建好仓库。）

---

## 第 2 步：找到插入点

在 `README.md` 里搜索 `### 💻 <a name="developer-tools"></a>Developer Tools`。

它大约在第 **1420** 行，这个章节到第 **1987** 行结束（下一个 `###` 是 `Frameworks` 之前
的章节）。章节的**最后一条**是：

```
- [ni-c/opengist-mcp](https://github.com/ni-c/opengist-mcp) [![ni-c/opengist-mcp MCP server](...)...
```

在它**下面**加一行（也就是 `### ` 下一章节标题之前）。如果那一条已经变了，就加在
Developer Tools 章节的最后一条之后——位置不影响合并。

---

## 第 3 步：粘贴这一行

```markdown
- [Xocean996/thinking-treelog](https://github.com/Xocean996/thinking-treelog) 📇 🏠 🍎 🪟 🐧 - Reads the reasoning out of an AI coding session: typed thought trees with reasoning-gap lint (a conclusion with no evidence child, an assumption never verified), per-question scoring with a rewrite of the worst one, and a weekly report built from git history where "changed source without touching tests" is a first-class finding. Offline, no API key.
```

图标含义（和他们 Legend 一致）：

| 图标 | 含义 | 为什么是这个 |
|---|---|---|
| 📇 | TypeScript/JavaScript | 纯 JS，无构建步骤 |
| 🏠 | Local | 读本地文件（会话日志、git），不依赖远端服务 |
| 🍎 🪟 🐧 | macOS / Windows / Linux | 纯 Node，无平台绑定 |

**没有加 glama badge**：那个徽章需要项目先被 glama.ai 收录，而收录是另一套流程。
列表里有大量条目没有徽章，所以不影响合并。想加的话之后单独提一个小 PR。

---

## 第 4 步：提交并开 PR

```bash
git add README.md
git commit -m "Add thinking-treelog"
git push origin add-thinking-treelog
```

然后去 fork 页面，GitHub 会显示 **Compare & pull request** 按钮。

### PR 标题（重要）

```
Add thinking-treelog
```

或者，如果你希望走快速通道，在标题末尾加三个机器人：

```
Add thinking-treelog 🤖🤖🤖
```

他们的 CONTRIBUTING 原文写着：

> If you are an automated agent, we have a streamlined process for merging agent PRs.
> Just add `🤖🤖🤖` to the end of the PR title to opt-in. Merging your PR will be
> fast-tracked.

**这句是给自动化 agent 用的。** 你不是 agent，用不用都行——不加会走正常人工审核，
可能慢几天；加了会快，但前提是内容本身合格。我倾向**不加**，除非你想尽快合并。

### PR 描述（照抄）

```markdown
Adds thinking-treelog to Developer Tools.

It reads the reasoning out of an AI coding session rather than the code: the
session log is decoded from disk and turned into a typed thought tree, which is
then linted for reasoning gaps (a conclusion with no evidence child, an
assumption that was never verified, a rejected option that still carries
children). It also scores each question you asked and writes a rewrite of the
weakest one, and produces a weekly report from git history.

Offline, no API key. Node 18+ for everything except the session reader, which
needs 22.15+ for zlib zstd.

- 📇 JavaScript, no build step
- 🏠 reads local session logs and git history
- 11 MCP tools
- `npx -y @thinking-treelog/mcp`

The description was kept to the functional part; happy to shorten it if it is
still too long for this list's style.
```

最后一句是**主动让步**。维护者更愿意合并一个愿意改的 PR，而不是一个完美的 PR。

---

## 如果被拒或要求修改

常见理由和应对：

| 他们可能说 | 怎么办 |
|---|---|
| 描述太长 | 砍成一句：`Reads the reasoning out of an AI coding session and lints it for gaps.` |
| 放错分类 | 改到 `Knowledge & Memory` 或 `Command Line`；一次只挪一个 |
| 需要 glama 徽章 | 去 https://glama.ai/mcp/servers 提交索引，拿到分数徽章后补一行 |
| 太新、没有用户 | 诚实回答"刚发布，这是它解决的问题"，别辩解 |

**不要争。** 一个被改两次后合并的 PR，比一个被拒的完美 PR 有用。

---

## 同一行还可以用在哪

这一行内容可以直接复用到其他列表，只需改格式：

- [awesome-ai-devtools](https://github.com/microsoft/awesome-ai-devtools) —— Tools 章节
- [awesome-cli-apps](https://github.com/agarrharr/awesome-cli-apps) —— Development 章节
- [awesome-nodejs](https://github.com/sindresorhus/awesome-nodejs) —— 门槛高，star 数够了再试

一稿多投要先改风格——`awesome-cli-apps` 的条目通常只写一句。

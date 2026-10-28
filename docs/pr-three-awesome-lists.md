# 三个 awesome list 的 PR（可直接照抄）

我把这三个 README 都下载下来读了实际格式，没有凭记忆写。

| 列表 | 章节 | 格式 | 建议 |
|---|---|---|---|
| [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) | Developer Tools | `- [owner/repo](url) 📇 🏠 🍎 🪟 🐧 - Desc` | ✅ 最优先 |
| [jamesmurdza/awesome-ai-devtools](https://github.com/jamesmurdza/awesome-ai-devtools) | CLI Utilities | `- [产品名](url) — Desc` | ✅ 次优先 |
| [agarrharr/awesome-cli-apps](https://github.com/agarrharr/awesome-cli-apps) | AI → Agents | `- [名字](url) - Desc.` | ⚠️ 可以，但描述要极短 |
| ~~bradAGI/awesome-cli-coding-agents~~ | — | 带 ⭐ 数 | ❌ 不建议 |

**修正**：我之前在 `docs/launch.md` 里写的 `microsoft/awesome-ai-devtools` 是错的，
那个仓库不存在（404）。正确的是 `jamesmurdza/awesome-ai-devtools`。

---

## 一、awesome-mcp-servers（最优先）

完整步骤见 [pr-awesome-mcp-servers.md](pr-awesome-mcp-servers.md)。要点：

- 章节 `### 💻 <a name="developer-tools"></a>Developer Tools`，约第 1420 行
- 567 条，**实际是追加在末尾，不是字母序**
- 条目：

```markdown
- [Xocean996/thinking-treelog](https://github.com/Xocean996/thinking-treelog) 📇 🏠 🍎 🪟 🐧 - Reads the reasoning out of an AI coding session: typed thought trees with reasoning-gap lint (a conclusion with no evidence child, an assumption never verified), per-question scoring with a rewrite of the worst one, and a weekly report built from git history where "changed source without touching tests" is a first-class finding. Offline, no API key.
```

---

## 二、awesome-ai-devtools

仓库：https://github.com/jamesmurdza/awesome-ai-devtools（443 行）

### 条目的实际写法

它用**产品名**，不是 `owner/repo`，破折号是 em dash `—`：

```
- [gptcomet](https://github.com/belingud/gptcomet) — CLI tool to help you generate commit message and review changes. Supports multiple providers and ...
- [Baz CLI](https://github.com/baz-scm/baz-cli) - CLI for AI assisted code review, with access to the actual code, diff etc.
- [Butterfish](https://butterfi.sh) — CLI tool that embeds ChatGPT in your shell for easy access. Includes simple agentic capabilities.
```

（`—` 和 `-` 两种都有，用 `—` 更常见。）

### 要粘贴的条目

放在 `### CLI Utilities` 章节（在 `## Terminal` 下），追加到该章节末尾：

```markdown
- [Thinking TreeLog](https://github.com/Xocean996/thinking-treelog) — CLI that reads the reasoning out of an AI coding session: typed thought trees with reasoning-gap lint, per-question scoring with a rewrite, and a weekly report generated from git history. Offline, no API key.
```

### PR

```bash
git clone https://github.com/Xocean996/awesome-ai-devtools.git
cd awesome-ai-devtools
git checkout -b add-thinking-treelog
# 编辑 README.md，在 ### CLI Utilities 末尾加一行
git add README.md
git commit -m "Add Thinking TreeLog to CLI Utilities"
git push origin add-thinking-treelog
```

PR 标题：`Add Thinking TreeLog to CLI Utilities`

PR 描述：

```markdown
Adds Thinking TreeLog to CLI Utilities.

A CLI that reads the reasoning out of an AI coding session rather than the code:
it decodes the session log, builds a typed thought tree, lints it for reasoning
gaps, scores each question and rewrites the weakest one, and generates a weekly
report from git history. Offline, no API key.

I put it under CLI Utilities rather than Terminal Agents because it analyses a
session after the fact instead of driving one — happy to move it if you disagree.
```

最后一句主动认错位置，维护者通常愿意合并这类 PR。

---

## 三、awesome-cli-apps（可以，但描述必须短）

仓库：https://github.com/agarrharr/awesome-cli-apps（888 行）

### 为什么合适

`## AI` → `### Agents` 章节里已经有同生态工具：

```
- [toktrack](https://github.com/mag123c/toktrack) - Track token usage and cost across all agents.
- [lean-ctx](https://github.com/yvgude/lean-ctx) - Token-saving context runtime for agents.
- [Shep](https://github.com/shep-ai/cli) - Multi-session SDLC control center for AI coding agents.
```

这个列表的条目**极短**，基本一句、结尾带句号。长描述会被要求改。

### 要粘贴的条目

放在 `## AI` → `### Agents` 末尾：

```markdown
- [thinking-treelog](https://github.com/Xocean996/thinking-treelog) - Turns an AI session into a searchable thought tree and lints it for reasoning gaps.
```

**不要用长版本。** 这个列表的所有条目都是这个长度，长了会被拒。

### PR

```bash
git clone https://github.com/Xocean996/awesome-cli-apps.git
cd awesome-cli-apps
git checkout -b add-thinking-treelog
# 编辑 readme.md（文件名是小写），在 ## AI → ### Agents 末尾加一行
git add readme.md
git commit -m "Add thinking-treelog"
git push origin add-thinking-treelog
```

PR 标题：`Add thinking-treelog`

PR 描述：

```markdown
Adds thinking-treelog under AI → Agents.

It reads an AI session log and turns it into a typed thought tree, then lints the
tree for reasoning gaps. Kept the description to one line to match the rest of
this list.
```

---

## 四、不建议投的：awesome-cli-coding-agents

仓库：https://github.com/bradAGI/awesome-cli-coding-agents（1036 行）

**不投的理由**

1. 它的条目格式带 star 数：

   ```
   - **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** `⭐ 257k` — ...
   - **[OpenCode](https://github.com/anomalyco/opencode)** `⭐ 222k` — ...
   - **[Codex CLI](https://github.com/openai/codex)** `⭐ 131k` — ...
   ```

   最低的也是六位数。我们 1 star，放进去第一眼就是"这个项目没人用"。

2. 它是 **coding agent 列表**。thinking-treelog 不驱动 agent，它分析 agent 的产物。
   分类不对。

3. 硬塞进不合适的列表，被拒之后，同一批维护者未来看到你的 PR 会更谨慎。

**正确的做法**：等 star 数上来，或者项目定位变化后再投。

---

## 执行顺序

1. **awesome-mcp-servers** —— 最匹配，有 11 个 MCP 工具
2. **awesome-ai-devtools** —— 格式宽松，CLI Utilities 正好
3. **awesome-cli-apps** —— 描述砍到一句再投

三个 PR **不要同一天提**。隔一两天，让每个都被认真看。

## 通用的三条

- **一次只改一行。** 顺手改排版、修 typo 会让 diff 变大，审起来更慢。
- **描述里别用"革命性""颠覆"这类词。** 这些列表的维护者一天拒十个。
- **被要求改就改。** 一个被改两次后合并的 PR，比一个被拒的完美 PR 有用。

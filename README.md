# DSH Dev Workflow

<p align="center">
  <img src="assets/workflow-infographic.svg" width="920" alt="人设 · 看板 · 流程：想法如何落进项目里的只追加记录">
</p>

<p align="center">
  <strong>一个人 + 一个 AI，也能做出有章法的东西。</strong><br>
  选一个人设开始聊想法，它记下你的原话、拆成任务、真跑一遍验证 —— 换 session、隔一周回来，都还接得上。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-plugin-dev-workflow"><img src="https://img.shields.io/npm/v/dsh-plugin-dev-workflow?color=44403c&label=npm" alt="npm version"></a>
  <a href="https://github.com/yuna78/dsh-plugin-dev-workflow/actions"><img src="https://img.shields.io/github/actions/workflow/status/yuna78/dsh-plugin-dev-workflow/ci.yml?label=CI" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-44403c" alt="MIT license"></a>
</p>

> **DSH 的轻量开发 workflow 插件。** 三个零件：一个会记账的人设（preset）、一块只读看板、一条
> `Request → Feedback → Task → Verify → Completion` 的流程。为「一个 plugin、一个小工具、一个人的小应用」
> 而做 —— 不是给大团队用的研发管理平台。

---

## 先说清楚它是给谁的

|  |  |
| --- | --- |
| **适合** | 一个 plugin、一个脚本、一个自己每天会用的小应用；想法还很模糊，想先聊出来再定；对话横跨几天、几个 session；你一个人，或者两三个人，不需要 Jira 和站会 |
| **不适合** | 多人协作的正式研发项目（没有角色、权限、代码评审、CI 集成，也不打算做）；需要合规审计与跨团队流程治理的场景；期待「一句话自动生成整个产品」的场景 |

一句判断标准：**如果你的项目能用「我一个人 + 几个晚上」描述清楚，它就是为你做的。**
如果你需要的是「谁在什么时候改了哪行、走什么审批流」，请去找 Issue 系统 —— 这个插件不解决那个问题，也不假装能解决。

## 你是不是也这样

- 想法是散步时冒出来的，坐回电脑前只剩一句「那个东西挺好的」。
- 前天说清楚了需求，今天 AI 又问一遍「你希望在哪个页面改？」。
- 「应该跑通了吧？」—— 然后发现根本没跑过，或者跑过但忘了退出码是几。
- 一个功能改了五轮，第五轮和第一轮到底哪句话算数，翻聊天记录也翻不出来。
- 上周那个 session 里的结论，这周开新窗口就人间蒸发了。

这些不是模型不够聪明，是**上下文和决策没有落盘**。这个插件做的事很朴素：把你亲口说的话、定下来的事、
真跑过的命令，留在项目目录里，并且让 agent 每次都先读它。

## 它做三件事

### 一、人设：一个会记账的搭档

新建会话时选 preset「研发助手 · Dev Assistant」。它不是任务清单机器人，也不是「自动驾驶按钮」，
而是换了性格的工作协议：

- 你说需求，它先存**原话**（`rawQuote`，不改写、不润色），再问你验收条件；
- 你给反馈，它留**你的原话** + 决策（接受 / 拒绝 / 延后），并且**不会**把一次偏好悄悄升级成团队规范；
- 它不说「应该测过了」—— 要么有命令和退出码，要么这条任务不算完成；
- 破坏性动作（推送、发布、删数据）先停下来，把风险摊开给你选。

核心优先级写在 persona 里：**安全硬边界 > 仓库规范 > 项目目标 > 用户偏好 > 本次需求**。

### 二、看板：想法不再埋在聊天里

![研发看板：需求 / 待办 / 待确认 / 已完成，可切换进行中 / 已完成 / 全部](https://raw.githubusercontent.com/yuna78/dsh-plugin-dev-workflow/main/docs/preview-board.png)

左侧边栏点「研发看板」，就是这个工作区的全部记录：

- **四列**：需求（未终结的：你的原话 + 验收）、待办（`queued` 或仍需处理的 `partial`，后者标注“部分完成”）、待确认（`waiting-user`，需要你点一下头）、已完成（`succeeded` 或 `cancelled`，取消任务标注“已取消”）。
  已交付/作废的需求由 `dev_request_close` 给终态，不再占着需求列。
- **三个过滤**：进行中 / 已完成 / 全部，计数与列表同源，不会各算各的。
- **只读**：看板只调一个 GET 路由，只打开 `<工作区>/.dsh-dev/` 里那几个已知 JSONL，不写任何记录。
- **换个工作区即换项目**：记录按项目隔离，一个人同时维护几个小项目也不会混。

### 三、流程：五步，每一步都能被回看

```text
你的原话 ──→ 可执行任务 ──→ 真实命令 ──→ 带证据的收口
         ↘ 反馈与决策 ↗          ↘ 可复盘的知识 ↗
```

| 步骤 | 落下来的东西 | 为什么重要 |
| --- | --- | --- |
| Request | 原话、范围、验收条件 | 三天后还知道当初到底要什么 |
| Feedback | 原话、决策、影响 | 改主意是被记录的，不是被遗忘的 |
| Task | 步骤、依赖、风险、验收 | 下次接着做，不用重新推理 |
| Verify | 命令 + 退出码 + 结果 | 「完成」有证据，不靠形容词 |
| Completion | 变更文件、证据、风险、未完成项 | 交接给人或交给未来的自己 |

## 一个想法的一生

下面是一段**示意**（脱敏改写），每一步都对应真实存在的记录结构：

```text
Day 0  21:40  你：我想做个小插件，把当前窗口的标签页收成一个清单，能导出 markdown。
                    先能跑就行，别装依赖。

              → 需求登记（原话照抄）
                验收：读得到当前窗口标签页 / 能导出 .md / 不新增依赖

       21:52  → 拆成 3 个任务：读标签页、生成 markdown、写一个 smoke 门禁

       22:20  实现跑起来了。验证记录：node verify/smoke.mjs  exitCode 0

Day 1  09:10  新 session。你：顺手加个按域名分组吧。
              → 反馈登记（原话）+ 新任务「按域名分组」，依赖前面那个拿标签页的任务

Day 3  回来只问一句：「上次导出格式定的是哪个？」
              → 上下文摘要：需求 2 条、进行中任务 3 个、最近反馈 1 条 —— 不用你复述
```

关键不在于它记住了多少，而在于**你从来不需要复述**。切换 session、隔一周、换一台机器（把项目目录带过去就行），
接续的成本是一次 `dev_context_get`。

## 它为什么不会「聊着聊着就丢了」

persona 写在上下文开头，回合一长就会被工具结果挤远。我们在真机会话里量到过：`dev_context_get` 在第 1 秒就调用了，
`dev_request_capture` 却拖到 **+86 秒、第 40 次工具调用之后**，`dev_feedback_record` 整轮没触发。

所以插件做的不只是一段提示词：

1. **运行期提醒**：通过 `agent/pre-step`，在**第 1 步以及之后每 5 步**往请求历史里追加一条带当前项目
   **真实记录计数**的提醒（需求 2 · 任务 3 · 反馈 1 · 验证 1 · 完成 0），附带执行顺序。它只读
   `<project>/.dsh-dev/`，不写状态，读取失败原样放行，不会让回合挂掉。
2. **原话优先**：`rawQuote` 存的是你打的字，不是它总结的版本。失真从第一行就被拦住。
3. **记录跟着项目走**：`<project>/.dsh-dev/*.jsonl`，append-only，只追加不改写，`git diff` 之外多一条可回滚的证据轴。
4. **有界摘要**：`dev_context_get` 只给项目目标、未完成任务、最近反馈 —— 不把半年历史一次性灌进上下文。

## 60 秒上手

1. **装**：

   ```text
   DSH「Add plugin」里搜 dsh-plugin-dev-workflow
   ```

   或者：

   ```text
   plugin_manager install_bundle target=dsh-plugin-dev-workflow
   ```

   本地开发时：`plugin_manager install_bundle target=<本目录绝对路径>`

2. **新建会话，选 preset「研发助手 · Dev Assistant」**。不要手写 profile 的 `package.json` 或 `cordis.patch.yml`。
3. **用平常的话说想法**。第一句话不需要格式，比如「我想把 X 做得更顺手一点，先看看现在什么样」。

第一次用最值得观察的一点：它会**先问验收条件，再动手**。如果你觉得它问得多，那是这套流程在起作用 ——
一个说不清「怎样算做完」的需求，最后一定会以「这不是我要的」收场。

## 工具箱

| 工具 | 干什么 |
| --- | --- |
| `dev_context_get` | 读项目上下文、未完成任务与最近反馈（有界摘要） |
| `dev_request_capture` | 保留用户原话与验收条件；缺验收时只做澄清登记，不自动开工 |
| `dev_request_close` | 给需求终态：`delivered`（已交付）/ `invalid`（已作废）/ `superseded`（已被取代）；append-only 追加状态行，需求列不再陈列已终结需求 |
| `dev_feedback_record` | 记录反馈原话与决策，不自动升级为长期规范 |
| `dev_task_plan` | 建任务：步骤、依赖、风险、验收；破坏性范围可标 `waiting-user` |
| `dev_verify` | 记录真实命令与退出码，`exitCode` 由调用方给，不接受伪造 `succeeded` |
| `dev_complete` | 汇总完成内容、变更文件、证据、风险与未完成项；没有通过证据只能是 `partial`，没有你确认只能是 `waiting-user` |
| `dev_knowledge_promote` | 只在你**明确确认**后沉淀偏好或规范，默认 `proposed`，可撤销 |

## 记录到底长什么样

本地 append-only JSONL。下面是**脱敏示例**，不是预置数据：

```json
{"schemaVersion":1,"requestId":"req_7f21","rawQuote":"把登录页的错误提示改得更清楚","acceptance":["空密码显示字段级提示","错误提示不泄露账号是否存在"],"status":"captured"}
{"schemaVersion":1,"feedbackId":"fb_12ac","requestId":"req_7f21","rawQuote":"文案要短一些，但保留可操作建议","decision":"accept","category":"quality","status":"recorded"}
{"schemaVersion":1,"taskId":"task_91de","title":"更新登录错误提示","acceptance":["单元测试覆盖两种错误分支"],"status":"queued"}
{"schemaVersion":1,"verificationId":"verify_44aa","taskId":"task_91de","command":"npm test -- login","exitCode":0,"status":"passed"}
{"schemaVersion":1,"completionId":"completion_08c1","taskId":"task_91de","status":"succeeded","verificationRefs":["verify_44aa"]}
```

```text
<your-project>/.dsh-dev/
├── requests.jsonl      你亲口说的需求（原话 + 验收）
├── feedback.jsonl      你的每次反馈与决策
├── tasks.jsonl         任务、依赖、风险
├── verifications.jsonl 命令与退出码
├── completions.jsonl   收口总结
└── knowledge.jsonl     被确认过的偏好（默认只是候选）
```

纯文本、可 `grep`、可 `git diff`：想看就打开，想比就 diff，想接自己的脚本就随便接。

## 边界与隐私

- **全部在本地**。没有账号、没有云端、没有遥测。
- **只追加**：`dev_*` 工具不改写历史；`dev_complete` 从不回写 `tasks.jsonl`。
  看板与 `dev_context_get` 复用有效任务状态：各日志按 ID 取最后一行；任务自身 `succeeded` / `cancelled` 优先，否则采用最新 completion 的 `partial` / `waiting-user` / `succeeded`，未知 completion 状态不覆盖任务状态。
  返回的 `status` 是有效状态，`storedStatus` 保留任务原始状态，`completionStatus` 保留最新收口状态。
  只有有效状态 `succeeded` / `cancelled` 关闭并移出上下文，先过滤再截取 `limit`，避免成功任务挤掉真正未完成的任务。
  本规则不新增跨日志时间戳排序或重新打开终态任务的操作。

- **不越权**：不跨项目读取、不自动装依赖、不自动 `git commit`、不自动 `npm publish`。
- **别把 `.dsh-dev/` 提交进 Git**（本项目自己也在 `.gitignore` 里），也不要往里写密钥或客户资料。

**它明确不做的事**（说清楚，免得你按它没有的方式用它）：

| 不做 | 因为 |
| --- | --- |
| 多人协作 / 角色权限 / 代码评审 | 它是给一个人（或两三个人顺手用）的轻量流程 |
| 云同步、团队共享看板 | 记录是项目目录里的文件，跟着仓库走 |
| 自动提交、自动发布 | 交付的最后一步永远留给人和你的 2FA |
| 企业合规审计 | 它留证据，但不做审计系统 |
| 强制的多人流程治理 | 它靠人设和提醒约束 agent，不靠审批流 |

### 完成记录与完成状态

历史 CHANGELOG 的 0.2.0 条目将“存在收口记录”作为关闭条件，而待确认列的说明使用了 `waiting-user` 语义。
这里明确区分：completion 表示一次收口结果，不等于任务成功或终结。
看板关闭策略改为与上下文共用有效终态；这是对历史看板策略的语义调整，同时修复上下文读取遗漏 completion 导致的错误计数与窗口遗漏。
任务自身终态判断仍保留，以支持显式终态的旧数据或导入记录；当前 `dev_task_plan` 的公开 schema 只创建 `queued` / `waiting-user`。

## 记录一多怎么办

一个跑半年的小项目会有几百条需求、上千条任务。看板不假设记录少：

| 维度 | 做法 | 为什么 |
| --- | --- | --- |
| 已完成任务 | host 只返回最新 30 条，列头写 `5/150`，底部 `显示更多 · 还有 145 条`，点一次 +50 | 历史是无限增长的轴，必须服务端截断 |
| 需求 | 同上，默认 40，每次 +40 | 需求同样只增不减 |
| 待办 / 待确认 | 每列默认 20，`显示更多` 本地 +30，不重新请求 | 已经在响应里，本地切片就够 |
| 计数 | 顶部 chips 永远描述**全量**，列头才写「已显示/总数」 | 知道总量，也知道屏幕上只是一部分 |
| 反馈 | 每个需求/任务只挂**最新一条**，历史仍在 `feedback.jsonl` | 卡片看结论，历史留档 |

实测（合成数据 200 需求 / 300 任务 / 150 完成）：默认响应 **70 KB**，全量 155 KB，`readBoard()` 约 **10 ms**。

## 兼容性

- DSH：`>=0.2.1-rc.2 <0.3.0`
- Node.js：`>=22.19.0`
- 当前版本：`0.2.6`

## 开发

```bash
node verify/smoke.mjs          # 门禁：工具 + 提醒 + 看板 host/client
node verify/preview.mjs        # 用真实记录离线渲染 docs/preview-board.png
node --check index.js client.js
npm pack --dry-run
```

发布记录与踩坑写在 [`docs/log/`](docs/log/)，每个版本一篇。

## 路线图

- [ ] 真实宿主执行器与验证证据绑定
- [ ] 完成任务自动更新状态
- [ ] 路径边界校验与敏感信息检测
- [ ] 干净 profile 安装测试与 CI

## 项目链接

- Repository: https://github.com/yuna78/dsh-plugin-dev-workflow
- Changelog: [CHANGELOG.md](CHANGELOG.md)
- Issues: https://github.com/yuna78/dsh-plugin-dev-workflow/issues
- npm: https://www.npmjs.com/package/dsh-plugin-dev-workflow

## License

[MIT](LICENSE)

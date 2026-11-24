# AGENTS.md — dsh-qwen-connect

> 本文件由仓库现状与实测证据校准（2026-11-24，依 project-agents-md skill）。每一条命令、每一个边界都对应真实文件；改动代码结构后请同步更新本文件，而不是让它漂移。仓库级协作入口约定：在本仓库开始编码、评审或文档工作前先通读本文件。

## 1. 项目定位与背景

**这是什么**：DSH（DeepSeek Harness）的本地插件包 `@xiao-hans/dsh-qwen-connect`。它复用本机「千问办公」（QwenWorkCN，钉钉系桌面 App）的登录态，把千问办公推理链路注册成 DSH 的一个 LLM provider（配置 id `llm-qwenwork`），让 DSH / Codex / Pi 直接调用，不额外申请 API Key、不单独发版。

**为什么这样设计**：上游没有对外 API 契约，链路靠协议逆向 + WASM 签名打通。因此本仓库的主体资产不是代码量，而是**「哪些东西会变、变了怎么发现、发现了怎么兜住」这套自适应与漂移检测机制**。

**上下游关系**：
- 上游 = 千问办公 App（本机安装，随版本自更新）+ 其内置 `@qoder-ai/qoder-agent-sdk` 的混淆产物 + 签名 WASM。**上游不是我能控制的仓库，它的每次升级都可能改变本插件的行为。**
- 下游 = DSH profile（`cordis` / `dsh-llm` / `dsh-settings` / `@earendil-works/pi-ai` 等 peer 依赖）与浏览器侧设置卡片。
- 兄弟仓库：`pi-provider-qwenwork`（同一推理链路，面向 Pi 编码代理，位于同级目录 `../pi-provider-qwenwork`）。两者共享凭证/签名思路，**改协议层要检查兄弟仓库是否需要同步**。参考实现：`dsh-qoder-connect`（同 DSH 生态的另一 provider 插件）在「动态目录 → 选择器刷新」上比本插件完整，见 §7 DoD 与记忆笔记 `main/dsh-workspace/gotchas/plugin-dev-gotchas.md`。
- 远端：`origin`/`github` → `github-personal:xiao-hans/dsh-qwen-connect`；`gitee` → `gitee-personal:han-xiaos-whisper/dsh-qwen-connect`；默认分支 `main`。当前版本 0.2.9。

## 2. 硬性边界与红线

违反任一条即为错误改动，不需要讨论：

1. **`lib/index.js` 的 `apply()` 永远不许抛异常。** 抛出会触发 DSH 红色「插件加载失败」横幅，连设置卡片一起消失，用户无从排查。所有失败必须降级成显式状态 + `QwenAuthError` 之类的可读错误。
2. **凭证解密只走 `lib/credentials-seam.js` 这一道缝。** 任何地方不得重新实现 DPAPI / AES-256-GCM / `auth-v2.dat` 解析。凭证由每次请求实时从本机 App 数据目录取，**插件自身绝不落盘、绝不缓存进 DSH**。
3. **凭证绝不进浏览器。** `lib/web-status.js` 只接受 loopback（Host 为 127.0.0.1 / localhost / [::1]）且 Origin 非空并同为 loopback（DNS-rebinding 防护）；任何响应发出前必须脱敏 `eyJ...` / `Bearer xxx` / `token=...` 与 JWT。
4. **绝不编造数字。** 上游返回 null 就保持字段缺失，禁止 `Number(null) → 0` 这类「看起来合理」的兜底污染计费与用量。
5. **真实付费探针不许自动跑。** `tools/live-check.mjs`（脚本逻辑）以及 `tools/{live-chat-e2e,toolcall-e2e,usage-e2e,t7-e2e-chat,captain-e2e-chat,seam-live-check}.mjs` 会消耗账号真实额度。**只有用户明确要求时才可执行**，普通验证用单测 + 静态检查。（注：`package.json` 的 `probe:live` 现指向不存在的 `tools/live-check.mjs`，实际脚本在 `test/tools/live-check.mjs`——见文末待确认清单。）
6. **`research/` 下禁止出现 `test-*.mjs` 命名。** 只用 `probe-` / `diag-` / `find-` / `dump-` / `check-` 前缀。原因：`verify-all.mjs` 用**不带参数的** `node --test` 扫全仓库，会把 `research/test-*.mjs` 当单测自动跑，而那些脚本会真调 API 花额度。这条由 `tools/verify-all.mjs` 内的守卫强制。
7. **零运行时依赖不许扩大。** `package.json` 的 `dependencies` 恒为空，宿主能力全部走 `peerDependencies`。新增 npm 依赖前必须先与用户确认。
8. **`cordis.patch.yml` 只注册 provider，绝不改 profile 的默认模型。** 也不许改 `tools/install-to-dsh.mjs` 的行为去碰用户的 profile `cordis.patch.yml`（安装器设计上从不写它，只写 package.json 三处登记）。
9. **禁止用 PowerShell 的 `Get-Content`/`Set-Content` 读写本仓库文本。** 本机 PowerShell 默认 GBK，已不可逆损坏过 UTF-8 文件；`verify-all.mjs` 的编码守卫会抓 BOM/乱码。
10. **`dist/` 是构建产物，不许手改。** 只由 `node tools/package-plugin.mjs` 生成。

## 3. 技术栈与模块拓扑

- **运行与工具链基线**：Node.js ESM（`"type": "module"`），`engines.node: ^22.19.0 || >=24.0.0`。零 TypeScript、零打包器，`lib/*.js` 直接就是发布产物。无 eslint/biome/ruff 配置，`node --check` 是唯一静态门。
- 唯一的非 JS 二进制资产：`research/wasm.bin`（297,238 B，签名 WASM，**随包发布**，见 `package.json` `files`，与本机安装的 App 版本解耦）+ `research/qoder-wasm-glue.mjs`。默认路径在 `lib/signer-session.js` 的 `DEFAULT_WASM_BIN` / `DEFAULT_GLUE`。
- 前端注入：`package.json` 的 `dsh.client.inject` = `@deepseek-ai/dsh-client-ui-renderer` / `-ui-primitives` / `-ui-settings` / `-ui-slots` / `-settings-plugins` / `-locale`，`dsh.client.platform: web`；`dsh.bundle.patch: ./cordis.patch.yml`。导航图标取 primitives 的 `IconLinkOutlineMedium`（与宿主 `navIcon(id)` 同族），取不到时退回本地描边图形。

`lib/`（26 个 .js + `README-credentials.md`）的分层与调用方向（只允许上层 → 下层，禁止反向依赖）：

| 模块 | 职责 | 谁调它 |
|---|---|---|
| `index.js` | DSH 宿主入口：注册 `llm-qwenwork` provider 与状态路由；`name='llm-qwenwork'`、`inject=['llm']`、`QWENWORK_SETTINGS_NS='qwenwork'`、`QWENWORK_STREAM_IDLE_TIMEOUT_MS=300_000` | DSH cordis |
| `client.js` | 浏览器设置卡片（经 `__ModuleLoader__.load`） | DSH 客户端 |
| `web-status.js` | loopback-only 状态路由（JWT 脱敏） | `index.js` |
| `credentials-seam.js` | **唯一**凭证对接缝 | `signer-session.js`、`auth*.js` |
| `credentials.js` / `dpapi.js` | `auth-v2.dat`（schemaVersion 2）解析、DPAPI 主密钥链 | 只经 seam |
| `signer-session.js` | WASM 签名会话 + 上游请求体构造 | `chat-shim.js` |
| `chat-shim.js` | loopback 上 OpenAI ⇄ QwenWork 协议转换（tool_calls、usage、image） | `index.js`、`signer-shim.js` |
| `signer-shim.js` | 稳定的转发出口（**集成方只 import 这个**） | 外部集成方 |
| `sse.js` | 健壮 SSE 解析 + OpenAI chunk 编码 | `chat-shim.js` |
| `runtime-identity.js` | Cosy-Version / machineId 多级兜底（含注册表发现） | `signer-session.js`、`tools/check-upstream-contract.mjs` |
| `models.js` | 模型目录的**生效状态**与字段映射（上游优先，静态表兜底）+ 模型偏好层（停用集合、生效默认 `preferredCatalog()` / `effectiveDefaultKey()`） | `chat-shim.js`、`client.js`、`model-catalog.js` |
| `model-catalog.js` | 签名拉取 `/api/v2/model/list` + 归一化 + TTL/退避刷新器（永不抛），目录变更回调 `onCatalogChanged` | `index.js` |
| `settings-store.js` | 插件自持 `settings.json`（`<profile>/.dsh-qwen-connect/`）读写与原子落盘，偏好归一化 | `index.js`、`web-status.js` |
| `endpoint.js` / `rest.js` / `api.js` / `auth-api.js` / `auth.js` | 网关地址、HTTP 封装、状态与用量 API | 上层 |
| `loopback.js` | loopback/Origin 判定 | `web-status.js`、`chat-shim.js` |
| `stall-detector.js` / `stall-guard.js` | 「半途停止」判定与原位续跑守卫 | `chat-shim.js` |
| `trace.js` / `perf.js` / `status-paths.js` / `errors.js` | 诊断落盘、采样窗口（20）、host/client 共享常量、错误类型 | 全局 |

- **关键技术取舍**：模型目录状态收敛在 `models.js`（`activeCatalog` / `catalogMeta`）而非拉取模块，三个消费点（`normalizeModelKey()`、`catalogForCard()`、`toPiModel()`）无需改签名即可看到新目录，并避免 `models.js ← model-catalog.js` 循环 import。

## 4. 目录结构

```text
dsh-qwen-connect/
├─ AGENTS.md                 仓库协作约定（本文件）
├─ CLAUDE.md                 @AGENTS.md（Claude Code 入口）
├─ README.md                 项目说明与运行入口
├─ 安装说明.md               面向用户的安装步骤
├─ cordis.patch.yml          仅注册 provider，绝不改默认模型
├─ package.json              零 dependencies，全部 peerDependencies
├─ .agents/skills/           项目技能本机副本（software-development-workflow / karpathy-guidelines / doc-sync）——**已 gitignore，不入库**
├─ .claude/skills/           Claude Code 接线路径（mklink /J 联接 → .agents/skills）——**已 gitignore，不入库**
├─ lib/                      26 .js + README-credentials.md ——发布主体，唯一「改了就得重新部署」的目录
├─ tools/                    22 个 .mjs —— verify-all / check-upstream-contract / package-plugin /
│                            install-to-dsh / detect-dsh / 各类 *-check.mjs 与 *-e2e-chat.mjs
├─ test/                     web-status.test.mjs + unit/*.test.mjs(24) + tools/live-check.mjs
├─ docs/                     App升级后失效排查手册.md（升级排障主文档）· DSH本地插件安装规范.md ·
│                            Buddy2api借鉴调研报告.md · SSE双通道诊断报告.md · 已知上游边界.md
├─ research/                 wasm.bin + qoder-wasm-glue.mjs（随包发布）；probes-*/、buddy2api-probes/
│                            ——历史探针与调研，**不参与测试**（见红线 6）
└─ dist/@xiao-hans/          package-plugin.mjs 生成的可分发目录 + zip ——构建产物，不许手改
```

## 5. Skill 调度

- **动态匹配与全文读取**：任务开始、需求变更或进入新阶段时，将任务意图与下方已核实的项目技能及全局技能匹配，存在多个候选时选用覆盖任务的最小组合；执行对应操作前读取所选 `SKILL.md` 全文及其要求的参考文件。
- **冲突与授权边界**：Skill 规则与本文件、仓库代码或构建配置冲突时，以仓库实际证据与本文件为准。加载 Skill 仅建立操作流程，安装组件、修改全局配置、文档归档同步、写入持久记忆、提交与推送仍受当前请求授权约束。

本仓库已按 project-agents-md skill 第 4 步安装三个**项目技能**（用户 2026-11-24 明确授权），副本在 `.agents/skills/<name>/SKILL.md`，并经目录联接 `.claude/skills → .agents/skills` 接线给 Claude Code。**`.agents/` 与 `.claude/` 都是本机 AI/agent 生成物，已写进 `.gitignore` 不入库**，故换机或重新克隆后副本与接线都要重跑 skill 第 4 步复原。项目技能一律从下表相对路径读回后再执行，不依赖工具自动发现。全局技能见第二张表（发现途径：会话可用技能列表 + `~/.agents/skills/` 目录实读 + `~/.claude/skills → ~/.agents/skills` 软链确认，2026-11-24）。

| 触发场景 | 项目 Skill（执行前先读相对路径） | 用途与检查点 |
|---|---|---|
| 任何 `lib/` 或 `tools/` 的实现改动、修复、重构、脚本/配置变更 | `software-development-workflow`；先读 `.agents/skills/software-development-workflow/SKILL.md` | 小步可用增量 + 适度设计与验证；复用既有授权与项目记录，不重跑已存在的入口确认。来源：选择池；选配日期：2026-11-24；接线：`.claude/skills/` 联接，已读回比对一致 |
| 写/审/重构 `lib/` 时压复杂度 | `karpathy-guidelines`；先读 `.agents/skills/karpathy-guidelines/SKILL.md` | 做外科式最小改动、避免过度设计与顺手改动、显式假设与可验证成功标准。来源：选择池；选配日期：2026-11-24；接线：`.claude/skills/` 联接，已读回比对一致 |
| 用户明确要求同步/归档/存知识库/双写文档时 | `doc-sync`；先读 `.agents/skills/doc-sync/SKILL.md` 及 `references/incremental-sync.md` | 主存 `docs/` + 知识库双写，正文保持一致；归档本地提交不推送。仅显式授权时触发，普通编辑不自动归档。来源：选择池；选配日期：2026-11-24；接线：`.claude/skills/` 联接，已读回比对一致 |

| 触发场景 | 调用的全局 Skill | 用途与检查点 |
|---|---|---|
| 本文件需要重建/校准（§2 边界变动、模块拓扑变化） | `project-agents-md`（全局） | 依模板与路由参考重写 AGENTS.md，先完成 skill 第 4 步检查再动笔 |
| 提交、推送 `github`/`gitee`、开或更新 MR（双远端） | `git-submit`（全局） | 准备本次任务拥有的提交，写清变更原因与影响范围 |
| 始终生效（输出格式约定） | `i-have-adhd`（全局） | 结论先行、多步编号、每轮重述进度、结尾只给一个 2 分钟内的下一步 |
| 编辑文档/交付物时清除叙述性残留 | `no-negative-echo`（全局） | 保留实质范围与溯源，删除与读者无关的叙述与「此地无银」式残留 |
| 需要查找选择池中尚无的技能候选 | `find-skills`（全局） | 核用途/来源/许可/兼容；入池与安装另需授权 |

- **技能选配（skill 第 4 步）已完成**：用户 2026-11-24 明确要求安装池内技能后，`software-development-workflow` / `karpathy-guidelines` / `doc-sync` 已从 `~/.agents/skills-pool/` 完整复制（含 `references/`，dereference 符号链接）到 `.agents/skills/`，从项目路径读回验证，并经 `.claude/skills` 联接接线、读回比对字节一致，方登记入上表。**这些副本与接线是本机 AI/agent 生成物，已写进 `.gitignore`（`.agents/`、`.claude/`）不入库**，故换机或重新克隆后两者都要重跑 skill 第 4 步复原。
- **环境全局约定**：输出一律中文（用户全局规则 0，代码/路径/标识符保留原语言）；始终套用 `i-have-adhd` 输出格式；shell 命令可加 `rtk` 前缀做输出降噪（`rtk bypass <cmd>` 回退原始输出，见 `~/.claude/RTK.md`）。

## 6. MCP 与工具调度

- **调用与降级准则**：① 调用前核实当前会话实际暴露的 server / tool 名称与参数；② 写文件或改外部状态前先读取目标现状；③ 严禁向外部服务发送密钥、签名文件、凭证或敏感数据；④ 外部工具或缓存索引结果与当前仓库源码冲突时，以仓库实读结果为准；⑤ MCP 不可用时降级至本地文件、搜索与构建工具完成工作，并在交付时注明；⑥ 新增项目级 MCP 配置须经用户明确同意并同步更新「目录结构」。

| 名称 | 用途与触发 | 状态 |
|---|---|---|
| `mcp__basic-memory__*` | 长期记忆主存储，project `main`，路径规范 `<project-slug>/<category>/xxx.md`（category: envs/gotchas/architecture/bugs/preferences/tasks）。**排障闭环强制环节**：升级失效 → 在 `main/dsh-workspace/gotchas/qwenwork-app-upgrade-adaptation.md` 里 search 后 edit 合并（先 `bm_search`，不新建重复笔记）。同目录 `plugin-dev-gotchas.md` 记插件契约；`main/dsh-workspace/envs/dsh-plugin-env.md` 记环境 | 已连接 |
| `mcp__context7__*` | 查 DSH peer 依赖（`@deepseek-ai/cordis`、`dsh-llm`、`@earendil-works/pi-ai`）与 Node 跨平台 API 的现行文档时（先 `resolve-library-id`） | 已连接 |
| `mcp__dingtalk__*` | 上游 App 是钉钉系产物；需要查 `dws-core` 登录态/账号侧信息时。**写操作前先确认**，返回值含同事个人信息，不得外贴 | 已连接 |
| `mcp__hermes-memory__*` | `~/.dsh/AGENTS.md` 声明它是共享记忆，但**本次会话未注入该 MCP**。不要假装能用；需要记忆就走 basic-memory，并在此说明冲突 | 声明存在，本会话不可用 |
| dsh-codegraph | 本仓库**没有 `.codegraph/` 索引**，故图谱/调用链工具在此不可用；探索用内置 `Grep` / `Read` / `Glob`。建索引是用户的决定，agent 不自行 `codegraph init` | 未索引 |
| 文件与搜索 | 一律内置 `Glob` / `Grep` / `Read`；大文件用 `offset`/`limit` 或 `ctx_execute` 过滤后再入上下文。禁止用 PowerShell `Get-Content`/`Set-Content` 绕过策略读文本（红线 9） | — |

- **发现记录**：来自会话工具列表与已连接 MCP（basic-memory、context7、dingtalk、prompts_chat、pi-lens、bili、codegraph 等在本会话暴露，按相关性选用）；hermes-memory 与 dsh-codegraph 索引为本仓库**不可用**项，已逐项标注。

## 7. 验证、提交与完成标准（DoD）

### 门禁命令（本仓库实测可用）

```bash
node tools/verify-all.mjs              # 单一总入口：全套静态+契约检查（含真实 API 那一步，见下）
npm test                               # node --test "test/unit/*.test.mjs"  —— 日常默认
npm run test:all                       # 含 test/tools，会跑到 live-check，谨慎
node tools/check-upstream-contract.mjs # 无参数即自动定位本机 SDK 混淆产物，漂移守卫（实测 8/8）
node --check lib/<改动的文件>.js         # 唯一静态门
node tools/package-plugin.mjs          # 重新生成 dist/（含 zip）
```

`verify-all.mjs` 的步骤顺序：全量单测（**不带参数的 `node --test`**）→ client-load-check → host-load-check → apply-check → seam-failure-check → phase-a-acceptance → seam-live-check（真实 API）→ PII 扫描 → 敏感输出扫描 → 编码体检 → 便携包 → DSH 形态探测 → 便携性因素 → 平台假设 → check-upstream-contract。其中 `seam-live-check` 会真调上游，**跑 `verify-all` 前告知用户**。

### 部署链路（改了 `lib/` 必须走完，否则本机看不到变化）

1. `node tools/package-plugin.mjs` → 刷新 `dist/@xiao-hans/dsh-qwen-connect/` 与 `dist/@xiao-hans/dsh-qwen-connect-<version>.zip`。
2. **本机 profile 走 pnpm 从 registry 安装，不是目录副本也不是 Junction**（profile 根 `~/.dsh/profiles/desktop/`，`dependencies` 里写的是具体版本号，`pnpm-lock.yaml` 有 `resolution.integrity`）。因此本地源码改动**必须先发布再升级**，`install-to-dsh.mjs` 的 Junction 通路在本机已不适用：
   ```bash
   npm publish                       # dist/@xiao-hans/dsh-qwen-connect 内，去掉 private 后发布
   cd ~/.dsh/profiles/desktop
   pnpm add "@xiao-hans/dsh-qwen-connect@<version>" --registry=https://registry.npmjs.org
   ```
   注意 `tools/package-plugin.mjs` 会把 dist 的 `package.json` 强制写成 `private: true`（防误发），发布时须用临时副本删掉该字段，**不要改构建脚本，也不要把 `private` 留在 dist 里**。本机 registry 配的是 npmmirror，镜像同步滞后，装新版必须显式 `--registry=https://registry.npmjs.org`。
3. **完全重启 DSH**（热重载不覆盖插件入口），否则运行中的进程仍用旧代码。
4. 校验方式：对 `lib/` 关键文件做 sha256 前 12 位对比（source / `node_modules/@xiao-hans/dsh-qwen-connect`），要求全等。

### 上游版本兼容的实测基准（2026-11-17，2026-11-24 复核仍成立）

- 千问办公安装目录由**非标准布局**发现（如 `<盘符>\qwenwork\QwenWorkCN` 这种扁平结构，App 数据目录为 `%APPDATA%\QwenWorkCN`）。`lib/runtime-identity.js` 的 `installRootCandidates()` 覆盖 ProgramFiles / LocalAppData / 各盘符 `Qwen\`、`Program Files\Qwen\`、`software\Qwen\`、`qwenwork\`、扁平 `QwenWorkCN\`，第三层兜底 `registryInstallRoots()` 读注册表卸载项。**注册表项常无 `InstallLocation`**，路径要从 `UninstallString`/`DisplayIcon` 里正则摘出；`reg.exe` 在 zh-CN Windows 输出 GBK，必须 `new TextDecoder('gbk')`，否则非 ASCII 路径永久解不出来。
- 生效的环境钩子：`QWEN_INSTALL_ROOT`（最高优先，插件与契约检查器共用同一变量）、`QWEN_INSTALL_DRIVES`、`QWEN_COSY_VERSION`、`QWEN_APP_VERSION`、`QWEN_MACHINE_ID`、`QWEN_MACHINE_ID_FALLBACK`。
- 实测：App 1.3.1 → 1.3.2 升级**不影响可用性**（凭证文件 survive，签名与 chat 链路正常）。Cosy-Version 解析命中混淆产物时得到 1.1.71（`source:'obf'`），解析不到时落 `FALLBACK_COSY_VERSION='1.1.32'` 且服务端仍接受。
- 混淆产物锚点规则（`tools/check-upstream-contract.mjs`）：**锚点里既不许出现变量名，也不许出现兄弟键名**（两者都随构建漂移）。稳定指纹 = 目标结构的独有键（聊天请求体用 `chat_record_id:` + `src.lastIndexOf('return{', at)`，间距守卫 ≤400）。请求体键：`REQUIRED_BODY_KEYS` 20 个固定 + `CONDITIONAL_BODY_KEYS` 4 个条件展开。`body-ctor` 检查在缺键时必须判 `ok:false`（旧实现永远 ok，抓不到真实删除）。
- 合并上游 lib/ 改动后 `dist/` 会立刻重新落后（PR #3/#4 改了 `lib/auth.js`、`lib/credentials.js` 却没人重打包）：**每次 merge 之后重跑 `node tools/package-plugin.mjs` 并单独提交 dist**。
- 测试夹具坑：`cosyVersionFromObf` 取 `$A=` 之后的**第一个字面量**，混淆夹具须写成 `$A=KS||"9.9.9",o=1;KS="9.9.9";bn(x,{COSY_VERSION:()=>$A});`，兜底字面量与权威字面量必须一致。

### 已知限制（不要当 bug 修，见 `docs/已知上游边界.md`）

- 模型目录已改为**动态**（`lib/model-catalog.js` 签名 GET `/api/v2/model/list`，`mode:'auth'`，取 `qwork` 场景）。裸调仍 403，必须走签名会话。静态表降为兜底；拉取失败保留上次成功目录并标 `stale`，**不清空**。上游字段两个陷阱：`max_input_tokens`（180000）不是上下文上限，看 `context_config` 默认档；`price_factor` 缺失不能填 0（会渲染成「免费」）。
- 目录变更 → 选择器刷新已闭合（0.2.9）：`lib/model-catalog.js` 的 `refresh()` 成功写入目录后调用 `deps.onCatalogChanged()`（失败不通知，回调异常被吞并 warn 一次）；`lib/index.js` 把它接到 `notifyCatalogChanged = () => { adapter.invalidate(); ctx.emit('llm/adapters-updated'); }`，两半各自 try/catch，`apply()` 仍不抛（红线 1）。**不要改成只在 `getModels()` 里懒刷新**——宿主不主动重读。
- 模型偏好（选定默认 + 逐个停用）走**插件自持 `settings.json`**，不走宿主 `settings.update`：后者写 `<profile>/cordis.patch.yml` 且每次写都会 reconcile loader tree、热重挂插件 fiber，对高频点击的开关过重。路径 `<profile>/.dsh-qwen-connect/settings.json`（`lib/settings-store.js`，原子 tmp+rename，`__writes` 计数）。浏览器经 loopback `POST /plugins/dsh-qwen-connect/settings`（`lib/web-status.js` 的 `qwenWorkSettingsHandler`，白名单只认 `disabledModels` + `defaultModel`）。生效判定只在 host 侧算（`lib/models.js` 的 `preferredCatalog()` / `effectiveDefaultKey()`），卡片不做乐观更新，写回后重读状态。
- 未证实项：「设为默认」是否真的影响**新会话**的默认模型，取决于宿主是否消费 `ModelDescriptor.isDefault`。`@earendil-works/pi-ai` 在本机是死 Junction（npm-cache 已清），无法从源码核实。若宿主不消费，该按钮只影响插件选择器内的排序/徽章，属可接受的降级，但不是「已确认生效」。
- `pro` 对高重复输入（`'测'.repeat(500)`）会 >60s 挂起，属上游行为；已用显式 `parameters.max_tokens=32000` + 流空闲超时兜住。复现脚本 `research/probes-2026-09-14/verify-max-tokens.mjs`。
- `reasoning_effort='low'` 对 flash 无稳定效果（见 `research/buddy2api-probes/probe-flash-thinking.mjs`）。
- 平台限制：macOS/Linux 不支持（DPAPI + `%APPDATA%`）；跨 Windows 用户必须重新登录；凭证不可拷贝。

### 完成标准

改动算完成，当且仅当：
- [ ] ① `node --check` 通过。
- [ ] ② `npm test` 基线通过：win32 **272 用例 / 267 pass / 5 fail**（2026-11-24 复核）。**须拆开报告**，5 个 fail 固定为：4 个 ERR_MODULE_NOT_FOUND（本机缺 `@earendil-works/pi-ai` 等宿主 peer 依赖，命中 `adapter-apikey` / `export-surface` / `stall-guard-stop` / `stall-guard`），1 个 `test/unit/file-credentials.test.mjs` 的 write-back-failure 用例——它用 `fs.chmodSync(dir, 0o555)` 造只读目录，Windows 目录只读属性不阻止在其中建文件，该用例只在 Linux/macOS 成立，属测试的平台假设缺陷，**不要去改 `lib/credentials.js`**。
- [ ] ③ `node tools/check-upstream-contract.mjs` 无参数运行 **8/8** 通过（body-ctor / body-business / body-tools / runtime-auth-fields / kpe-products / cosy-version / endpoint-path / fetchkeys-absent）。
- [ ] ④ 已按 §7 部署链路（package → **发布 registry** → profile `pnpm add`）升级并提示重启。
- [ ] ⑤ 新学到的持久事实已写进 Basic Memory（`main/dsh-workspace/*`）。
- [ ] ⑥ `docs/` 与本文件若受影响则同步。

**不许**为了让测试通过而放宽断言或删除测试；`test/unit/runtime-identity.test.mjs` 现有 21 例（实测 21 pass）是升级兼容的回归网，改动 `runtime-identity.js` 必须保住它们。

### 提交与推送

仅在用户明确要求时提交/推送（依 `git-submit` skill）。本仓库为**双远端**（`github`=origin 与 `gitee`），提交 MR 时需确认目标远端。提交说明写明变更原因与影响范围，按会话要求附带 attribution 行。指令文档变更不默认触发全套构建/真机测试，仅报告实际跑过的检查。

---

## 待确认清单（核实完毕前不声称完成）

- [ ] `package.json` 的 `probe:live` / `probe:live:refresh` 指向 `tools/live-check.mjs`，但实际脚本在 `test/tools/live-check.mjs`，路径不符会直接 ERR_MODULE。需确认是改 package.json 路径还是补 `tools/live-check.mjs` 转发——需 `用户决定`。
- [ ] §7 已知限制中标注的「动态目录不刷新选择器 / 选定模型不保留」已于 0.2.9 闭合（`invalidate()` + `ctx.emit('llm/adapters-updated')` + 自持 settings.json），剩「`isDefault` 是否影响宿主新会话默认」待宿主侧证实。
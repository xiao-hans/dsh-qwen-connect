# AGENTS.md — dsh-qwen-connect

> 本文件由仓库现状与实测证据生成（2026-11-17）。每一条命令、每一个边界都对应真实文件；改动代码结构后请同步更新本文件，而不是让它漂移。

## 1. 定位与背景

**这是什么**：DSH（DeepSeek Harness）的本地插件包 `@xiao-hans/dsh-qwen-connect`。它复用本机「千问办公」（QwenWorkCN，钉钉系桌面 App）的登录态，把千问办公推理链路注册成 DSH 的一个 LLM provider（配置 id `llm-qwenwork`），让 DSH / Codex / Pi 直接调用，不额外申请 API Key、不单独发版。

**为什么这样设计**：上游没有对外 API 契约，链路靠协议逆向 + WASM 签名打通。因此本仓库的主体资产不是代码量，而是**「哪些东西会变、变了怎么发现、发现了怎么兜住」这套自适应与漂移检测机制**。

**上下游关系**：
- 上游 = 千问办公 App（本机安装，随版本自更新）+ 其内置 `@qoder-ai/qoder-agent-sdk` 的混淆产物 + 签名 WASM。**上游不是我能控制的仓库，它的每次升级都可能改变本插件的行为。**
- 下游 = DSH profile（`cordis` / `dsh-llm` / `dsh-settings` / `@earendil-works/pi-ai` 等 peer 依赖）与浏览器侧设置卡片。
- 兄弟仓库：`pi-provider-qwenwork`（同一推理链路，面向 Pi 编码代理）。两者共享凭证/签名思路，**改协议层要检查兄弟仓库是否需要同步**。
- 远端：`origin`/`github` → `github-personal:xiao-hans/dsh-qwen-connect`；`gitee` → `gitee-personal:han-xiaos-whisper/dsh-qwen-connect`；默认分支 `main`。

## 2. 硬性边界与红线

违反任一条即为错误改动，不需要讨论：

1. **`lib/index.js` 的 `apply()` 永远不许抛异常。** 抛出会触发 DSH 红色「插件加载失败」横幅，连设置卡片一起消失，用户无从排查。所有失败必须降级成显式状态 + `QwenAuthError` 之类的可读错误。
2. **凭证解密只走 `lib/credentials-seam.js` 这一道缝。** 任何地方不得重新实现 DPAPI / AES-256-GCM / `auth-v2.dat` 解析。凭证由每次请求实时从本机 App 数据目录取，**插件自身绝不落盘、绝不缓存进 DSH**。
3. **凭证绝不进浏览器。** `lib/web-status.js` 只接受 loopback（Host 为 127.0.0.1 / localhost / [::1]）且 Origin 非空并同为 loopback（DNS-rebinding 防护）；任何响应发出前必须脱敏 `eyJ...` / `Bearer xxx` / `token=...` 与 JWT。
4. **绝不编造数字。** 上游返回 null 就保持字段缺失，禁止 `Number(null) → 0` 这类「看起来合理」的兜底污染计费与用量。
5. **真实付费探针不许自动跑。** `npm run probe:live`（`tools/live-check.mjs`）以及 `tools/{live-chat-e2e,toolcall-e2e,usage-e2e,t7-e2e-chat,captain-e2e-chat,seam-live-check}.mjs` 会消耗账号真实额度。**只有用户明确要求时才可执行**，普通验证用单测 + 静态检查。
6. **`research/` 下禁止出现 `test-*.mjs` 命名。** 只用 `probe-` / `diag-` / `find-` / `dump-` / `check-` 前缀。原因：`verify-all.mjs` 用**不带参数的** `node --test` 扫全仓库，会把 `research/test-*.mjs` 当单测自动跑，而那些脚本会真调 API 花额度。这条由 `tools/verify-all.mjs` 内的守卫强制。
7. **零运行时依赖不许扩大。** `package.json` 的 `dependencies` 恒为空，宿主能力全部走 `peerDependencies`。新增 npm 依赖前必须先与用户确认。
8. **`cordis.patch.yml` 只注册 provider，绝不改 profile 的默认模型。** 也不许改 `tools/install-to-dsh.mjs` 的行为去碰用户的 profile `cordis.patch.yml`（安装器设计上从不写它，只写 package.json 三处登记）。
9. **禁止用 PowerShell 的 `Get-Content`/`Set-Content` 读写本仓库文本。** 本机 PowerShell 默认 GBK，已不可逆损坏过 UTF-8 文件；`verify-all.mjs` 的编码守卫会抓 BOM/乱码。
10. **`dist/` 是构建产物，不许手改。** 只由 `node tools/package-plugin.mjs` 生成。

## 3. 技术栈与模块拓扑

- 语言：Node.js ESM（`"type": "module"`），`engines.node: ^22.19.0 || >=24.0.0`。零 TypeScript、零打包器，`lib/*.js` 直接就是发布产物。
- 唯一的非 JS 二进制资产：`research/wasm.bin`（297,238 B，签名 WASM，**随包发布**，与本机安装的 App 版本解耦）+ `research/qoder-wasm-glue.mjs`。默认路径在 `lib/signer-session.js` 的 `DEFAULT_WASM_BIN` / `DEFAULT_GLUE`。
- 前端注入：`package.json` 的 `dsh.client.inject` = `@deepseek-ai/dsh-client-ui-renderer` / `-ui-primitives` / `-ui-settings` / `-ui-slots` / `-settings-plugins` / `-locale`，`dsh.client.platform: web`；`dsh.bundle.patch: ./cordis.patch.yml`。导航图标取 primitives 的 `IconLinkOutlineMedium`（与宿主 `navIcon(id)` 同族），取不到时退回本地描边图形。

`lib/`（24 个 .js + `README-credentials.md`）的分层与调用方向：

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
| `models.js` | 模型目录的**生效状态**与字段映射（上游优先，静态表兜底） | `chat-shim.js`、`client.js`、`model-catalog.js` |
| `model-catalog.js` | 签名拉取 `/api/v2/model/list` + 归一化 + TTL/退避刷新器（永不抛） | `index.js` |
| `endpoint.js` / `rest.js` / `api.js` / `auth-api.js` / `auth.js` | 网关地址、HTTP 封装、状态与用量 API | 上层 |
| `loopback.js` | loopback/Origin 判定 | `web-status.js`、`chat-shim.js` |
| `stall-detector.js` / `stall-guard.js` | 「半途停止」判定与原位续跑守卫 | `chat-shim.js` |
| `trace.js` / `perf.js` / `status-paths.js` / `errors.js` | 诊断落盘、采样窗口（20）、host/client 共享常量、错误类型 | 全局 |

## 4. 目录结构

```
lib/              25 .js + README-credentials.md —— 发布主体，也是唯一「改了就得重新部署」的目录
tools/            22 个 .mjs —— verify-all / check-upstream-contract / package-plugin /
                  install-to-dsh / detect-dsh / 各类 *-check.mjs 与 *-e2e-chat.mjs
test/             web-status.test.mjs + unit/*.test.mjs(22) + tools/live-check.mjs
docs/             App升级后失效排查手册.md（升级排障主文档）· DSH本地插件安装规范.md ·
                  Buddy2api借鉴调研报告.md · SSE双通道诊断报告.md · 已知上游边界.md
research/         wasm.bin + qoder-wasm-glue.mjs（随包发布）；probes-*/、buddy2api-probes/
                  ——历史探针与调研，**不参与测试**（见红线 6）
dist/@xiao-hans/  package-plugin.mjs 生成的可分发目录 + zip ——构建产物
安装说明.md / cordis.patch.yml
```

## 5. Skill 调度

本会话中确认存在的 skill，以及触发条件：

| skill | 何时用（本仓库特有判据） |
|---|---|
| `project-agents-md` | 本文件需要重建/校准时（§2 边界变动、模块拓扑变化） |
| `software-development-workflow` | 任何 `lib/` 或 `tools/` 的实现改动、修复、重构；走「小步增量 + 记录 + 验证」 |
| `git-submit` | 提交、推送 `origin`/`gitee`、开或更新 MR（注意双远端） |
| `doc-sync` | 用户明确说要同步/归档文档时；`docs/` + 知识库双写 |
| `i-have-adhd` | 始终生效（全局约定）：结论与下一步先行、多步编号、结尾只给一个 2 分钟内的下一步 |
| `karpathy-guidelines` | 写/审/重构 `lib/` 时压复杂度，禁止过度设计与顺手改动 |

## 6. MCP 与工具调度

| 名称 | 用途与触发 | 状态 |
|---|---|---|
| `mcp__basic-memory__*` | 长期记忆主存储，project `main`，路径规范 `<project-slug>/<category>/xxx.md`（category: envs/gotchas/architecture/bugs/preferences/tasks）。**排障闭环的强制环节**：升级失效 → 在 `main/dsh-workspace/gotchas/qwenwork-app-upgrade-adaptation.md` 里 search 后 edit 合并（先 `bm_search`，不新建重复笔记）。同目录还有 `plugin-dev-gotchas.md`；`main/dsh-workspace/envs/dsh-plugin-env.md` 记环境 | 已连接 |
| `mcp__context7__*` | 查 DSH peer 依赖（`@deepseek-ai/cordis`、`dsh-llm`、`@earendil-works/pi-ai`）与 Node 跨平台 API 的现行文档时（先 `resolve-library-id`） | 已连接 |
| `mcp__dingtalk__*` | 上游 App 是钉钉系产物；需要查 `dws-core` 登录态/账号侧信息时。**写操作前先确认**，返回值含同事个人信息，不得外贴 | 已连接 |
| `mcp__hermes-memory__*` | `~/.dsh/AGENTS.md` 声明它是共享记忆，但**本次会话未注入该 MCP**。不要假装能用；需要记忆就走 basic-memory，并在此说明冲突 | 声明存在，本会话不可用 |
| dsh-codegraph | 本仓库**没有 `.codegraph/` 索引**，故图谱/调用链工具在此不可用；探索用 `ops_grep` / `ops_read_files`。建索引是用户的决定，agent 不自行 `codegraph init` | 未索引 |
| 文件与搜索 | 一律 `ops_glob` / `ops_grep` / `ops_read_files` / `ops_inspect_local_file` / `ops_edit_file`；禁止用 shell 的 cat/sed/grep 或 `node:fs` 绕过策略 | — |

**`run_code` 调用规约**：程序首行写 `// plan: ...`；无依赖的调用放进一次 `Promise.all`；有依赖的在同一程序里顺序 await；一次程序 ≤128 次派发；只 return 下一步需要的字段；Outcome 的 `status` 先判再用 `data`。

## 7. 验证、提交与完成定义（DoD）

### 门禁命令（本仓库实测可用）

```bash
node tools/verify-all.mjs              # 单一总入口：全套静态+契约检查（真付费那步也含在内，见下）
npm test                               # node --test "test/unit/*.test.mjs"  —— 日常默认
npm run test:all                       # 含 test/tools，会跑到 live-check，谨慎
node tools/check-upstream-contract.mjs # 无参数即自动定位本机 SDK 混淆产物，漂移守卫
node --check lib/<改动的文件>.js         # 本仓库无 eslint/biome/ruff 配置，lint_diagnostics 只会报
                                       # 「no usable linter configuration」，node --check 是唯一静态门
node tools/package-plugin.mjs          # 重新生成 dist/（含 zip）
```

`verify-all.mjs` 的步骤顺序：全量单测（**不带参数的 `node --test`**）→ client-load-check → host-load-check → apply-check → seam-failure-check → phase-a-acceptance → seam-live-check（真实 API）→ check-leaks-all → check-sensitive-output → check-encoding → check-portable-package → check-detect-dsh → check-portability-factors → check-platform-assumptions → check-upstream-contract。其中 `seam-live-check` 会真调上游，跑 `verify-all` 前告知用户。

### 部署链路（改了 `lib/` 必须走完，否则本机看不到变化）

1. `node tools/package-plugin.mjs` → 刷新 `dist/@xiao-hans/dsh-qwen-connect/` 与 `dist/@xiao-hans/dsh-qwen-connect-<version>.zip`。
2. 同步进 profile 的 `node_modules/@xiao-hans/dsh-qwen-connect/`。**⚠️ 本机现状：那是一个真实目录副本，不是 `install-to-dsh.mjs` 建的 Junction**，所以改了 `lib/` 不会自动生效——要么重跑 `node tools/install-to-dsh.mjs --source <dist 或源目录>`，要么逐文件覆盖并校验哈希一致。
3. **完全重启 DSH**（热重载不覆盖插件入口），否则运行中的进程仍用旧代码。
4. 校验方式：对 `lib/` 全量文件做 sha256 前 12 位三方对比（source / dist / profile），要求全等。

### 上游版本兼容的实测基准（2026-11-17）

- 千问办公安装目录由**非标准布局**发现（如 `<盘符>\qwenwork\QwenWorkCN` 这种扁平结构，App 数据目录为 `%APPDATA%\QwenWorkCN`）。`lib/runtime-identity.js` 的 `installRootCandidates()` 覆盖 ProgramFiles / LocalAppData / 各盘符 `Qwen\`、`Program Files\Qwen\`、`software\Qwen\`、`qwenwork\`、扁平 `QwenWorkCN\`，第三层兜底 `registryInstallRoots()` 读注册表卸载项。**注册表项常无 `InstallLocation`**，路径要从 `UninstallString`/`DisplayIcon` 里正则摘出；`reg.exe` 在 zh-CN Windows 输出 GBK，必须 `new TextDecoder('gbk')`，否则非 ASCII 路径永久解不出来。
- 生效的环境钩子：`QWEN_INSTALL_ROOT`（最高优先，插件与契约检查器共用同一变量）、`QWEN_INSTALL_DRIVES`、`QWEN_COSY_VERSION`、`QWEN_APP_VERSION`、`QWEN_MACHINE_ID`、`QWEN_MACHINE_ID_FALLBACK`。
- 实测：App 1.3.1 → 1.3.2 升级**不影响可用性**（凭证文件 survive，签名与 chat 链路正常）。Cosy-Version 解析命中混淆产物时得到 1.1.71（`source:'obf'`），解析不到时落 `FALLBACK_COSY_VERSION='1.1.32'` 且服务端仍接受。
- 混淆产物锚点规则（`tools/check-upstream-contract.mjs`）：**锚点里既不许出现变量名，也不许出现兄弟键名**（两者都随构建漂移）。稳定指纹 = 目标结构的独有键（聊天请求体用 `chat_record_id:` + `src.lastIndexOf('return{', at)`，间距守卫 ≤400）。请求体键：`REQUIRED_BODY_KEYS` 20 个固定 + `CONDITIONAL_BODY_KEYS` 4 个条件展开。`body-ctor` 检查在缺键时必须判 `ok:false`（旧实现永远 ok，抓不到真实删除）。
- 合并上游 lib/ 改动后 `dist/` 会立刻重新落后（PR #3/#4 改了 `lib/auth.js`、`lib/credentials.js` 却没人重打包）：**每次 merge 之后重跑 `node tools/package-plugin.mjs` 并单独提交 dist**。
- 测试夹具坑：`cosyVersionFromObf` 取 `$A=` 之后的**第一个字面量**，混淆夹具须写成 `$A=KS||"9.9.9",o=1;KS="9.9.9";bn(x,{COSY_VERSION:()=>$A});`，兜底字面量与权威字面量必须一致。

### 已知限制（不要当 bug 修，见 `docs/已知上游边界.md`）

- 模型目录已改为**动态**（`lib/model-catalog.js` 签名 GET `/api/v2/model/list`，`mode:'auth'`，取 `qwork` 场景）。裸调仍 403，必须走签名会话。静态表降为兜底；拉取失败保留上次成功目录并标 `stale`，**不清空**。上游字段两个陷阱：`max_input_tokens`（180000）不是上下文上限，看 `context_config` 默认档；`price_factor` 缺失不能填 0（会渲染成「免费」）。
- `pro` 对高重复输入（`'测'.repeat(500)`）会 >60s 挂起，属上游行为；已用显式 `parameters.max_tokens=32000` + 流空闲超时兜住。复现脚本 `research/probes-2026-09-14/verify-max-tokens.mjs`。
- `reasoning_effort='low'` 对 flash 无稳定效果（见 `research/buddy2api-probes/probe-flash-thinking.mjs`）。
- 平台限制：macOS/Linux 不支持（DPAPI + `%APPDATA%`）；跨 Windows 用户必须重新登录；凭证不可拷贝。

### DoD

改动算完成，当且仅当：① `node --check` 通过 ② 相关单测通过（`npm test`；win32 基线 267 pass / 5 fail，**须拆开报告**而不是笼统说「历史遗留」：4 个是 ERR_MODULE_NOT_FOUND（本机缺 `@earendil-works/pi-ai`、`@deepseek-ai/dsh-llm` 等宿主 peer 依赖），1 个是 `test/unit/file-credentials.test.mjs` 的 write-back-failure 用例——它用 `fs.chmodSync(dir, 0o555)` 造只读目录，而 Windows 的目录只读属性不阻止在其中建文件，该用例只在 Linux/macOS 成立，属测试的平台假设缺陷，**不要去改 `lib/credentials.js`**）③ `node tools/check-upstream-contract.mjs` 无参数运行 8/8 通过 ④ 已按 §7 部署链路同步 dist + profile 并提示重启 ⑤ 新学到的持久事实已写进 Basic Memory（`main/dsh-workspace/*`）⑥ `docs/` 与本文件若受影响则同步。

**不许**为了让测试通过而放宽断言或删除测试；`test/unit/runtime-identity.test.mjs` 现有 21 例是升级兼容的回归网，改动 `runtime-identity.js` 必须保住它们。

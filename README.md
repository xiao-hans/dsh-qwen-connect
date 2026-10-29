# dsh-qwen-connect

把**千问办公（QwenWorkCN）桌面 App** 的登录态自动接入 DeepSeek Harness ——
零配置，不需要 API Key，不需要另外登录。

> **来源说明**：本仓库衍生自
> [gaoqiaoliangjie666/dsh-qwen-connect](https://github.com/gaoqiaoliangjie666/dsh-qwen-connect)——
> 原始设计与协议逆向 / WASM 签名成果归属上游作者（MIT 许可）。
> 本仓库在其基础上追加（提交 `e3ab432`，2026-10）：
>
> - **企业 VPC 租户支持**：凭据 JWT `iss` 自动派生租户网关（`lib/endpoint.js`）、
>   `organization_id` / `data_policy_agreed` 补齐（修复 VPC 恒定 503）、
>   shim / seam 端点随凭据动态解析，公有云账号零行为变化；
> - **输入框实时积分读数**：DSH 会话输入栏插槽显示剩余积分（`lib/client.js`）；
> - **DSH 0.2.x 兼容性修复**：补齐 `@deepseek-ai/dsh-llm-pi-ai` peer 声明——
>   缺失时装载期 import 被判为原生解析而失败，provider 静默不注册。
>
> 双端镜像：GitHub 本仓库 ↔ Gitee
> <https://gitee.com/han-xiaos-whisper/dsh-qwen-connect>；
> 姊妹项目（同一推理链的 Pi 编码代理宿主版）：
> <https://github.com/xiao-hans/pi-provider-qwenwork>。

## 它做什么

| 能力 | 状态 |
|---|---|
| Provider 注册（模型出现在 DSH 模型选择器，名称含倍率） | ✅ |
| 设置卡片：账号 / 积分 / 套餐 / 模型列表（含配额进度条） | ✅ |
| 凭据解密（Chromium v10 + Windows DPAPI） | ✅ |
| 账号 / 额度 / 套餐 REST 查询 | ✅ |
| **真实对话**（WASM 签名 + SSE 聊天端点） | ✅ |
| **流式输出 + 多轮上下文** | ✅ |
| **工具调用**（`tools` 透传 + `tool_calls` 协议转换） | ✅ |
| **图片输入**（DSH 附件服务 → `chat_context.imageUrls`） | ✅ |
| **token 统计**（上游 `raw_usage` → OpenAI `usage`） | ✅ |
| **上游重试**（限流 / 网关瞬时故障，最多 3 次） | ✅ |
| **请求方鉴别**（shim 共享密钥 + 常量时间比较） | ✅ |
| 动态模型目录 | ❌ 静态内置（`/api/v2/model/list` 需签名） |

## 图片输入（视觉）

上游模型具备视觉能力，本插件已打通完整链路。DSH 侧的三个条件必须同时成立：

1. 模型描述符声明 `image` 模态（`lib/models.js`）
2. pi-ai 配置了 `resolveAttachments`（`lib/index.js` 从 `ctx.get('attachments')` 取）
3. shim 把图片转成上游认的形态

**前两条是联动的**：插件按附件服务是否可用动态决定是否声明 image
（`createQwenWorkAdapter` 的 `imagesAvailable`）——避免「声明了却用不了」
（DSH 会抛 `pi-ai image input requires the durable attachment service`）。

**上游要同时收到两样东西才认图**（六变体对照实验的结论，
见 `research/probes-2026-09-14/probe-image-format.mjs`）：

| 条件 | 位置 |
|---|---|
| ① 有图标记 | `chat_context.imageUrls`（data URL 数组，无图时为 `null`） |
| ② 多模态内容 | `messages[].content` 是含 `image_url` 的**数组** |

任一缺失，模型都会回复「我没有看到您上传的图片」。因此 `toQwenWorkMessages`
对含图消息**保留数组 content**（不再塌缩成纯文本），`collectImageUrls`
只取**最后一条 user 消息**里的图（避免重复分析历史图）。

## 架构

```
lib/index.js            host 侧入口：注册 qwenwork provider + 挂载状态路由
lib/client.js           浏览器侧入口：设置卡片（__ModuleLoader__.load 包装）
lib/web-status.js       状态路由：loopback-only + JWT 脱敏，汇总卡片数据
lib/credentials-seam.js 与凭据层的唯一接缝（不重复实现解密）
lib/signer-session.js   WASM 签名会话 + 请求体构造
lib/chat-shim.js        环回聊天 shim：OpenAI ↔ QwenWork 协议转换 + 工具调用 + token 统计
lib/signer-shim.js      chat-shim 的稳定转发层（集成方从此导入）
lib/sse.js              健壮 SSE 解析 + OpenAI 分块编码 + usage 归一化
lib/runtime-identity.js Cosy-Version / machineId 的动态解析与多级回退
lib/models.js           静态模型目录（取自 App 日志的 rawModels，未臆造）
lib/loopback.js         环回访问判定（挡 DNS-rebinding）
lib/status-paths.js     host / client 共享常量
```

凭据与 REST 实现（`lib/credentials.js`、`lib/auth.js`、`lib/rest.js`、
`lib/errors.js`、`lib/dpapi.js`、`lib/api.js`）。集成层**只通过接缝消费**，
不重复实现任何解密逻辑。

## 模型目录

三个模型均取自 App 日志的 `rawModels`，无臆造：

| id | 名称 | 倍率 | 视觉 | 上下文 |
|---|---|---|---|---|
| `pro` | 高级 | 1.00x | ✅ | 1M（默认） |
| `flash` | 标准｜Qwen3.8-Flash | 0.10x | ✅ | 1M |
| `qwen3.8-max-preview` | Qwen3.8-Max | 1.10x | ✅ | 1M |

`maxOutputTokens: 32000`；可选上下文档位 200K / 400K / 1M。

## 安全边界

1. **绝不下发凭据**：状态路由只回状态摘要，token 从不跨到浏览器。
2. **错误信息脱敏**：`eyJ...` 形态 JWT、`Bearer xxx`、`token=...` 一律替换后
   才下发（卡片是浏览器渲染面，泄漏即等于泄漏到 DOM 与 devtools）。
3. **只信任环回**：Host 必须是 `127.0.0.1` / `localhost` / `[::1]`，非空
   Origin 也必须是环回 —— 挡掉 DNS-rebinding 页面。
4. **不编造数值**：上游返回 `null` 的额度字段保持缺失，不会 `Number(null) → 0`
   显示成「已用 0」。
5. **失败降级**：凭据缺失 / 加载失败时显式抛 `QwenAuthError`，卡片显示可操作
   的修复提示；`apply()` 永不抛异常（避免 DSH 红色 "Failed to load plugins" 横幅）。

## 验证

```powershell
node tools/verify-all.mjs        # 一键跑全部 5 项
```

| 项目 | 内容 |
|---|---|
| `test/web-status.test.mjs` | 12 项：脱敏、环回 403、凭据错误降级、null 不变成 0 |
| `tools/client-load-check.mjs` | 5 项：`__ModuleLoader__` 契约、slot `key`/`priority`、slot API 损坏时降级 |
| `tools/host-load-check.mjs` | host 入口可加载性 |
| `tools/apply-check.mjs` | provider 注册行为 12 项断言（含两条降级路径） |
| `tools/seam-live-check.mjs` | 端到端真实 API 实测 + JWT 不下发断言 |

端到端实测输出（合成示例，实际值随账号与消耗变化）：
```
nickname: Test User   account: testuser01   remaining: 2100   tierName: Free
```

## 安装

插件通过 Junction 挂载进 profile（源码改动即时生效，无需重新物化）：

```powershell
$d = "E:\Codex开发\DHS开发\dsh-qwen-connect"
$w = "$env:APPDATA\dsh-desktop\harness\profiles\web"
$pkg = "@xiao-hans/dsh-qwen-connect"

# 1) 依赖桥：让 CLI 侧自检可解析（运行时解析由 DSH 宿主接管，非必需）
foreach ($ns in @("@deepseek-ai", "@earendil-works")) {
  cmd /c mklink /J "$d\node_modules\$ns" `
         "$env:APPDATA\dsh-desktop\harness\profiles\node_modules\$ns"
}

# 2) 挂进 profile（scoped 包：junction 放在 node_modules\@xiao-hans\ 下）
New-Item -ItemType Directory -Force "$w\node_modules\@xiao-hans" | Out-Null
cmd /c mklink /J "$w\node_modules\$pkg" "$d"

# 3) 在 profile 的 package.json 里登记（三处，包名用 scoped 全名）
#    dependencies:      "@xiao-hans/dsh-qwen-connect": "file:./node_modules/@xiao-hans/dsh-qwen-connect"
#    dsh.profile.bundles: "@xiao-hans/dsh-qwen-connect"
#    pnpm.overrides:    "@xiao-hans/dsh-qwen-connect": "link:./node_modules/@xiao-hans/dsh-qwen-connect"
```

### 回滚

```powershell
$w = "$env:APPDATA\dsh-desktop\harness\profiles\web"
cmd /c rmdir "$w\node_modules\@xiao-hans\dsh-qwen-connect"
cmd /c rmdir "E:\Codex开发\DHS开发\dsh-qwen-connect\node_modules\@deepseek-ai"
cmd /c rmdir "E:\Codex开发\DHS开发\dsh-qwen-connect\node_modules\@earendil-works"
# 再用备份覆盖 profile 配置
Copy-Item "$w\_backup-qwen-connect-20260911-141226\package.json" "$w\package.json" -Force
Copy-Item "$w\_backup-qwen-connect-20260911-141226\cordis.patch.yml" "$w\cordis.patch.yml" -Force
```

## 流收尾语义（为什么回合不会「突然不动」）

流式推理需要区分正常收尾、截断、超时和客户端取消。shim 按以下情况给下游明确结果：

| 情况 | shim 行为 |
|---|---|
| 已开流后上游静默（首帧前 90s / 首帧后 300s） | 写带 `upstream idle timeout` 标记的 `error` 帧 + `[DONE]`，并 abort 上游；DSH pi-ai 将其归为 `TIMEOUT` |
| 上游没给 finish 帧就断流 | 有产出 → `finish_reason: "length"`（截断如实上报）；无产出 → `error` 帧 + `network_error` |
| 流里出现过 `tool_calls`，上游却标了 `stop` | 纠正为 `finish_reason: "tool_calls"`，否则下游的 agent 循环会停在工具调用之前 |
| 整回合只有思考、正文与工具调用都没有 | `error` 帧（`empty_answer`）+ `network_error`，让下游重试（实测过 340s 思考、9.5 万字符思考链、0 正文） |
| 客户端中途断开 | abort 上游请求，取消的回合立刻停止生成 |

空闲超时错误示例为 `upstream idle timeout: no data for 300000ms`。`timeout` 标记让
DSH 的 pi-ai adapter 产出 `TIMEOUT`，而不是通用的 `PI_AI_ERROR`。启用宿主
`llm-retry` 时，由 provider 的既有重试策略控制次数、退避和取消；shim 不在已经开始的流内重放请求。

`FIRST_CONTENT_TIMEOUT_MS` 保持 90 秒，首个原始数据块之后的空闲预算保持 300 秒。
任意原始上游数据块（含心跳）都会重置空闲计时，正文、思考和 token 统计各自处理。

回归测试：`node --test test/unit/stream-robustness.test.mjs test/unit/chat-shim-timeout-diagnostics.test.mjs`。
完整 `npm test` 需要 DSH 宿主提供的 peer 依赖；普通 Node 环境的依赖缺失应与插件行为失败分开判断。

### 请求级流诊断

日志位于 `os.tmpdir()/dsh-qwen-connect-trace.log`，上限 2 MiB（超过即截断重开）。
Pi 侧插件（pi-provider-qwenwork）固定写自己的 `pi-qwenwork-trace.log`：两边共用
一个文件时，本包宿主的活跃流量会在几十分钟内把 Pi 侧的事故记录轮转出上限。
单测必须用 `QWEN_CONNECT_TRACE_PATH` 把写入重定向到项目内临时目录
（`test/unit/trace-sandbox.mjs` 已统一处理），否则故障注入的伪数据会被误读成线上事故。
同一推理链的 Pi 版与 DSH 版使用一致的字段语义，以 `source` 和 `pid` 区分来源。

| 字段 | 含义 |
|---|---|
| `source` / `pid` | 本插件为 `dsh-qwen-connect`，并记录当前进程号 |
| `requestId` / `responseId` | 每个本地请求独立的 UUID；对应 SSE 的 `chatcmpl-<UUID>`，用于关联该请求的日志 |
| `upstreamSessionId` / `upstreamRequestIds` | 上游对话 ID 与白名单响应关联头；上游未返回关联头时保留空对象 |
| `lastChunkAt` / `idleMs` | 本地最后读到原始数据块的时间与距该时刻的间隔；尚无数据块时前者为 `null` |
| `upstreamChunks` / `upstreamBytes` | 原始数据块数与字节数，与解析出的正文长度分开统计 |
| `outputChars` / `thinkingChars` / `toolCallsEmitted` / `usageSeen` | 正文长度、思考长度、是否转发工具调用、是否收到有效 usage |
| `watchdogDelayMs` / `eventLoopDelayMs` | 看门狗回调相对单调时钟截止点的延迟；流读取期间事件循环延迟的最大值、p99，单位为毫秒、采样分辨率 20 ms，尚无采样时为 `null` |

超时与流结束事件包含上述流摘要；首个原始数据块另记一次事件，不逐块刷日志。
这些记录不包含原始提示词、思考正文、凭据或全部响应头。`lastChunkAt` 是本地读取时间，
不能单独证明远端模型何时停止生成；需结合上游关联 ID、事件循环延迟与链路证据定位。

## 自动续跑与用户停止的优先级

模型有时会「宣告下一步却直接 stop」，`lib/stall-detector.js` 的 `detectStall()` 判定该形态后，
`lib/stall-guard.js` 在 `agent/turn-stopping` 钩子内通过 `agent.steer(...)` 原位补一条 notice
让当前轮继续（上限 `MAX_AUTO_CONTINUES = 2`，用户本人发言后重新计数）。

> **为什么挂在 `agent/turn-stopping` 用 `agent.steer()`，而不是在 `agent/status(idle)` 里调 `followup()`**：
> `dsh-agent-loop` 在「本轮即将收尾、模型不再欠回复」时串行触发 `agent/turn-stopping`；
> 监听器在此处调用 `agent.steer()` 会把消息压入 `nextStep` 队列，状态机直接在当前轮内继续下一步，
> **不会切入 `idle`，前端 `running` 始终保持 `true`（「停止生成」按钮常驻，不会闪烁或退化成「发送」按钮）**，
> 也彻底避开了 `agent/status(idle)` 同步广播栈内重入导致 `api-session/status` 翻转成 `false` 的问题。

这条机制同时保证永远排在用户的停止之后：

| 情况 | 插件行为 |
|---|---|
| `agent/turn-stopping` 触发原位续跑 | 调用 `agent.steer()` 在本轮内继续，不切 `idle`，「停止生成」按钮常驻 |
| `signal.aborted` 为真，或回合以 `aborted` / `error` / `interrupted` 收尾 | 立即放弃续跑并置会话打断锁定，不再自动续跑 |
| 被打断之后由后台任务/通知类消息开的新回合（`source.kind !== 'user'`） | 仍不续跑——只有用户本人发言（`source.kind === 'user'`）才解除打断标记并重置预算 |
| 收件箱已有待处理输入（`agent.inbox.hasPending`） | 跳过续跑，让用户的输入优先处理，不抢在其前面 |
| 确认/复述长期规则约定（「以后遇到…我会先…」） | `detectStall` 返回 `verdict: 'standing-rule'` 否决，不误触发续跑 |
| `agent.inbox` 投影未激活导致读取抛错 | 按未知处理，维持既有续跑，观测失败不得吞掉功能 |

回归测试：`node --import ./tmp/with-dsh-sdk.mjs --test test/unit/stall-guard-stop.test.mjs`。
判定口径本身（哪些正文算半途停止）由 `test/unit/stall-guard.test.mjs` 锁定。

## 已知限制

1. **仅 Windows**：凭据解密走 Windows DPAPI。
2. **工具调用已透传，视觉输入仍不支持**：`tool_calls` 分片（含 `index`/`id`/
   `function`）原样转成 OpenAI 形状，收尾时把上游常标的 `stop` 纠正为
   `tool_calls`；图片输入仍会被 shim 丢弃（`toQwenWorkMessages()` 只保留
   `type: 'text'` 块）。
3. **DPAPI 依赖 PowerShell 兜底**：本机未装 `koffi`/`ffi-napi`，走 PowerShell
   子进程（每进程约几十毫秒）。
4. **模型目录是静态的**：`/api/v2/model/list` 需要 WASM 签名（403），
   目前用内置的三模型目录，不动态拉取。
5. **`quota.total` 对 Free 套餐为 null**：卡片按「未提供」处理，不显示 0%。
6. **签名依赖官方 WASM**：`research/wasm.bin` 是从官方 App 产物提取的签名模块，
   由 `package.json` 的 `files` 字段**随包发布**（npm 包与 dist 包内都带），换机器
   无需重新提取；需要整体重提时用 `node research/wasm-extract.mjs`。
7. **`Cosy-Version` 动态解析**：优先读 App 产物里 SDK 的 `COSY_VERSION`
   常量（实测 `1.1.32`），失败时回退安装目录版本号，最后回退常量。
   来源会记在 `signerSession.describe().cosyVersion.source` 里。

## 聊天接入架构（阶段 A-2）

```
DSH / pi-ai ──OpenAI 协议──▶ 环回 shim ──WASM 签名+加密──▶ gateway.qwenwork.cn
            ◀──OpenAI SSE──           ◀──双层信封 SSE──
```

- shim 由 `lib/chat-shim.js` 实现，监听 `127.0.0.1` 随机端口，**仅接受环回
  请求**（Host/Origin 双校验，挡 DNS-rebinding）。
- provider 的 `baseUrl` 在 shim 就绪后指向
  `http://127.0.0.1:<port>/v1/chat/completions`。
- **签名头 `Authorization: Bearer COSY.<...>` 由官方 WASM 生成，绝不能被
  `Bearer <accessToken>` 覆盖**（覆盖即 403 Signature invalid）。

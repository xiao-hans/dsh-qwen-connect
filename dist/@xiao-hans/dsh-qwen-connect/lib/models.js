/**
 * 静态内置的模型目录。
 *
 * 来源：QwenWorkCN 桌面 App 日志中的模型列表（`rawModels` 字段，实测取得）。
 * 阶段 B 不依赖 upstream 动态拉取，保证离线时 provider 不会是空的。
 *
 * 三个模型均取自 App 实际返回，未臆造：
 *   pro                  — 高级（默认模型，isDefault: true）
 *   flash                — 标准｜Qwen3.8-Flash（tags: ["is_recommend"]）
 *   qwen3.8-max-preview  — Qwen3.8-Max（isNew: true，官方描述「千问最强模型」）
 *
 * @module dsh-qwen-connect/models
 */

/** 本插件拥有的 provider 路由 id。 */
export const QWENWORK_PROVIDER = 'qwenwork';

/**
 * 上下文窗口与输出上限。
 *
 * ⚠️ **`MAX_INPUT_TOKENS` 必须与发给上游的 `model_config.max_input_tokens` 一致**
 * （见 `signer-session.js` 的 `buildInferBody`）。
 *
 * 真实上限的确定过程（教训记录）：
 *   1. App 日志表格列标注「1M」
 *   2. Buddy2api 的 `model_config.max_input_tokens` 写 180000
 *   3. 曾照搬 180000 —— **实测证明是错的**：
 *      probe-context-limit*.mjs 的对照实验显示
 *      ≈150K/200K/400K/700K/850K/1.0M/1.2M tokens 全部被上游接受，
 *      ≈1.5M 才被拒（"Error in upstream response"）。
 *      → 真实上限在 1.2M~1.5M 之间，「1M」是保守而合理的声明值。
 *
 * 声明与实现不一致是本项目反复出现的一类缺陷；这次是**照搬外部值未实测**。
 */
export const MAX_INPUT_TOKENS = 1_000_000;
/** 单次回复的输出上限（与 `parameters.max_tokens` 一致）。 */
export const MAX_OUTPUT_TOKENS = 32000;

/**
 * 静态回退目录。
 *
 * 每条都直接取自 App 日志的 `rawModels`，未臆造任何字段：
 * `priceFactor` → `billingRate`，`isVl` → `supportsImages`，
 * `defaultContextWindow` → `contextWindow`，
 * `availableContextWindows` → 原样保留（三档：200K / 400K / 1M）。
 *
 * @type {Array<{
 *   id: string,
 *   name: string,
 *   description: string,
 *   billingRate: number,
 *   supportsImages: boolean,
 *   contextWindow: number,
 *   availableContextWindows: number[],
 *   maxTokens: number,
 *   isDefault?: boolean,
 *   isRecommended?: boolean,
 *   isNew?: boolean,
 * }>}
 */
/**
 * 上游模型**具备视觉能力**（App 的 `rawModels` 里 `is_vl: true`），
 * 因此这里如实声明 `supportsImages: true`。
 *
 * 但声明只是前提之一——DSH 走图片路径还需要**两个条件同时满足**：
 *   ① 模型描述符声明 image 模态
 *   ② pi-ai 配置了 `resolveAttachments`（DSH 的持久化附件服务）
 *
 * 若只有 ① 没有 ②，DSH 会直接抛
 * `pi-ai image input requires the durable attachment service`（连文本对话都失败）；
 * 若只有 ② 没有 ①，图片会被投影成文本占位符，用户传了图却等于没传。
 *
 * 因此 `toPiModel` 接受 `{ supportsImages }` 覆盖：**由调用方按附件服务
 * 是否可用传入**，保证「声明」与「能力」始终一致（见 lib/index.js 的
 * `imageDepsFrom`）。
 */
export const FALLBACK_QWENWORK_MODELS = [
  {
    id: 'pro',
    shortName: '高级',
    billingRate: 1,
    supportsImages: true,
    contextWindow: MAX_INPUT_TOKENS,
    availableContextWindows: [MAX_INPUT_TOKENS],
    maxTokens: MAX_OUTPUT_TOKENS,
    isDefault: true,
  },
  {
    id: 'flash',
    // pi 等宿主的模型选择器只渲染描述符 `id`，干巴巴的 `flash` 看不出这是
    // 千问 3.8。展示 id 用官方全名（上游目录 display_name 实测为
    // 「标准｜Qwen3.8-Flash」）；请求路由前由 normalizeModelKey() 归一化
    // 回上游 key `flash`，两边都不破。
    displayNameId: 'qwen3.8-flash',
    shortName: '标准｜Qwen3.8-Flash',
    billingRate: 0.1,
    supportsImages: true,
    contextWindow: MAX_INPUT_TOKENS,
    availableContextWindows: [MAX_INPUT_TOKENS],
    maxTokens: MAX_OUTPUT_TOKENS,
    isRecommended: true,
  },
  {
    id: 'qwen3.8-max-preview',
    shortName: 'Qwen3.8-Max',
    billingRate: 1.1,
    supportsImages: true,
    contextWindow: MAX_INPUT_TOKENS,
    availableContextWindows: [MAX_INPUT_TOKENS],
    maxTokens: MAX_OUTPUT_TOKENS,
    isNew: true,
  },
];

// ---------------------------------------------------------------------------
// 生效目录（动态优先，静态兜底）
// ---------------------------------------------------------------------------

/**
 * 当前生效的模型目录。
 *
 * 为什么状态放在 models.js 而不是拉取模块里：`normalizeModelKey()`（chat-shim
 * 路由用）、`catalogForCard()`（卡片用）、`toPiModel()`（选择器用）三个消费点
 * 分散在两个模块，且 chat-shim 的调用签名早已固定为单参数。把「哪份目录生效」
 * 收敛在这里，拉取模块只负责写入，消费点无需改签名即可同步看到新模型；
 * 也避免 models.js ← model-catalog.js 的循环 import。
 *
 * 失败语义：上游拉取失败**不清空**已有目录——保留上一次成功的真实结果并标记
 * stale，比退回静态表更接近事实（静态表可能已不含上游在售模型）。
 */
let activeCatalog = FALLBACK_QWENWORK_MODELS;
let catalogMeta = { source: 'fallback', fetchedAt: null, stale: false, error: null };

/** 读当前生效目录（只读用途，调用方不得原地修改）。 */
export function getActiveCatalog() {
  return activeCatalog;
}

/** 目录来源元信息，供卡片如实标注「上游实时 / 静态兜底 / 已过期」。 */
export function getCatalogMeta() {
  return { ...catalogMeta, count: activeCatalog.length };
}

/**
 * 用上游目录替换生效目录。
 *
 * @param {Array<object>} entries 已归一化的条目（见 model-catalog.js）
 * @param {{ fetchedAt?: string }} [meta]
 * @returns {boolean} 是否真的替换了（空数组一律拒绝，避免把 provider 清空）
 */
export function setActiveCatalog(entries, meta = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return false;
  activeCatalog = entries;
  catalogMeta = {
    source: 'upstream',
    fetchedAt: meta.fetchedAt ?? new Date().toISOString(),
    stale: false,
    error: null,
  };
  return true;
}

/**
 * 记录一次拉取失败。**不动条目本身**，只把状态标脏，让卡片能说明
 * 「显示的是上次成功的目录」而不是假装实时。
 *
 * @param {unknown} error
 */
export function markCatalogStale(error) {
  catalogMeta = {
    ...catalogMeta,
    stale: true,
    error: error instanceof Error ? error.message : String(error ?? 'unknown'),
  };
}

/**
 * 退回静态兜底目录并清空来源元信息（供测试与卸载使用，与 perf.js 的
 * resetPerf() 同一惯例）。正常拉取失败**不该**调它——保留上一次成功的
 * 真实目录比退回可能已过期的静态表更接近事实。
 */
export function resetCatalog() {
  activeCatalog = FALLBACK_QWENWORK_MODELS;
  catalogMeta = { source: 'fallback', fetchedAt: null, stale: false, error: null };
}

// ---------------------------------------------------------------------------
// 用户偏好（开关与默认项）——持久化由 index.js 的设置存储接缝负责
// ---------------------------------------------------------------------------

/**
 * 生效的模型偏好。
 *
 * 为什么状态放这里而不是 index.js：`toPiModel`（选择器）、`catalogForCard`
 * （卡片）、`buildModels`（provider）三个消费点都只 import models.js，
 * 偏好放在它们共同的下游才能一次生效、不会出现「卡片灰了但选择器还在」。
 * 与 `activeCatalog` 同构：写入方唯一（`setModelPreferences`），读取方只读。
 *
 * ⚠️ disabled 与 defaultModel 存的是**归一化后的上游短 key**（`normalizeModelKey`
 * 的结果，如 `flash`），不是宿主展示 id。上游目录每次刷新都会重建条目对象，
 * 只有 key 是跨刷新稳定的标识——存 id 会让偏好在下一次拉取后静默失效。
 *
 * @type {{ disabled: Set<string>, defaultModel: string | null }}
 */
let modelPrefs = { disabled: new Set(), defaultModel: null };

/**
 * 写入用户偏好。字段缺省表示「不动」。
 *
 * @param {{ disabled?: Iterable<string>, defaultModel?: string | null }} prefs
 *        `defaultModel` 传 `null` 表示清除用户选择，退回上游/静态目录的默认项。
 */
export function setModelPreferences(prefs = {}) {
  if (Array.isArray(prefs.disabled) || prefs.disabled instanceof Set) {
    modelPrefs = {
      ...modelPrefs,
      disabled: new Set(Array.from(prefs.disabled, (key) => String(key))),
    };
  }
  if ('defaultModel' in prefs) {
    const value = prefs.defaultModel;
    modelPrefs = {
      ...modelPrefs,
      defaultModel: typeof value === 'string' && value !== '' ? value : null,
    };
  }
  return { disabled: [...modelPrefs.disabled], defaultModel: modelPrefs.defaultModel };
}

/** 清空偏好（测试与卸载用，与 resetCatalog() 同惯例）。 */
export function resetModelPreferences() {
  modelPrefs = { disabled: new Set(), defaultModel: null };
}

/** 该模型是否被用户开启。目录刷新后不在目录里的旧禁用项自然失效，无需清理。 */
export function isModelEnabled(info) {
  return info !== null && info !== undefined && !modelPrefs.disabled.has(info.id);
}

/**
 * 按用户偏好过滤后的目录：剔除关闭项，并把 `isDefault` 重写成生效默认。
 *
 * 给 provider 的 `getModels()` 用——选择器只能看到启用的模型，且「默认」标记
 * 与卡片一致。条目按需浅拷贝，**绝不改原对象**：activeCatalog 同时被卡片
 * （含关闭项）与 chat-shim 读取，原地改写会让状态互相污染。
 *
 * @returns {Array<object>}
 */
export function preferredCatalog() {
  const effective = effectiveDefaultKey();
  return getActiveCatalog()
    .filter((model) => isModelEnabled(model))
    .map((model) => {
      const shouldDefault = model.id === effective;
      return (model.isDefault === true) === shouldDefault
        ? model
        : { ...model, isDefault: shouldDefault };
    });
}

/**
 * 当前生效的默认模型 key。
 *
 * 优先级：用户选定 → 上游/静态目录里标了 isDefault 的 → 第一个**启用的** →
 * 第一个。用户选项若已被关掉或已从上游下架，必须回落——否则宿主会拿着一个
 * 不在选择器里的模型发请求。
 *
 * @returns {string | null}
 */
export function effectiveDefaultKey() {
  const candidates = getActiveCatalog();
  if (modelPrefs.defaultModel !== null) {
    const picked = candidates.find(
      (m) => m.id === modelPrefs.defaultModel || m.displayNameId === modelPrefs.defaultModel,
    );
    if (picked !== undefined && isModelEnabled(picked)) return picked.id;
  }
  const declared = candidates.find((m) => m.isDefault === true && isModelEnabled(m));
  if (declared !== undefined) return declared.id;
  const firstEnabled = candidates.find((m) => isModelEnabled(m));
  return (firstEnabled ?? candidates[0])?.id ?? null;
}

/**
 * 按宿主 id / 展示 id / 上游 key 查目录条目（先查生效目录，再查静态回退）。
 *
 * @param {string} model
 * @returns {object | undefined}
 */
export function findModelInfo(model) {
  if (typeof model !== 'string' || model === '') return undefined;
  return (
    activeCatalog.find((m) => m.id === model || m.displayNameId === model) ??
    FALLBACK_QWENWORK_MODELS.find((m) => m.id === model || m.displayNameId === model)
  );
}

/**
 * 把宿主传来的模型标识归一化回**上游 model_config.key**。
 *
 * 背景：部分宿主（如 pi）的选择器只渲染描述符 `id`，因此目录条目允许声明
 * `displayNameId`（人类可读全名，如 `qwen3.8-flash`）作为对外 id；请求进
 * shim 后必须换回上游认得的短 key（`flash`）。未声明 displayNameId 的模型
 * 两种写法（短 key 与自身 id）都接受；目录里查不到的一律原样透传，
 * 交给上游自行裁决（不吞新模型的接入路径）。
 *
 * @param {string} model 宿主 id（displayNameId 或上游 key）
 * @returns {string} 上游 model_config.key
 */
export function normalizeModelKey(model) {
  if (typeof model !== 'string' || model === '') return model;
  const info = findModelInfo(model);
  return info === undefined ? model : info.id;
}

/**
 * 把倍率格式化成选择器里显示的文本。
 *
 * 形态对齐 WorkBuddy（`Hy3 · x0.00 · 限时免费`）：
 *   - 0 倍率 → `免费`
 *   - 其它   → `x1.00` / `x0.10` / `x1.10`
 *
 * @param {number} rate
 * @returns {string}
 */
export function formatRate(rate) {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return '';
  if (rate === 0) return '免费';
  return `x${rate.toFixed(2)}`;
}

/**
 * 生成模型选择器里显示的名字：`名称 · 倍率 · 标记`。
 *
 * ⚠️ 这是**唯一的显示名来源**——DSH 的模型选择器渲染的就是 pi-ai 模型描述符
 * 的 `name` 字段（见 dsh-workbuddy-connect 的 `toPiModel`，它直接透传
 * 上游 `name`，而该值本身就形如 `Hy3 · x0.00 · 限时免费`）。
 * 倍率必须拼进 `name` 才会出现在选择器里；单独放 `billingRate` 字段
 * 只有设置卡片能看到。
 *
 * @param {typeof FALLBACK_QWENWORK_MODELS[number]} info
 * @returns {string}
 */
export function displayName(info) {
  const parts = [info.shortName ?? info.id];
  const rate = formatRate(info.billingRate);
  if (rate !== '') parts.push(rate);
  if (info.isDefault === true) parts.push('默认');
  if (info.isRecommended === true) parts.push('推荐');
  if (info.isNew === true) parts.push('新');
  // 上游促销徽章（如「限时2折」）如实透传：它是上游 promotion.badge 的原文，
  // 不是插件算出来的折扣。没有促销就不加这一段。
  if (typeof info.promotionLabel === 'string' && info.promotionLabel !== '') {
    parts.push(info.promotionLabel);
  }
  return parts.join(' · ');
}

/**
 * 卡片与选择器共用的描述文案。
 *
 * @param {typeof FALLBACK_QWENWORK_MODELS[number]} info
 * @returns {string}
 */
function describeModel(info) {
  const rate = formatRate(info.billingRate);
  const ctx = info.contextWindow >= 1000000 ? '1M' : `${Math.round(info.contextWindow / 1000)}K`;
  // 模态按目录声明如实写：上游 is_vl 为真就是图文，不能一律写「仅文本」。
  const modality = info.supportsImages === true ? '图文' : '仅文本';
  return [modality, ctx, rate === '' ? undefined : rate === '免费' ? '免费' : rate]
    .filter(Boolean)
    .join(' · ');
}

/** 供卡片展示的精简模型行。 */
export function catalogForCard() {
  // 默认徽章按**生效默认**打（用户选 > 上游标 > 首个启用），不是目录原始
  // isDefault——用户在卡片上改默认后，卡片必须显示改后的值。
  const effective = effectiveDefaultKey();
  return getActiveCatalog().map((model) => ({
    id: model.id,
    // 卡片显示短名（倍率已单独成列），选择器则用带倍率的长名。
    name: model.shortName ?? model.id,
    description: describeModel(model),
    rate: model.billingRate,
    // 被关掉的模型仍在列表里（卡片要能重新打开它），只标注状态。
    enabled: isModelEnabled(model),
    ...(model.id === effective ? { isDefault: true } : {}),
    ...(model.isRecommended === true ? { isRecommended: true } : {}),
    ...(model.isNew === true ? { isNew: true } : {}),
    ...(typeof model.promotionLabel === 'string' && model.promotionLabel !== ''
      ? { promotionLabel: model.promotionLabel }
      : {}),
  }));
}

/**
 * 把静态目录条目转成 pi-ai 的模型描述符。
 *
 * `name` 是**模型选择器显示的那一行文本**——因此这里用 `displayName()`
 * 把倍率拼进去（形如 `高级 · x1.00 · 默认`），否则选择器只会显示干巴巴的
 * 名称，用户看不到谁贵谁便宜。
 *
 * @param {typeof FALLBACK_QWENWORK_MODELS[number]} info
 * @param {string} baseUrl 该 provider 的请求基址
 * @param {{ supportsImages?: boolean }} [opts]
 *        `supportsImages` 覆盖：**由调用方按附件服务是否可用传入**。
 *        不传则沿用目录里的声明。这样当宿主没有附件服务时，模态会退回
 *        `['text']`，避免 DSH 走图片路径后抛
 *        `pi-ai image input requires the durable attachment service`。
 */
export function toPiModel(info, baseUrl, opts = {}) {
  const supportsImages = opts.supportsImages ?? info.supportsImages === true;
  return {
    // 部分宿主（pi）的选择器只渲染描述符 `id`，这类宿主传 `displayId: true`
    // 换用人类可读全名；请求回落到 shim 时由 normalizeModelKey() 换回上游
    // 认识的短 key，两侧契约都不破。DSH 侧选择器显示的是 `name`，故保持
    // 原 id 不变，不动已持久化的模型选择记录。
    id: opts.displayId === true ? (info.displayNameId ?? info.id) : info.id,
    name: displayName(info),
    api: 'openai-completions',
    provider: QWENWORK_PROVIDER,
    baseUrl,
    input: supportsImages ? ['text', 'image'] : ['text'],
    /**
     * 上游确实返回思维链，置 true 让 pi-ai 把 `reasoning_content` 识别为
     * 独立的 thinking 块，而不是混进正文渲染。
     *
     * 实测依据：glm-5.2 在 `choices[0].delta.reasoning_content` 里给出思维链
     * （见 research/probe-reasoning-vs-content.mjs）。此前置 false 时，思维链
     * 会被当作普通 text 输出，用户会在回答里看到模型的内心独白。
     */
    reasoning: true,
    /**
     * 思考开关握手（QwenWork 网关不支持，2026-11-08 实测）：
     *
     * pi-ai 对 openai-completions API 按 `compat.thinkingFormat` 决定发不发
     * `enable_thinking`（qwen / qwen-chat-template 两种格式）。不声明时
     * auto-detect 会因 baseUrl 是 127.0.0.1 环回 shim 而落到默认 openai，
     * 宿主设 thinking="off" 只是不发 reasoning_effort，请求体里没有任何
     * 关思考字段。
     *
     * 实测（research/buddy2api-probes/probe-disable-thinking.mjs：5 变体对照；
     * probe-flash-thinking.mjs：flash 模型 3 变体）：QwenWork 网关对
     * `enable_thinking:false`、`chat_template_kwargs.enable_thinking:false`、
     * `reasoning_effort:"none"`、`is_reasoning:false` 全部无视，思考照发。
     * 所以这里**刻意不声明** compat.thinkingLevelMap / thinkingFormat：发了
     * 也是无效字段，反而让 pi-ai 以为关思考已生效。上游强制思考，
     * 宿主端的正确姿态是容忍 thinking 通道（pi-hermes-memory 的
     * thinking-channel recovery 那样从 thinking 块恢复答案）。
     */
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
  };
}

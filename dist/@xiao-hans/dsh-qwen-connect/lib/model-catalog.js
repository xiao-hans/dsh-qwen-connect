/**
 * 动态模型目录：向上游拉取真实在售模型，替换静态内置表。
 *
 * ── 为什么现在能做 ────────────────────────────────────────────────
 * README 长期写着「动态模型目录 ❌ 静态内置（/api/v2/model/list 需签名）」。
 * 缺的从来不是签名能力——`signer-session.js` 早就有通用通道
 * `signRequest({ path, method, mode })`，只是没人把它接到这个端点上。
 *
 * 实测（research/probe-model-catalog.mjs，2026-11-18，只读 GET、不走推理）：
 *   mode='auth' → `GET {endpoint}/algo/api/v2/model/list` **HTTP 200**，
 *   返回按场景分组的对象 `{chat, developer, assistant, inline, quest, nap,
 *   qwork, experts, qwake, byok_teams, byok_enterprise}`，本账号只有 `qwork`
 *   非空，三条：flash(0.1) / pro(1, 默认) / qwen4-max(0.4, 新, 限时2折)。
 *   静态表里的 `qwen3.8-max-preview` 上游已不再返回——这正是静态表会过期的证据。
 *
 * ── 红线 ──────────────────────────────────────────────────────────
 *   - 拉取失败**绝不抛给宿主**：provider 必须始终有模型（apply() 永不抛）。
 *   - 上游没给的数字一律不编造：price_factor 缺失就不显示倍率，
 *     context_config 缺失才退回实测保守值 MAX_INPUT_TOKENS。
 *   - 只读端点，不构造推理请求，不消耗额度。
 *
 * @module dsh-qwen-connect/model-catalog
 */
import { createSignerSession } from './signer-session.js';
import { resolveGatewayEndpoint, relaxTlsForVpc } from './endpoint.js';
import {
  MAX_INPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  setActiveCatalog,
  markCatalogStale,
  getCatalogMeta,
} from './models.js';

/** 上游模型目录端点（签名器会自行补 `/algo` 前缀）。 */
export const CATALOG_PATH = '/api/v2/model/list';

/** 成功后的缓存有效期：10 分钟。目录变更以天计，不需要更密。 */
export const CATALOG_TTL_MS = 10 * 60 * 1000;

/** 失败后的重试间隔：1 分钟。避免上游故障时每次读状态都重打。 */
export const CATALOG_RETRY_MS = 60 * 1000;

/** 单次拉取的超时。目录是轻量 JSON，20s 足够。 */
export const CATALOG_TIMEOUT_MS = 20 * 1000;

/**
 * 场景取值优先级。
 *
 * 上游按场景分组返回，千问办公桌面 App 用的是 `qwork`（业务产品
 * `qoder_work`）。其余场景对本账号实测为空，但保留优先级链，
 * 免得上游哪天把模型挪到别的场景就整表拉空。
 */
export const SCENE_PRIORITY = ['qwork', 'assistant', 'chat', 'developer', 'inline', 'quest', 'nap'];

/**
 * 从上游响应里挑出本插件该用的那一组模型。
 *
 * @param {any} payload
 * @returns {Array<object>} 原始条目（未归一化）
 */
export function pickSceneModels(payload) {
  if (payload === null || typeof payload !== 'object') return [];
  for (const scene of SCENE_PRIORITY) {
    const list = payload[scene];
    if (Array.isArray(list) && list.length > 0) return list;
  }
  return [];
}

/** 取有限正数，否则 undefined。 */
function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 取有限数（**包括 0**）——排序键的 0 是合法首位，不能当缺失。 */
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 解析 `context_config`：`{ "1M": {token_count, is_default}, "200K": {...} }`。
 *
 * @param {any} config
 * @returns {{ defaultWindow: number|undefined, windows: number[] }}
 */
export function readContextConfig(config) {
  const windows = [];
  let defaultWindow;
  if (config !== null && typeof config === 'object') {
    for (const entry of Object.values(config)) {
      const count = positiveNumber(entry?.token_count);
      if (count === undefined) continue;
      windows.push(count);
      if (entry?.is_default === true) defaultWindow = count;
    }
  }
  windows.sort((a, b) => a - b);
  return { defaultWindow, windows };
}

/**
 * 上游条目 → 本插件目录条目。
 *
 * 字段映射（与静态表同构，消费点无需分支）：
 *   key → id、display_name → shortName、price_factor → billingRate、
 *   is_vl → supportsImages、is_reasoning → isReasoning、
 *   context_config → contextWindow / availableContextWindows、
 *   promotion.badge → promotionLabel（上游原文，不自行计算折扣）。
 *
 * @param {any} raw
 * @returns {object | null} 非法条目返回 null（缺 key 就无法路由）
 */
export function normalizeUpstreamModel(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const id = typeof raw.key === 'string' && raw.key !== '' ? raw.key : null;
  if (id === null) return null;
  // enable 显式为 false 表示上游下架，不该出现在选择器里；缺失按可用处理。
  if (raw.enable === false) return null;

  const { defaultWindow, windows } = readContextConfig(raw.context_config);
  const rate = typeof raw.price_factor === 'number' && Number.isFinite(raw.price_factor)
    ? raw.price_factor
    : undefined;
  const badge = raw.promotion?.active === true ? raw.promotion?.badge : null;
  const promotionLabel =
    badge !== null && typeof badge === 'object'
      ? (typeof badge.zh === 'string' && badge.zh !== '' ? badge.zh
        : typeof badge.en === 'string' && badge.en !== '' ? badge.en : undefined)
      : undefined;
  const sortOrder = finiteNumber(raw.appSortOrder) ?? finiteNumber(raw.order);

  return {
    id,
    shortName: typeof raw.display_name === 'string' && raw.display_name !== '' ? raw.display_name : id,
    // 倍率缺失时**不填 0**：0 会被 formatRate 渲染成「免费」，那是编造。
    ...(rate === undefined ? {} : { billingRate: rate }),
    supportsImages: raw.is_vl === true,
    isReasoning: raw.is_reasoning === true,
    // context_config 缺失才用实测保守值（见 models.js MAX_INPUT_TOKENS 的实测记录）。
    contextWindow: defaultWindow ?? (windows.length > 0 ? windows[windows.length - 1] : MAX_INPUT_TOKENS),
    availableContextWindows: windows.length > 0 ? windows : [MAX_INPUT_TOKENS],
    maxTokens: MAX_OUTPUT_TOKENS,
    ...(raw.is_default === true ? { isDefault: true } : {}),
    ...(raw.is_new === true ? { isNew: true } : {}),
    ...(Array.isArray(raw.tags) && raw.tags.includes('is_recommend') ? { isRecommended: true } : {}),
    ...(promotionLabel === undefined ? {} : { promotionLabel }),
    ...(sortOrder === undefined ? {} : { sortOrder }),
  };
}

/**
 * 归一化整份响应：过滤非法条目 + 按上游排序键稳定排序。
 *
 * @param {any} payload
 * @returns {Array<object>}
 */
export function normalizeCatalog(payload) {
  const entries = [];
  for (const raw of pickSceneModels(payload)) {
    const info = normalizeUpstreamModel(raw);
    if (info !== null) entries.push(info);
  }
  // 上游给了排序键就照它的顺序（默认模型不一定排第一）；没给的保持原序。
  return entries
    .map((info, index) => ({ info, index }))
    .sort((a, b) => (a.info.sortOrder ?? a.index) - (b.info.sortOrder ?? b.index))
    .map(({ info }) => info);
}

/**
 * 拉一次上游目录。**会抛**——调用方（createCatalogRefresher）负责兜住。
 *
 * @param {{
 *   getCredential: () => Promise<any>,
 *   endpoint?: string,
 *   identity?: { installRoot?: string, env?: NodeJS.ProcessEnv },
 *   signerFactory?: typeof createSignerSession,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 * }} deps
 * @returns {Promise<Array<object>>} 归一化后的目录条目
 */
export async function fetchModelCatalog(deps) {
  const credential = await deps.getCredential();
  const endpoint = deps.endpoint ?? resolveGatewayEndpoint(credential);
  const doFetch = deps.fetchImpl ?? relaxTlsForVpc(endpoint);
  const factory = deps.signerFactory ?? createSignerSession;
  const session = await factory({
    credential,
    endpoint,
    ...(deps.identity === undefined ? {} : { identity: deps.identity }),
  });
  try {
    // mode='auth' 是实测命中的那一档（probe-model-catalog.mjs）。
    const signed = session.signRequest({ path: CATALOG_PATH, method: 'GET', mode: 'auth' });
    const response = await doFetch(signed.url, {
      method: 'GET',
      headers: signed.headers,
      signal: AbortSignal.timeout(deps.timeoutMs ?? CATALOG_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`model/list HTTP ${response.status}`);
    }
    const entries = normalizeCatalog(await response.json());
    if (entries.length === 0) throw new Error('model/list returned no usable model');
    return entries;
  } finally {
    try {
      session.dispose?.();
    } catch {
      /* 释放失败不该掩盖拉取结果 */
    }
  }
}

/**
 * 带缓存与去重的目录刷新器。
 *
 * `getModels()` 在宿主侧是同步的，所以刷新只能后台进行：`ensureFresh()` 判断
 * 是否到期，到期就 fire-and-forget 拉一次，下一次读目录自然拿到新值。
 *
 * @param {{
 *   getCredential: () => Promise<any>,
 *   ttlMs?: number,
 *   retryMs?: number,
 *   logger?: { warn?: Function, info?: Function },
 *   now?: () => number,
 * } & Omit<Parameters<typeof fetchModelCatalog>[0], 'getCredential'>} deps
 */
export function createCatalogRefresher(deps) {
  const ttlMs = deps.ttlMs ?? CATALOG_TTL_MS;
  const retryMs = deps.retryMs ?? CATALOG_RETRY_MS;
  const now = deps.now ?? Date.now;
  const log = deps.logger ?? {};
  let inFlight = null;
  let nextAttemptAt = 0;

  /** 真正拉取；永不抛，失败只标脏。 */
  function refresh() {
    if (inFlight !== null) return inFlight;
    nextAttemptAt = now() + retryMs;
    inFlight = fetchModelCatalog(deps)
      .then((entries) => {
        const applied = setActiveCatalog(entries);
        if (applied) {
          nextAttemptAt = now() + ttlMs;
          log.info?.(`dsh-qwen-connect: model catalog refreshed (${entries.length} models)`);
        }
        return getCatalogMeta();
      })
      .catch((error) => {
        markCatalogStale(error);
        log.warn?.(
          'dsh-qwen-connect: model catalog refresh failed (keeping last known catalog)',
          error instanceof Error ? error.message : String(error),
        );
        return getCatalogMeta();
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  /** 到期才拉；不阻塞调用方，也不抛。 */
  function ensureFresh() {
    if (inFlight !== null || now() < nextAttemptAt) return false;
    void refresh();
    return true;
  }

  return { refresh, ensureFresh, getMeta: getCatalogMeta };
}

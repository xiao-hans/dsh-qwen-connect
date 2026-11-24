// test/unit/model-catalog.test.mjs
//
// 动态模型目录的口径锁定。
// 背景：/api/v2/model/list 实测可取（mode='auth'，HTTP 200），静态表会过期
// （上游已用 qwen4-max 取代 qwen3.8-max-preview）。
// 关键原则：
//   ① 上游没给的数字不编造（price_factor 缺失 ≠ 免费）；
//   ② 拉取失败不清空目录、不抛给宿主；
//   ③ 空目录一律拒绝写入，provider 不能变空。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CATALOG_PATH,
  SCENE_PRIORITY,
  pickSceneModels,
  readContextConfig,
  normalizeUpstreamModel,
  normalizeCatalog,
  fetchModelCatalog,
  createCatalogRefresher,
} from '../../lib/model-catalog.js';
import {
  FALLBACK_QWENWORK_MODELS,
  MAX_INPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  getActiveCatalog,
  getCatalogMeta,
  setActiveCatalog,
  markCatalogStale,
  resetCatalog,
  findModelInfo,
  normalizeModelKey,
  catalogForCard,
  displayName,
} from '../../lib/models.js';

/** 取自 research/probe-model-catalog.mjs 的真实响应形状（2026-11-18）。 */
const REAL_PAYLOAD = {
  chat: [],
  developer: [],
  assistant: [],
  qwork: [
    {
      key: 'flash',
      display_name: '标准',
      is_vl: true,
      is_reasoning: false,
      enable: true,
      is_default: false,
      price_factor: 0.1,
      appSortOrder: 0,
      context_config: {
        '1M': { token_count: 1000000, is_default: true },
        '200K': { token_count: 200000 },
        '400K': { token_count: 400000 },
      },
    },
    {
      key: 'pro',
      display_name: '高级',
      is_vl: true,
      is_reasoning: false,
      enable: true,
      is_default: true,
      price_factor: 1,
      appSortOrder: 1,
      context_config: { '1M': { is_default: true, token_count: 1000000 } },
    },
    {
      key: 'qwen4-max',
      display_name: 'Qwen4-Max',
      is_vl: true,
      is_reasoning: true,
      enable: true,
      is_new: true,
      price_factor: 0.4,
      appSortOrder: 3,
      context_config: { '1M': { is_default: true, token_count: 1000000 } },
      promotion: { active: true, badge: { en: '80% Off Now', zh: '限时2折' } },
    },
  ],
  experts: [],
};

test('pickSceneModels：qwork 优先，空场景跳过', () => {
  assert.equal(SCENE_PRIORITY[0], 'qwork');
  assert.equal(pickSceneModels(REAL_PAYLOAD).length, 3);
  assert.equal(pickSceneModels({ qwork: [], assistant: [{ key: 'x' }] })[0].key, 'x');
  assert.deepEqual(pickSceneModels(null), []);
  assert.deepEqual(pickSceneModels({ qwork: [] }), []);
});

test('readContextConfig：默认档与全部档位分开取，升序排列', () => {
  const { defaultWindow, windows } = readContextConfig(REAL_PAYLOAD.qwork[0].context_config);
  assert.equal(defaultWindow, 1000000);
  assert.deepEqual(windows, [200000, 400000, 1000000]);
  assert.deepEqual(readContextConfig(null), { defaultWindow: undefined, windows: [] });
});

test('normalizeUpstreamModel：真实条目逐字段映射', () => {
  const info = normalizeUpstreamModel(REAL_PAYLOAD.qwork[2]);
  assert.equal(info.id, 'qwen4-max');
  assert.equal(info.shortName, 'Qwen4-Max');
  assert.equal(info.billingRate, 0.4);
  assert.equal(info.supportsImages, true);
  assert.equal(info.isReasoning, true);
  assert.equal(info.contextWindow, 1000000);
  assert.equal(info.maxTokens, MAX_OUTPUT_TOKENS);
  assert.equal(info.isNew, true);
  assert.equal(info.promotionLabel, '限时2折');
});

test('normalizeUpstreamModel：price_factor 缺失时不填 0（0 会被渲染成「免费」）', () => {
  const info = normalizeUpstreamModel({ key: 'm', display_name: 'M' });
  assert.equal('billingRate' in info, false, '缺失必须保持缺失，不能编造倍率');
  assert.equal(displayName(info), 'M');
});

test('normalizeUpstreamModel：price_factor 为 0 才是真免费', () => {
  const info = normalizeUpstreamModel({ key: 'm', display_name: 'M', price_factor: 0 });
  assert.equal(info.billingRate, 0);
  assert.match(displayName(info), /免费/);
});

test('normalizeUpstreamModel：无 context_config 才退回实测保守值', () => {
  const info = normalizeUpstreamModel({ key: 'm' });
  assert.equal(info.contextWindow, MAX_INPUT_TOKENS);
  assert.deepEqual(info.availableContextWindows, [MAX_INPUT_TOKENS]);
});

test('normalizeUpstreamModel：缺 key 或 enable:false 的条目被丢弃', () => {
  assert.equal(normalizeUpstreamModel({ display_name: 'no key' }), null);
  assert.equal(normalizeUpstreamModel({ key: 'off', enable: false }), null);
  assert.equal(normalizeUpstreamModel(null), null);
});

test('normalizeUpstreamModel：appSortOrder 为 0 是合法首位，不当缺失', () => {
  assert.equal(normalizeUpstreamModel({ key: 'm', appSortOrder: 0 }).sortOrder, 0);
});

test('normalizeUpstreamModel：tags 含 is_recommend 才标推荐', () => {
  assert.equal(normalizeUpstreamModel({ key: 'm', tags: ['is_recommend'] }).isRecommended, true);
  assert.equal('isRecommended' in normalizeUpstreamModel({ key: 'm', tags: null }), false);
});

test('normalizeCatalog：按上游排序键排列，默认模型不强行置顶', () => {
  const entries = normalizeCatalog(REAL_PAYLOAD);
  assert.deepEqual(entries.map((m) => m.id), ['flash', 'pro', 'qwen4-max']);
});

test('setActiveCatalog：空数组一律拒绝，provider 不能被清空', () => {
  resetCatalog();
  assert.equal(setActiveCatalog([]), false);
  assert.equal(getActiveCatalog(), FALLBACK_QWENWORK_MODELS);
  assert.equal(getCatalogMeta().source, 'fallback');
});

test('setActiveCatalog：写入后消费点同步看到上游模型', () => {
  resetCatalog();
  const entries = normalizeCatalog(REAL_PAYLOAD);
  assert.equal(setActiveCatalog(entries), true);
  const meta = getCatalogMeta();
  assert.equal(meta.source, 'upstream');
  assert.equal(meta.count, 3);
  assert.equal(typeof meta.fetchedAt, 'string');
  // 上游新模型必须能路由（静态表里没有它）
  assert.equal(normalizeModelKey('qwen4-max'), 'qwen4-max');
  assert.equal(findModelInfo('qwen4-max').billingRate, 0.4);
  // 卡片也同步
  assert.deepEqual(catalogForCard().map((m) => m.id), ['flash', 'pro', 'qwen4-max']);
  assert.equal(catalogForCard()[2].promotionLabel, '限时2折');
  resetCatalog();
});

test('markCatalogStale：只标脏，不清空上一次成功的真实目录', () => {
  resetCatalog();
  setActiveCatalog(normalizeCatalog(REAL_PAYLOAD));
  markCatalogStale(new Error('model/list HTTP 503'));
  const meta = getCatalogMeta();
  assert.equal(meta.stale, true);
  assert.equal(meta.error, 'model/list HTTP 503');
  assert.equal(meta.count, 3, '失败不得把目录清空');
  assert.equal(findModelInfo('qwen4-max').id, 'qwen4-max');
  resetCatalog();
});

test('resetCatalog：回到静态兜底', () => {
  setActiveCatalog(normalizeCatalog(REAL_PAYLOAD));
  resetCatalog();
  assert.equal(getCatalogMeta().source, 'fallback');
  assert.equal(getActiveCatalog(), FALLBACK_QWENWORK_MODELS);
});

/** 造一个只记录调用参数的签名会话替身。 */
function fakeSigner(calls) {
  return async () => ({
    signRequest(args) {
      calls.push(args);
      return { url: 'https://example.invalid/algo/api/v2/model/list', headers: { 'X-Test': '1' } };
    },
    dispose() {
      calls.push({ disposed: true });
    },
  });
}

test('fetchModelCatalog：走 GET + mode=auth，并在 finally 释放会话', async () => {
  const calls = [];
  const entries = await fetchModelCatalog({
    getCredential: async () => ({ token: 't' }),
    endpoint: 'https://example.invalid',
    signerFactory: fakeSigner(calls),
    fetchImpl: async (url, init) => {
      assert.equal(init.method, 'GET');
      assert.equal(init.headers['X-Test'], '1');
      return { ok: true, status: 200, json: async () => REAL_PAYLOAD };
    },
  });
  assert.equal(entries.length, 3);
  assert.equal(calls[0].path, CATALOG_PATH);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].mode, 'auth');
  assert.equal(calls.at(-1).disposed, true);
});

test('fetchModelCatalog：非 2xx 抛错，且仍释放会话', async () => {
  const calls = [];
  await assert.rejects(
    fetchModelCatalog({
      getCredential: async () => ({ token: 't' }),
      endpoint: 'https://example.invalid',
      signerFactory: fakeSigner(calls),
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
    }),
    /model\/list HTTP 403/,
  );
  assert.equal(calls.at(-1).disposed, true);
});

test('fetchModelCatalog：200 但无可用模型也抛错（不写入空目录）', async () => {
  await assert.rejects(
    fetchModelCatalog({
      getCredential: async () => ({ token: 't' }),
      endpoint: 'https://example.invalid',
      signerFactory: fakeSigner([]),
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ qwork: [] }) }),
    }),
    /no usable model/,
  );
});

test('createCatalogRefresher：成功后写入目录并按 TTL 抑制重复拉取', async () => {
  resetCatalog();
  let clock = 1000;
  let fetches = 0;
  const refresher = createCatalogRefresher({
    getCredential: async () => ({ token: 't' }),
    endpoint: 'https://example.invalid',
    signerFactory: fakeSigner([]),
    fetchImpl: async () => {
      fetches += 1;
      return { ok: true, status: 200, json: async () => REAL_PAYLOAD };
    },
    ttlMs: 600000,
    now: () => clock,
  });
  await refresher.refresh();
  assert.equal(fetches, 1);
  assert.equal(getCatalogMeta().source, 'upstream');
  assert.equal(refresher.ensureFresh(), false, 'TTL 内不得重复拉取');
  clock += 600001;
  assert.equal(refresher.ensureFresh(), true);
  await refresher.refresh();
  assert.equal(fetches, 2);
  resetCatalog();
});

test('createCatalogRefresher：失败不抛、保留旧目录、按退避间隔重试', async () => {
  resetCatalog();
  setActiveCatalog(normalizeCatalog(REAL_PAYLOAD));
  let clock = 1000;
  let fetches = 0;
  const warnings = [];
  const refresher = createCatalogRefresher({
    getCredential: async () => ({ token: 't' }),
    endpoint: 'https://example.invalid',
    signerFactory: fakeSigner([]),
    fetchImpl: async () => {
      fetches += 1;
      throw new Error('socket hang up');
    },
    retryMs: 60000,
    now: () => clock,
    logger: { warn: (...args) => warnings.push(args) },
  });
  const meta = await refresher.refresh();
  assert.equal(meta.stale, true);
  assert.equal(meta.count, 3, '失败后仍保留上一次成功的目录');
  assert.equal(warnings.length, 1);
  assert.equal(refresher.ensureFresh(), false, '退避期内不重试');
  clock += 60001;
  assert.equal(refresher.ensureFresh(), true);
  await refresher.refresh();
  assert.equal(fetches, 2);
  resetCatalog();
});

test('createCatalogRefresher：并发 refresh 去重，只打一次上游', async () => {
  resetCatalog();
  let fetches = 0;
  const refresher = createCatalogRefresher({
    getCredential: async () => ({ token: 't' }),
    endpoint: 'https://example.invalid',
    signerFactory: fakeSigner([]),
    fetchImpl: async () => {
      fetches += 1;
      await new Promise((r) => setTimeout(r, 10));
      return { ok: true, status: 200, json: async () => REAL_PAYLOAD };
    },
  });
  await Promise.all([refresher.refresh(), refresher.refresh(), refresher.refresh()]);
  assert.equal(fetches, 1);
  resetCatalog();
});

// ---- onCatalogChanged：目录变更通知（选择器刷新链路的触发端） ----

test('createCatalogChanged：目录写入成功才通知，一次 refresh 只通知一次', async () => {
  resetCatalog();
  let notices = 0;
  const refresher = createCatalogRefresher({
    getCredential: async () => ({ token: 't' }),
    endpoint: 'https://example.invalid',
    signerFactory: fakeSigner([]),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => REAL_PAYLOAD }),
    onCatalogChanged: () => {
      notices += 1;
    },
  });
  await refresher.refresh();
  assert.equal(notices, 1, '写入成功后必须通知宿主');
  assert.equal(getCatalogMeta().source, 'upstream');
  resetCatalog();
});

test('createCatalogChanged：拉取失败不通知（目录没变，宿主无需重读）', async () => {
  resetCatalog();
  setActiveCatalog(normalizeCatalog(REAL_PAYLOAD));
  let notices = 0;
  const refresher = createCatalogRefresher({
    getCredential: async () => ({ token: 't' }),
    endpoint: 'https://example.invalid',
    signerFactory: fakeSigner([]),
    fetchImpl: async () => {
      throw new Error('socket hang up');
    },
    onCatalogChanged: () => {
      notices += 1;
    },
    logger: { warn() {} },
  });
  const meta = await refresher.refresh();
  assert.equal(meta.stale, true);
  assert.equal(notices, 0, '失败路径不得通知');
  resetCatalog();
});

test('createCatalogChanged：通知回调抛异常被吞掉，refresh 结果不受污染', async () => {
  resetCatalog();
  const warnings = [];
  const refresher = createCatalogRefresher({
    getCredential: async () => ({ token: 't' }),
    endpoint: 'https://example.invalid',
    signerFactory: fakeSigner([]),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => REAL_PAYLOAD }),
    onCatalogChanged: () => {
      throw new Error('emit blew up');
    },
    logger: { warn: (...args) => warnings.push(args), info() {} },
  });
  const meta = await refresher.refresh();
  assert.equal(meta.source, 'upstream', '目录仍应视为已更新');
  assert.equal(meta.stale, false);
  assert.equal(warnings.length, 1, '通知失败要留下可见痕迹');
  resetCatalog();
});

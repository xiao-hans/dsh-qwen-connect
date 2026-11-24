// 模型偏好（开关 / 生效默认）的口径锁定。
// 背景：动态目录拉到了，但选择器要「只显示启用的模型」且「默认标记 = 用户选的那个」。
// 关键原则：
//   ① 禁用项绝不进 preferredCatalog()（provider getModels 用它）；
//   ② isDefault 重写只发生在副本上，绝不原地改 activeCatalog（卡片与 shim 共用）；
//   ③ 用户选的默认若被关掉或下架，必须回落，绝不返回一个不在选择器里的 key。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FALLBACK_QWENWORK_MODELS,
  setActiveCatalog,
  resetCatalog,
  setModelPreferences,
  resetModelPreferences,
  preferredCatalog,
  effectiveDefaultKey,
  isModelEnabled,
  catalogForCard,
} from '../../lib/models.js';

function catalog(...ids) {
  return ids.map((id, index) => ({
    id,
    shortName: id,
    isDefault: index === 0,
    contextWindow: 180000,
    maxTokens: 32000,
  }));
}

test('setModelPreferences：缺省字段不动，返回当前生效值', () => {
  resetCatalog();
  resetModelPreferences();
  assert.deepEqual(setModelPreferences({ disabled: ['flash'] }), {
    disabled: ['flash'],
    defaultModel: null,
  });
  assert.deepEqual(setModelPreferences({ defaultModel: 'pro' }), {
    disabled: ['flash'],
    defaultModel: 'pro',
  });
  assert.deepEqual(setModelPreferences({}), { disabled: ['flash'], defaultModel: 'pro' });
});

test('setModelPreferences：defaultModel 传空串/null 清除选择', () => {
  resetModelPreferences();
  setModelPreferences({ defaultModel: 'flash' });
  assert.equal(effectiveDefaultKey(), 'flash');
  assert.equal(setModelPreferences({ defaultModel: null }).defaultModel, null);
  assert.equal(setModelPreferences({ defaultModel: '' }).defaultModel, null);
});

test('setModelPreferences：disabled 元素一律 String 化（防宿主传非串 key）', () => {
  resetModelPreferences();
  const result = setModelPreferences({ disabled: ['flash', 1, null] });
  assert.deepEqual(result.disabled, ['flash', '1', 'null']);
});

test('effectiveDefaultKey：优先级 用户选定 > 目录标 default > 首个启用 > 首个', () => {
  resetCatalog();
  resetModelPreferences();
  setActiveCatalog(catalog('flash', 'pro', 'qwen4-max'));
  // 目录自己标的 pro?——上面 catalog() 把 index 0（flash）标为默认
  assert.equal(effectiveDefaultKey(), 'flash', '无用户选择时取目录默认项');

  setModelPreferences({ defaultModel: 'pro' });
  assert.equal(effectiveDefaultKey(), 'pro', '用户选择覆盖目录默认');

  setModelPreferences({ defaultModel: 'qwen4-max', disabled: ['qwen4-max'] });
  assert.equal(effectiveDefaultKey(), 'flash', '选定的模型被关掉必须回落');

  setModelPreferences({ defaultModel: 'ghost', disabled: ['flash'] });
  assert.equal(effectiveDefaultKey(), 'pro', '选定模型下架时退回目录默认');

  setModelPreferences({ defaultModel: null, disabled: ['flash', 'pro'] });
  assert.equal(effectiveDefaultKey(), 'qwen4-max', '目录默认被关掉时取首个启用');
});

test('effectiveDefaultKey：全选关掉也不返回 null（provider 不能没有默认）', () => {
  resetCatalog();
  resetModelPreferences();
  setActiveCatalog(catalog('flash', 'pro'));
  setModelPreferences({ disabled: ['flash', 'pro'] });
  assert.equal(effectiveDefaultKey(), 'flash', '兜底取 candidates[0]');
});

test('preferredCatalog：剔除禁用项，只保留启用模型', () => {
  resetCatalog();
  resetModelPreferences();
  setActiveCatalog(catalog('flash', 'pro', 'qwen4-max'));
  setModelPreferences({ disabled: ['pro'] });
  assert.deepEqual(preferredCatalog().map((m) => m.id), ['flash', 'qwen4-max']);
});

test('preferredCatalog：isDefault 重写成生效默认，且不原地改 activeCatalog', () => {
  resetCatalog();
  resetModelPreferences();
  const entries = catalog('flash', 'pro', 'qwen4-max');
  setActiveCatalog(entries);
  setModelPreferences({ defaultModel: 'qwen4-max' });

  const preferred = preferredCatalog();
  assert.deepEqual(
    preferred.map((m) => [m.id, m.isDefault === true]),
    [
      ['flash', false],
      ['pro', false],
      ['qwen4-max', true],
    ],
  );
  // 原地改写会污染卡片（含禁用项视图）与 chat-shim —— 原对象必须保持 index0 默认。
  assert.equal(entries[0].isDefault, true, '原条目未被改写');
  assert.equal(entries[2].isDefault === true, false, '原条目未被改写');
  assert.notEqual(preferred[2], entries[2], '被改写项必须是新对象');
});

test('preferredCatalog：无用户偏好时不产生多余拷贝', () => {
  resetCatalog();
  resetModelPreferences();
  const entries = catalog('flash', 'pro');
  setActiveCatalog(entries);
  const preferred = preferredCatalog();
  assert.equal(preferred[0], entries[0]);
  assert.equal(preferred[1], entries[1]);
});

test('isModelEnabled：缺字段按启用；不在目录里的旧禁用项自然失效', () => {
  resetCatalog();
  resetModelPreferences();
  setActiveCatalog(catalog('flash', 'pro'));
  assert.equal(isModelEnabled({ id: 'newcomer' }), true, '目录新增项默认可用');
  assert.equal(isModelEnabled(null), false);
  assert.equal(isModelEnabled(undefined), false);
});

test('displayNameId 兼容：用户存的是展示全名也能匹配到短 key', () => {
  resetCatalog();
  resetModelPreferences();
  setActiveCatalog([
    { id: 'flash', displayNameId: 'Qwen-Flash', shortName: 'flash', isDefault: true },
    { id: 'pro', displayNameId: 'Qwen-Pro', shortName: 'pro' },
  ]);
  setModelPreferences({ defaultModel: 'Qwen-Pro' });
  assert.equal(effectiveDefaultKey(), 'pro', '生效默认必须归一回短 key');
});

test('catalogForCard：包含禁用项并标注 enabled，默认徽章用生效值', () => {
  resetCatalog();
  resetModelPreferences();
  setActiveCatalog(catalog('flash', 'pro', 'qwen4-max'));
  setModelPreferences({ defaultModel: 'qwen4-max', disabled: ['pro'] });
  const card = catalogForCard();
  assert.deepEqual(
    card.map((m) => [m.id, m.enabled, m.isDefault === true]),
    [
      ['flash', true, false],
      ['pro', false, false],
      ['qwen4-max', true, true],
    ],
    '卡片要显示全部（含灰掉的），默认徽章只打给生效默认',
  );
});

test('resetModelPreferences：清空后回到纯目录视图', () => {
  resetCatalog();
  setActiveCatalog(catalog('flash', 'pro'));
  setModelPreferences({ disabled: ['flash'], defaultModel: 'pro' });
  resetModelPreferences();
  assert.deepEqual(preferredCatalog().map((m) => m.id), ['flash', 'pro']);
  assert.equal(effectiveDefaultKey(), 'flash');
});

test('静态兜底表在无偏好时不受影响（回归保护）', () => {
  resetCatalog();
  resetModelPreferences();
  const ids = FALLBACK_QWENWORK_MODELS.map((m) => m.id);
  assert.deepEqual(preferredCatalog().map((m) => m.id), ids);
});

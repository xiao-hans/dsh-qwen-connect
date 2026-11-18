#!/usr/bin/env node
/**
 * 只读探针：走**生产路径**验证动态目录刷新器。
 *
 * 与 probe-model-catalog.mjs 的区别：那个直接调签名会话验端点可达；
 * 这个走 `createCatalogRefresher({ getCredential: getValidCredential })`，
 * 即插件运行时真正用的那条链（凭据接缝 → 签名 → 拉取 → 归一化 → 写入生效目录），
 * 并检查消费点（选择器名 / 卡片行 / 路由归一化）是否同步。
 *
 * 只读，不走推理，不消耗额度；不打印任何凭据。
 *
 * 用法：node research/probe-catalog-refresh.mjs
 */
import { getValidCredential } from '../lib/credentials-seam.js';
import { createCatalogRefresher } from '../lib/model-catalog.js';
import { getActiveCatalog, getCatalogMeta, catalogForCard, displayName, normalizeModelKey } from '../lib/models.js';

const refresher = createCatalogRefresher({
  getCredential: getValidCredential,
  logger: {
    info: (...args) => console.log('[info]', ...args),
    warn: (...args) => console.log('[warn]', ...args),
  },
});

const meta = await refresher.refresh();
console.log('meta =', JSON.stringify(meta));
console.log('\n生效目录：');
for (const info of getActiveCatalog()) {
  console.log(`  ${info.id.padEnd(20)} 选择器名=${displayName(info)}`);
}
console.log('\n卡片行：');
for (const row of catalogForCard()) console.log(`  ${JSON.stringify(row)}`);
console.log('\n路由归一化：');
for (const info of getActiveCatalog()) {
  console.log(`  ${info.id} -> ${normalizeModelKey(info.id)}`);
}
console.log('\nTTL 内重复 ensureFresh（应为 false）：', refresher.ensureFresh());

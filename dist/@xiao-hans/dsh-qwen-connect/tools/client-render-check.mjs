// tools/client-render-check.mjs
// 在 Node 里模拟浏览器环境，加载 client.js 并渲染卡片，验证不抛异常。
// 用 react-dom/server 做 SSR 渲染 —— 能真正执行组件代码而不需要浏览器 DOM。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);

// 定位 react 与 react-dom：优先本包，其次 DSH 的 profile node_modules，
// 再次本机 npm 缓存里带 react 的依赖树（无 DSH 环境的开发机兜底）。
// 可用 DSH_REACT_MODULES=<node_modules 目录> 显式指定。
function loadDep(name) {
  const roots = [];
  if (process.env.DSH_REACT_MODULES) roots.push(process.env.DSH_REACT_MODULES);
  const roaming = process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming');
  roots.push(path.join(roaming, 'dsh-desktop', 'harness', 'profiles', 'node_modules'));
  roots.push(
    path.join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'node_modules'),
    path.join(process.env.LOCALAPPDATA ?? '', 'npm-cache', '_npx', '1e7f6d9597241db0', 'node_modules'),
  );
  let lastError;
  try {
    return require(name);
  } catch (error) {
    lastError = error;
  }
  for (const root of roots) {
    try {
      const req2 = createRequire(path.join(root, 'noop.js'));
      return req2(name);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

let react, jsxRuntime, server;
try {
  react = loadDep('react');
  jsxRuntime = loadDep('react/jsx-runtime');
  server = loadDep('react-dom/server');
} catch (e) {
  console.error('无法加载 react/react-dom，请在有 DSH 依赖的环境运行：', e.message);
  process.exit(2);
}

// ---- 捕获 client.js 注册的模块 ----
let registered = null;
const loadCalls = [];

globalThis.window = {
  __ModuleLoader__: {
    load(config) {
      loadCalls.push(config);
      registered = config;
    },
  },
};

// client.js 用 `require('react')` 等 —— 提供一个满足它的 require
function fakeRequire(id) {
  if (id === 'react') return react;
  if (id === 'react/jsx-runtime') return jsxRuntime;
  throw new Error(`unexpected require: ${id}`);
}

// ---- 加载 client.js ----
const clientPath = path.join(PLUGIN_ROOT, 'lib', 'client.js');
const src = fs.readFileSync(clientPath, 'utf8');
// client.js 是自执行包装，直接 eval 即可（它会调用 window.__ModuleLoader__.load）
new Function('window', 'require', src)(globalThis.window, fakeRequire);

if (registered === null) {
  console.error('❌ client.js 未调用 __ModuleLoader__.load');
  process.exit(1);
}
console.log(`✅ __ModuleLoader__.load 被调用 | id=${registered.id}`);

const mod = registered.factory(fakeRequire);
console.log(`✅ factory 返回 | exports=${Object.keys(mod).join(', ')}`);
console.log(`   name   = ${mod.name}`);
console.log(`   inject = ${JSON.stringify(mod.inject)}`);

// ---- 模拟 ctx 并执行 apply ----
const slotsRegistered = [];
const ctx = {
  effect(fn) {
    return fn();
  },
  locale: {
    register(ns, dict) {
      console.log(`✅ locale.register | ns=${ns} | zh 键数=${Object.keys(dict.zh).length} en 键数=${Object.keys(dict.en).length}`);
      return () => {};
    },
    bind() {
      // t(key, params) —— 简单插值
      return (key, params) => {
        const dict = lastDict.zh;
        let s = dict[key] ?? key;
        if (params) for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v));
        return s;
      };
    },
  },
  slots: {
    inject(slot, fn) {
      fn();
    },
    register(meta, Component) {
      slotsRegistered.push({ meta, Component });
      const seat = meta.id ?? meta.key;
      const order = meta.order ?? meta.priority;
      console.log(`✅ slots.register | slot=${meta.name} seat=${seat} order=${order}`);
      return () => {};
    },
  },
};
let lastDict = null;
const origRegister = ctx.locale.register;
ctx.locale.register = (ns, dict) => {
  lastDict = dict;
  return origRegister(ns, dict);
};

try {
  mod.apply(ctx);
} catch (e) {
  console.error('❌ apply 抛异常:', e.message);
  process.exit(1);
}

if (slotsRegistered.length !== 2) {
  console.error(`❌ 期望注册 2 个席位（设置卡片 + 输入框积分读数），实际 ${slotsRegistered.length}`);
  process.exit(1);
}

// ---- SSR 渲染：两种状态都要能渲染 ----
const { Component, meta } = slotsRegistered[0];
const composer = slotsRegistered.find((s) => s.meta.name === 'conversation.input.left');
if (composer === undefined) {
  console.error('❌ 未注册 conversation.input.left 积分读数');
  process.exit(1);
}
const t = ctx.locale.bind('settings.qwenwork');
const inject = meta.inject();

let failures = 0;

/** 渲染一个状态，返回 HTML；并断言必须出现的关键词。 */
function renderCase(label, state, mustContain = [], mustNotContain = []) {
  try {
    const html = server.renderToStaticMarkup(
      react.createElement(Component, { t, initialState: state, initialOpen: true }),
    );
    const missing = mustContain.filter((needle) => !html.includes(needle));
    const leaked = mustNotContain.filter((needle) => html.includes(needle));
    if (missing.length > 0) {
      console.log(`  ❌ ${label}: 缺少 ${JSON.stringify(missing)}`);
      failures++;
      return html;
    }
    if (leaked.length > 0) {
      console.log(`  ❌ ${label}: 不应出现 ${JSON.stringify(leaked)}`);
      failures++;
      return html;
    }
    console.log(`  ✅ ${label}: ${html.length} 字节`);
    return html;
  } catch (e) {
    console.log(`  ❌ ${label} 抛异常: ${e.message}`);
    failures++;
    return '';
  }
}

// ---- ① 完整数据：六个配额 + 三个模型 ----
const htmlFull = renderCase(
  '完整数据',
  {
    status: 'signed-in',
    provider: 'qwenwork',
    nickname: '测试用户',
    account: 'testuser01',
    remaining: 2092.36,
    tierName: 'Free',
    // 上游不给 total 时，host 会给出「参考基准」用于画水位条
    creditBaseline: 2100,
    entitlements: [{ key: 'credits', label: '积分', remain: 2092.36, unit: 'credits' }],
    // 上游性能指标（来自 shim 实测采样）
    perf: { samples: 7, ttftMs: 706, charsPerSec: 127.3, totalMs: 1439, lastTtftMs: 657, lastCharsPerSec: 87.6 },
    models: [
      { id: 'pro', name: '高级', rate: 1, isDefault: true },
      { id: 'flash', name: '标准', rate: 0.1, isRecommended: true },
    ],
  },
  // 卡片**只**展示：账号 + 积分 + 上游速度 + 模型。会话数/存储空间/月度流量
  // 等套餐权益上限已按用户要求移除——断言它们"不应出现"。
  ['测试用户', '积分', '2,092.4', '上游速度', '首 token 延迟', '706', '输出速率', '127.3', '高级', '默认', '推荐', '刷新'],
  ['登录标识', '会话数', '存储空间', '页面额度', '月度请求', '月度流量', '套餐'],
);

// ---- ② 有 total：应出现进度条 ----
const htmlBar = renderCase(
  '有 total（进度条）',
  {    status: 'signed-in',
    nickname: 'Test',
    remaining: 500,
    entitlements: [{ key: 'credits', label: '积分', remain: 500, size: 1000, unit: 'credits' }],
    models: [],
  },
  ['role="progressbar"', '剩余 50%', '剩余 500 / 1,000'],
);

// ---- ③ 只有 remain：用「消耗进度」画条（当前余额 / 观测峰值）----
const htmlNoTotal = renderCase(
  '只有 remain（消耗进度条）',
  {
    status: 'signed-in',
    nickname: 'Test',
    remaining: 2100,
    creditBaseline: 2100,
    entitlements: [{ key: 'credits', label: '积分', remain: 2100, unit: 'credits' }],
    models: [],
  },
  // 有进度条（峰值 2100 == 当前 2100 → 满格）；
  // 文案是「较峰值」而非「剩余」——分母不是真实总量，不能那样写。
  ['role="progressbar"', '较峰值 100%', '当前余额 2,100'],
  // 绝不能出现像真实配额的一行
  ['剩余 2,100 /', '剩余 100%'],
);
void htmlNoTotal;

// ---- ④ 未登录：错误信息可见，且不泄漏凭据 ----
renderCase(
  '未登录',
  { status: 'signed-out', error: { code: 'CREDENTIALS_MISSING', message: '未找到凭据' } },
  ['未找到凭据'],
  ['eyJ', 'Bearer '],
);

// ---- ⑤ 加载中 ----
renderCase('加载中', null, ['正在读取状态']);

// 断言：进度条的宽度百分比正确
if (htmlBar.includes('width:50%')) {
  console.log('  ✅ 进度条宽度按 remain/size 正确计算（50%）');
} else {
  console.log('  ❌ 进度条宽度计算不正确');
  failures++;
}

// ---------------------------------------------------------------------------
// 数据异常场景：客户端不得假设 host 数据完美，任何一项都不能让整卡白屏
// ---------------------------------------------------------------------------

console.log('\n--- 数据异常与安全边界 ---');

renderCase('entitlements 含 null 项', {
  status: 'signed-in',
  nickname: 'T',
  entitlements: [null, { key: 'credits', label: '积分', remain: 1, unit: 'credits' }],
  models: [],
});

renderCase('models 含 null 项', {
  status: 'signed-in',
  nickname: 'T',
  entitlements: [],
  models: [null, { id: 'pro', name: '高级', rate: 1 }],
});

renderCase('size 为 0（除法保护）', {
  status: 'signed-in',
  nickname: 'T',
  entitlements: [{ key: 'credits', label: '积分', remain: 0, size: 0, unit: 'credits' }],
  models: [],
});

renderCase('remain 超过 size（进度条须封顶）', {
  status: 'signed-in',
  nickname: 'T',
  entitlements: [{ key: 'credits', label: '积分', remain: 200, size: 100, unit: 'credits' }],
  models: [],
});

// XSS：React 默认转义，此处验证确实生效（不是靠运气）
const htmlXss = renderCase(
  '恶意昵称被转义',
  { status: 'signed-in', nickname: '<script>alert(1)</script>', entitlements: [], models: [] },
  [],
  ['<script>'],
);
if (htmlXss.includes('&lt;script&gt;')) {
  console.log('  ✅ 尖括号被转义为实体');
} else {
  console.log('  ❌ 未观察到转义');
  failures++;
}

renderCase(
  '恶意模型名被转义',
  {
    status: 'signed-in',
    nickname: 'T',
    entitlements: [],
    models: [{ id: 'x', name: '<img src=x onerror=alert(1)>', rate: 1 }],
  },
  [],
  ['<img'],
);

// ---------------------------------------------------------------------------
// 输入框积分读数（conversation.input.left）：provider gate + 数字格式
// SSR 不跑 useEffect，所以不会真的发请求；用 initialState 走与卡片同一开口。
// ---------------------------------------------------------------------------

console.log('\n--- 输入框积分读数 ---');

const qwen = () => ({ next: { provider: 'qwenwork' } });
const other = (p) => ({ next: { provider: p } });

/** 渲染读数位；expected === '' 表示该场景必须整体不渲染。 */
function composerCase(label, state, projection, mustContain = [], mustNotContain = []) {
  try {
    const html = server.renderToStaticMarkup(
      react.createElement(composer.Component, { t, initialState: state, useProjection: projection }),
    );
    if (mustContain.length === 0 && mustNotContain.length === 0) {
      if (html !== '') {
        console.log(`  ❌ ${label}: 应当不渲染，实际输出 ${html.length} 字节`);
        failures++;
      } else {
        console.log(`  ✅ ${label}: 正确不渲染`);
      }
      return html;
    }
    const missing = mustContain.filter((needle) => !html.includes(needle));
    const leaked = mustNotContain.filter((needle) => html.includes(needle));
    if (missing.length > 0 || leaked.length > 0) {
      console.log(`  ❌ ${label}: 缺少 ${JSON.stringify(missing)} 不应出现 ${JSON.stringify(leaked)}`);
      failures++;
    } else {
      console.log(`  ✅ ${label}: ${html.length} 字节`);
    }
    return html;
  } catch (e) {
    console.log(`  ❌ ${label} 抛异常: ${e.message}`);
    failures++;
    return '';
  }
}

// 选中本 provider + 有积分：显示千分位数字，不显示警告样式
composerCase(
  '已登录（2092.36 → 2,092.4）',
  { status: 'signed-in', remaining: 2092.36 },
  qwen,
  ['千问办公', '2,092.4'],
  ['未登录', 'credits-warn'],
);
// 积分恰为 0：必须是 0，不能被当成「未登录」——写未登录会让人以为还能用
composerCase(
  '额度用尽（0）',
  { status: 'signed-in', remaining: 0 },
  qwen,
  ['>0<'],
  ['未登录', 'credits-warn'],
);
// 未登录 / 无积分字段：警告色占位，且不出现任何数字
composerCase('未登录', { status: 'signed-out', error: { code: 'CREDENTIALS_MISSING' } }, qwen, [
  '未登录',
  'credits-warn',
]);
// 登录着但上游额度接口暂时失败（VPC quota 间歇 503）：说「积分暂不可用」，
// 绝不能说「未登录」——此时对话完全可用（2026-10-28 误报事故回归）。
composerCase(
  'degraded（signed-in 无积分）',
  { status: 'signed-in', degraded: true, error: { code: 'API_ERROR', retryable: true } },
  qwen,
  ['积分暂不可用', 'credits-warn'],
  ['未登录'],
);
// entitlements 兜底路径
composerCase('entitlements 兜底', { entitlements: [{ key: 'credits', remain: 12.5 }] }, qwen, ['12.5'], [
  '未登录',
]);
// 选中别的 provider：整块不渲染（不能给兄弟插件的行留一个空位）
composerCase('选中 workbuddy', { remaining: 100 }, () => other('workbuddy'));
composerCase('选中 deepseek', { remaining: 100 }, () => other('deepseek'));
// 新会话从未选过模型
composerCase('投影为 null', { remaining: 100 }, () => null);
composerCase('provider 为 null', { remaining: 100 }, () => ({ next: { provider: null } }));
composerCase('next 缺省走 lastUsed', { remaining: 100 }, () => ({ lastUsed: { provider: 'qwenwork' } }), [
  '100',
]);
// 宿主未注入 useProjection（离线/降级）时必须静默，不能抛进 DSH 的插槽渲染
composerCase('无 useProjection', { remaining: 100 }, undefined);

if (failures > 0) {
  console.error(`\n❌ ${failures} 项检查失败`);
  process.exit(1);
}
console.log('\n✅ client.js 渲染检查全部通过');


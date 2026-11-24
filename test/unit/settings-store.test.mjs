// 插件自持设置存储（模型开关 / 默认模型落盘）的口径锁定。
// 背景：持久化走插件自己的 settings.json（方案 C），不走宿主 installSection——
// 宿主 profile patch 写入会热重载插件 fiber，每点一下开关重载一次不可接受。
// 关键原则：
//   ① 绝不抛：读失败退化内存默认，写失败只 warning 一次且内存仍生效；
//   ② 原子写（tmp+rename），外部改坏文件也不崩；
//   ③ 只存非敏感字段——本测试顺带锁定文件里不会出现凭证形状的值。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  settingsDir,
  settingsFilePath,
  readSettings,
  loadModelPreferences,
  saveModelPreferences,
  updateModelPreferences,
  resetSettingsStore,
} from '../../lib/settings-store.js';

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-settings-'));
  const previous = process.env.QWEN_CONNECT_DATA_DIR;
  process.env.QWEN_CONNECT_DATA_DIR = dir;
  resetSettingsStore();
  try {
    return fn(dir);
  } finally {
    if (previous === undefined) delete process.env.QWEN_CONNECT_DATA_DIR;
    else process.env.QWEN_CONNECT_DATA_DIR = previous;
    resetSettingsStore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('settingsDir：env 覆盖优先，source 标 env', () => {
  withTempDir((dir) => {
    const resolved = settingsDir();
    assert.equal(resolved.dir, path.resolve(dir));
    assert.equal(resolved.source, 'env');
  });
});

test('settingsDir：不创建目录（只读探测无副作用）', () => {
  const missing = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-settings-')),
    'not-created',
  );
  const previous = process.env.QWEN_CONNECT_DATA_DIR;
  process.env.QWEN_CONNECT_DATA_DIR = missing;
  resetSettingsStore();
  try {
    settingsDir();
    assert.equal(fs.existsSync(missing), false, '仅探测就建目录是副作用，不允许');
  } finally {
    if (previous === undefined) delete process.env.QWEN_CONNECT_DATA_DIR;
    else process.env.QWEN_CONNECT_DATA_DIR = previous;
    resetSettingsStore();
    fs.rmSync(path.dirname(missing), { recursive: true, force: true });
  }
});

test('loadModelPreferences：无文件时返回空偏好（不猜不造）', () => {
  withTempDir(() => {
    assert.deepEqual(loadModelPreferences(), { disabled: [], defaultModel: null });
  });
});

test('saveModelPreferences：落盘 + 读回一致，__writes 记账自增', () => {
  withTempDir(() => {
    const first = saveModelPreferences({ defaultModel: 'pro', disabledModels: ['flash'] });
    assert.equal(first.persisted, true);
    assert.deepEqual(first.values, { disabled: ['flash'], defaultModel: 'pro' });
    const raw = JSON.parse(fs.readFileSync(settingsFilePath(), 'utf8'));
    assert.equal(raw.__writes, 1);

    saveModelPreferences({ defaultModel: null });
    resetSettingsStore();
    assert.deepEqual(loadModelPreferences(), { disabled: ['flash'], defaultModel: null });
    assert.equal(JSON.parse(fs.readFileSync(settingsFilePath(), 'utf8')).__writes, 2);
  });
});

test('saveModelPreferences：disabledModels 去重去空，字段缺省不动', () => {
  withTempDir(() => {
    const saved = saveModelPreferences({ disabledModels: ['flash', 'flash', '', 7, 'pro'] });
    assert.deepEqual(saved.values.disabled, ['flash', 'pro'], '去重且只收非空字符串');
    const again = saveModelPreferences({ defaultModel: 'pro' });
    assert.deepEqual(again.values.disabled, ['flash', 'pro'], '缺省字段保持');
  });
});

/**
 * 让写盘必然失败：把数据目录指到一个「文件」的下一层，
 * mkdirSync(recursive) 会 ENOTDIR。返回该临时根以便清理。
 */
function makeUnwritable(dir) {
  const root = fs.mkdtempSync(path.join(dir, 'unwritable-'));
  const blocker = path.join(root, 'blocker');
  fs.writeFileSync(blocker, 'x', 'utf8');
  process.env.QWEN_CONNECT_DATA_DIR = path.join(blocker, 'nested');
  resetSettingsStore();
}

test('saveModelPreferences：写盘失败不抛，内存生效并回报 error', () => {
  withTempDir((dir) => {
    makeUnwritable(dir);
    const result = saveModelPreferences({ defaultModel: 'pro' });
    assert.equal(result.persisted, false);
    assert.equal(typeof result.error, 'string');
    assert.deepEqual(result.values, { disabled: [], defaultModel: 'pro' }, '内存层照常生效');
  });
});

test('readSettings：损坏 JSON / 数组 / 非对象一律 undefined', () => {
  withTempDir(() => {
    fs.mkdirSync(path.dirname(settingsFilePath()), { recursive: true });
    for (const junk of ['{not json', '[1,2]', '"str"', 'null']) {
      fs.writeFileSync(settingsFilePath(), junk, 'utf8');
      resetSettingsStore();
      assert.equal(readSettings(), undefined, `junk=${junk}`);
    }
  });
});

test('loadModelPreferences：外部改坏字段也不崩（类型过滤）', () => {
  withTempDir(() => {
    fs.mkdirSync(path.dirname(settingsFilePath()), { recursive: true });
    fs.writeFileSync(
      settingsFilePath(),
      JSON.stringify({ defaultModel: 42, disabledModels: 'flash' }),
      'utf8',
    );
    resetSettingsStore();
    assert.deepEqual(loadModelPreferences(), { disabled: [], defaultModel: null });
  });
});

test('updateModelPreferences：写盘与生效绑成一个动作（deps.apply 收到持久化后的值）', () => {
  withTempDir(() => {
    const applied = [];
    const result = updateModelPreferences(
      { defaultModel: 'pro', disabledModels: ['flash'] },
      { apply: (prefs) => applied.push(structuredClone(prefs)) },
    );
    assert.equal(result.persisted, true);
    assert.deepEqual(applied, [{ disabled: ['flash'], defaultModel: 'pro' }]);
  });
});

test('updateModelPreferences：写失败只 warning 一次，apply 仍执行', () => {
  withTempDir((dir) => {
    makeUnwritable(dir);
    let warns = 0;
    const applied = [];
    const deps = { apply: (p) => applied.push(p), logger: { warn: () => { warns += 1; } } };
    const first = updateModelPreferences({ defaultModel: 'pro' }, deps);
    const second = updateModelPreferences({ defaultModel: 'flash' }, deps);
    assert.equal(first.persisted, false);
    assert.equal(second.persisted, false);
    assert.equal(warns, 1, '同一会话只提醒一次写盘失败');
    assert.deepEqual(applied.map((p) => p.defaultModel), ['pro', 'flash'], 'apply 照常执行');
  });
});

test('settings.json 只含非敏感字段（凭证绝不落盘的红线守卫）', () => {
  withTempDir(() => {
    saveModelPreferences({ defaultModel: 'pro', disabledModels: ['flash'] });
    const raw = fs.readFileSync(settingsFilePath(), 'utf8');
    for (const secret of ['token', 'access', 'secret', 'cookie', 'password', 'dataprot']) {
      assert.equal(
        raw.toLowerCase().includes(secret),
        false,
        `设置文件不应出现敏感字段名 ${secret}`,
      );
    }
  });
});

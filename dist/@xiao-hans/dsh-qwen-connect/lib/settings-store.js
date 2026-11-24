/**
 * 插件自持的设置存储（模型开关 / 默认模型）。
 *
 * 为什么不走宿主的 `installSection` 写回：宿主的一次 profile patch 写入会
 * 重新协调整个 loader 树并热重载插件 fiber——**每点一下开关就重载一次插件**
 * 不是可接受的交互（`dsh-qoder-connect` 的 settings-store 模块注释记录的同一
 * 结论，它因此完全不依赖宿主持久化）。本插件的可见状态只有一个模型目录与
 * 两个偏好字段，自持文件是更小、更可控的方案。
 *
 * 边界（与本项目一贯原则对齐）：
 *  - **只存非敏感字段**：`defaultModel`、`disabledModels`、记账用的 `__writes`。
 *    凭证永远不落盘（见 lib/credentials-seam.js 的约定），本模块与凭证无关。
 *  - **绝不抛异常**：读失败退化成内存默认值，写失败只记录一次 warning，
 *    apply() 红线是不抛（lib/index.js）。
 *  - 原子写：先写 `<path>.tmp` 再 rename，避免半截 JSON 让下次启动读不到。
 *
 * 路径解析优先级：
 *  1. `QWEN_CONNECT_DATA_DIR`（测试与非常规安装的最高优先钩子）
 *  2. 从本模块位置向上找 profile 目录（含 `cordis.yml` 的那层）——设置随
 *     profile 走，不同 profile 可以有不同的模型开关。
 *  3. 兜底 `<DSH home>/.dsh-qwen-connect`（`DSH_HOME` 或 `~/.dsh`）。
 *
 * @module dsh-qwen-connect/settings-store
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 目录名，与同族插件 `~/.dsh/profiles/<p>/.dsh-qoder-connect` 同惯例。 */
const DATA_DIR_NAME = '.dsh-qwen-connect';
const SETTINGS_FILE_NAME = 'settings.json';
/** 宿主 profile 的判据文件（仓库自身只有 cordis.patch.yml，不是 profile）。 */
const PROFILE_MARKER = 'cordis.yml';
/** 从模块位置向上找 profile 的层数上限（node_modules/@scope/pkg/lib → 4 层）。 */
const MAX_WALK_UP = 8;
/** 记账字段：卡片写过多少次，用于区分「种子」与「用户实时编辑」。 */
const WRITE_MARK = '__writes';

/** 已解析的数据目录（缓存一次；env 变更后由 resetSettingsStore 清空）。 */
let cachedDir = null;
/** 写失败只 warning 一次，避免每次开关都在日志里刷同一条。 */
let warnedWriteFailure = false;

function dshHome() {
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '') {
    return process.env.DSH_HOME.trim();
  }
  return path.join(os.homedir(), '.dsh');
}

/**
 * 本插件的数据目录。**不创建**——创建留到真正要写的时候，
 * 只读探测（单测、状态路由）不该有副作用。
 *
 * @returns {{ dir: string, source: 'env' | 'profile' | 'home' }}
 */
export function settingsDir() {
  if (cachedDir !== null) return cachedDir;

  const override = process.env.QWEN_CONNECT_DATA_DIR;
  if (typeof override === 'string' && override.trim() !== '') {
    cachedDir = { dir: path.resolve(override.trim()), source: 'env' };
    return cachedDir;
  }

  // 从模块位置向上找 profile 目录。注意用 import.meta.url 而非 process.cwd()：
  // DSH 的工作目录与 profile 无必然关系。
  let current = path.dirname(path.resolve(import.meta.filename));
  for (let depth = 0; depth < MAX_WALK_UP; depth += 1) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
    try {
      if (fs.existsSync(path.join(current, PROFILE_MARKER))) {
        cachedDir = { dir: path.join(current, DATA_DIR_NAME), source: 'profile' };
        return cachedDir;
      }
    } catch {
      break;
    }
  }

  cachedDir = { dir: path.join(dshHome(), DATA_DIR_NAME), source: 'home' };
  return cachedDir;
}

/** 设置文件绝对路径。 */
export function settingsFilePath() {
  return path.join(settingsDir().dir, SETTINGS_FILE_NAME);
}

/**
 * 读设置文件。缺失/损坏一律返回 `undefined`——**不猜、不造默认值**。
 *
 * @returns {{ defaultModel?: string, disabledModels?: string[] } | undefined}
 */
export function readSettings() {
  try {
    const file = settingsFilePath();
    if (!fs.existsSync(file)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

/** 内存里的用户层（读盘一次后常驻；写时同步更新）。 */
let userLayer = null;

/** 取用户层（首次调用读盘）。返回值只供本模块内部使用。 */
function layer() {
  if (userLayer === null) {
    const stored = readSettings();
    userLayer = stored !== undefined && stored !== null ? { ...stored } : {};
  }
  return userLayer;
}

/** 归一化用户层里的偏好字段（外部改过文件也不崩）。 */
function normalize(values) {
  const disabled = Array.isArray(values.disabledModels)
    ? [...new Set(values.disabledModels.filter((k) => typeof k === 'string' && k !== ''))]
    : [];
  const defaultModel =
    typeof values.defaultModel === 'string' && values.defaultModel !== ''
      ? values.defaultModel
      : null;
  return { disabled, defaultModel };
}

/**
 * 当前生效的模型偏好（供 apply() 注入 models.js）。永不抛。
 *
 * @returns {{ disabled: string[], defaultModel: string | null }}
 */
export function loadModelPreferences() {
  return normalize(layer());
}

/**
 * 落盘一次偏好变更，并返回写盘后的值。
 *
 * ⚠️ 先改内存再写盘：写盘失败时内存仍然生效（本次会话可用），
 * 只是重启后丢失——比「写失败导致开关点了没反应」更接近可用。
 * 失败原因由调用方通过 logger 报出（见返回值 `error`）。
 *
 * @param {{ defaultModel?: string | null, disabledModels?: string[] }} patch
 *        字段缺省表示不动；`defaultModel: null` 表示清除选择。
 * @returns {{ values: { defaultModel: string | null, disabledModels: string[] }, persisted: boolean, error?: string }}
 */
export function saveModelPreferences(patch = {}) {
  const current = layer();
  if ('defaultModel' in patch) {
    const value = patch.defaultModel;
    if (typeof value === 'string' && value !== '') current.defaultModel = value;
    else delete current.defaultModel;
  }
  if (Array.isArray(patch.disabledModels)) {
    current.disabledModels = [
      ...new Set(patch.disabledModels.filter((k) => typeof k === 'string' && k !== '')),
    ];
  }
  current[WRITE_MARK] = (typeof current[WRITE_MARK] === 'number' ? current[WRITE_MARK] : 0) + 1;

  const result = {
    values: normalize(current),
    persisted: false,
  };
  try {
    const file = settingsFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    result.persisted = true;
  } catch (error) {
    // 写盘失败不影响本次会话（内存已生效），但必须说清楚，
    // 否则用户会以为设置已经保住了。
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

/**
 * 一次偏好变更：写盘 + 同步进 models.js 的生效偏好。
 *
 * 把「落盘」与「生效」绑成一个动作，杜绝两处状态漂移（写了盘但目录没变，
 * 或目录变了但盘上还是旧值——后者表现为重启后设置回滚）。
 *
 * @param {{ defaultModel?: string | null, disabledModels?: string[] }} patch
 * @param {{ apply: (prefs: { disabled: string[], defaultModel: string|null }) => unknown, logger?: any }} deps
 * @returns {{ values: object, persisted: boolean, error?: string }}
 */
export function updateModelPreferences(patch, deps) {
  const saved = saveModelPreferences(patch);
  deps.apply(saved.values);
  if (!saved.persisted && !warnedWriteFailure) {
    warnedWriteFailure = true;
    deps.logger?.warn?.(
      'dsh-qwen-connect: model settings could not be written to disk; changes apply to this session only',
      saved.error,
    );
  }
  return saved;
}

/** 测试钩子：清空内存层与目录缓存（与 resetCatalog() 同惯例）。 */
export function resetSettingsStore() {
  userLayer = null;
  cachedDir = null;
  warnedWriteFailure = false;
}

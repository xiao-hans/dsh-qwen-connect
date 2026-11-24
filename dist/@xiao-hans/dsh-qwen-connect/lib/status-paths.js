/**
 * host 侧同源状态路由 + 浏览器侧卡片共用的常量。
 *
 * 该模块**不得引入任何 Node 或浏览器专属依赖**：host 半与 client 半都会
 * import 它（client.js 是 `__ModuleLoader__.load` 包装，会内联一份常量）。
 *
 * @module dsh-qwen-connect/status-paths
 */

/** 本插件拥有的状态端点，供其浏览器半读取。 */
export const QWENWORK_STATUS_PATH = '/plugins/dsh-qwen-connect/status';

/**
 * 模型偏好（开关 / 默认项）的写回端点。与状态端点同为环回-only，
 * 见 lib/web-status.js 的安全边界。
 */
export const QWENWORK_SETTINGS_PATH = '/plugins/dsh-qwen-connect/settings';

/** 卡片向 host 拉取状态的轮询间隔。 */
export const QWENWORK_STATUS_POLL_MS = 60_000;

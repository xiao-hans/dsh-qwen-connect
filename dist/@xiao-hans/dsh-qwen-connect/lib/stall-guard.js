/**
 * 「宣告了下一步却没调工具就收工」的判定与续跑提示。
 *
 * 实测故障模式（2026-10-28/29，pi 与 DSH 各一个 SunmiScanner 会话）：
 * qwen3.8-flash 偶尔输出「……整份重写干净：」「先把 X 改成 Y，再编译上机：」
 * 之后直接以 finish_reason=stop 收尾，没有任何工具调用。上游计费的输出 token
 * 与可见内容吻合，说明不是 shim 吞了工具调用，而是模型自己停了；agent 循环
 * 看到 stop + 无工具调用就判定回合完成，用户只能手动发「继续」。
 *
 * 本模块只做判定；由宿主（pi 扩展 / DSH 插件）在回合结束时据此自动续跑。
 * pi-provider-qwenwork 侧保留一份字节一致的副本。
 *
 * @module dsh-qwen-connect/stall-guard
 */

/** 同一条用户输入之后最多自动续跑的次数，防止模型反复宣告时无限循环。 */
export const MAX_AUTO_CONTINUES = 2;

/** 续跑时追加的提示；给模型留出「确实已完成 / 需要用户决定」的出口，误判时也无害。 */
export const CONTINUE_PROMPT =
  '你上一条回复宣布了下一步操作，但没有调用任何工具就结束了。请直接调用工具执行该步骤；' +
  '如果任务确实已完成或需要用户决定，请明确说明。';

const ENDS_WITH_COLON = /[：:]\s*$/;
// 以「我先 / 接下来 / 现在 / 马上…」开头的末句，是在宣告即将执行的动作。
const ANNOUNCES_NEXT_STEP = /^(?:好的?|开始|收到)?[，,。]?\s*我?(?:先|现在|接下来|下面|马上|这就|立即|立刻)/;
// 交还给用户的收尾（提问、请用户操作、征求同意）不是半途停止。
const HANDS_BACK_TO_USER = /[？?]\s*$|请你|请在|请先|告诉我|说一声|要我|要不要|是否需要/;

/**
 * 判断一段 assistant 末尾正文是否是「宣告了下一步却没执行」。
 * 调用方须先确认该回合没有工具调用且正常结束。
 *
 * @param {string} text 本回合的全部正文
 * @returns {boolean}
 */
export function looksLikeAbandonedStep(text) {
  const tail = text.trim().slice(-200);
  if (tail === '' || HANDS_BACK_TO_USER.test(tail)) return false;
  if (ENDS_WITH_COLON.test(tail)) return true;
  return ANNOUNCES_NEXT_STEP.test(lastSentence(tail));
}

function lastSentence(text) {
  const sentences = text
    .split(/(?<=[。！])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return sentences.at(-1) ?? '';
}

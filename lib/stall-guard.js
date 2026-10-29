/**
 * DSH 侧的「只说不做」自动续跑守卫。
 *
 * 挂在 Cordis 事件 `agent/turn-stopping` 上：
 *   dsh-agent-loop 在「本轮即将收尾、模型不再欠回复」时串行触发该钩子；
 *   若监听器调用 `agent.steer(msg)`，状态机立刻在当前轮内重读收件箱继续走，
 *   不会切入 idle（前端按钮始终保持「停止生成」，不会闪烁或退化成「发送」），
 *   也不开启新轮次。
 *
 * 硬性护栏：
 *   1. 只管 `provider === 'qwenwork'` 的回复 —— 绝不误伤同一 DSH 实例里的其他 provider；
 *   2. 同一轮内最多续跑 `MAX_AUTO_CONTINUES` 次；同一会话在两次真实用户输入之间
 *      也共享上限保护，防止跨轮死循环；
 *   3. 用户停止/取消优先于续跑：
 *      - `signal?.aborted` 为真时不续跑；
 *      - 会话一旦出现非 completed 的 `turn/end`（如 `aborted`/`error`/`interrupted`），
 *        立刻锁定 `stopped`，后续即使由后台通知/任务消息触发新回合也不再自动续跑，
 *        直到用户亲自发送下一条真实消息（`source.kind === 'user'`）才解锁；
 *      - 收件箱已有待处理输入（`agent.inbox.hasPending`）时不续跑，让位给用户输入；
 *   4. 以最后一步的 assistant 消息判定（支持多步工具调用后在最后一步半途停住的场景）；
 *   5. 任何异常吞掉并打 debug 日志 —— 续跑是锦上添花，绝不能把正常收尾打崩。
 *
 * @module stall-guard
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { QWENWORK_PROVIDER } from './models.js';
import { CONTINUE_PROMPT, detectStall, looksLikeAbandonedStep } from './stall-detector.js';

/** 单轮最多自动续跑次数。 */
export const MAX_AUTO_CONTINUES = 2;

/**
 * 在给定的 Cordis 上下文上安装守卫。
 *
 * @param {any} ctx
 * @param {{
 *   maxContinues?: number,
 *   provider?: string,
 *   logger?: { debug?: Function, info?: Function, warn?: Function },
 * }} [options]
 * @returns {() => void} 卸载函数
 */
export function installStallGuard(ctx, options = {}) {
  const maxContinues = options.maxContinues ?? MAX_AUTO_CONTINUES;
  const targetProvider = options.provider ?? QWENWORK_PROVIDER;
  const logger = options.logger ?? ctx?.logger;

  /** @type {WeakMap<object, Map<number, number>>} session -> (turn -> count) */
  const turnBudget = new WeakMap();
  /** @type {WeakMap<object, number>} session -> count since last real user message */
  const sessionBudget = new WeakMap();
  /** @type {WeakSet<object>} 用户已打断或非正常收尾、等待下一条真实用户消息的会话 */
  const stopped = new WeakSet();
  /** @type {WeakMap<object, any>} session -> 最近一条 assistant 消息（供实时事件流兜底） */
  const lastReply = new WeakMap();

  const disposeEvent =
    typeof ctx?.on === 'function'
      ? ctx.on('session/event', (session, event) => {
          if (!session || !event) return;
          switch (event.type) {
            case 'user/message':
              if (event.data?.source?.kind === 'user') {
                sessionBudget.delete(session);
                stopped.delete(session);
              }
              return;
            case 'assistant/message':
              if (event.data?.message) {
                lastReply.set(session, event.data.message);
              }
              return;
            case 'turn/end':
              if (event.data?.reason?.kind && event.data.reason.kind !== 'completed') {
                stopped.add(session);
                logger?.info?.(
                  `dsh-qwen-connect: auto-continue disarmed (turn ended ${event.data.reason.kind})`,
                );
              }
              return;
            default:
          }
        })
      : null;

  const disposeStopping = ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    try {
      if (signal?.aborted) return;
      const session = agent?.session;
      if (!session) return;

      if (stopped.has(session)) {
        logger?.info?.('dsh-qwen-connect: auto-continue skipped (session stopped by user)');
        return;
      }

      if (hasQueuedWork(agent)) {
        logger?.info?.('dsh-qwen-connect: auto-continue skipped (user input already queued)');
        return;
      }

      const last = summarizeTurn(session, turn, lastReply.get(session));
      if (!last) return;
      if (last.provider !== targetProvider) return;

      let perTurn = turnBudget.get(session);
      if (!perTurn) {
        perTurn = new Map();
        turnBudget.set(session, perTurn);
      }
      const turnUsed = perTurn.get(turn) ?? 0;
      const sessionUsed = sessionBudget.get(session) ?? 0;
      if (turnUsed >= maxContinues || sessionUsed >= maxContinues) {
        logger?.debug?.(
          `dsh-qwen-connect: stall-guard budget exhausted (turn=${turn}, turnUsed=${turnUsed}, sessionUsed=${sessionUsed})`,
        );
        return;
      }

      const res = detectStall(last.text, { toolCallCount: last.toolCallCount });
      if (!res.stall || !res.prompt) return;

      perTurn.set(turn, turnUsed + 1);
      sessionBudget.set(session, sessionUsed + 1);
      logger?.info?.(
        `dsh-qwen-connect: stall detected (turn=${turn}, attempt=${turnUsed + 1}/${maxContinues}, score=${res.score}, signals=${res.signals.join('+')}); steering continuation`,
      );

      agent.steer(
        createUserMessage({
          content: [{ type: 'text', text: res.prompt }],
          source: {
            kind: 'qwenwork-stall-continue',
            form: 'notice',
            summary: '模型宣布了下一步但未调用工具，已自动提示继续执行',
          },
        }),
      );
    } catch (err) {
      logger?.debug?.('dsh-qwen-connect: stall-guard skipped due to error', err);
    }
  });

  return () => {
    if (typeof disposeEvent === 'function') disposeEvent();
    if (typeof disposeStopping === 'function') disposeStopping();
  };
}

/**
 * 收件箱里是否已有待处理输入。投影未激活时 getter 可能抛错，按 false 处理。
 * @param {any} agent
 */
function hasQueuedWork(agent) {
  try {
    return agent?.inbox?.hasPending === true;
  } catch {
    return false;
  }
}

/**
 * 从会话事件流里取出指定轮次最后一步的 assistant 产出摘要。
 *
 * 注意：一个轮次可能先执行了若干步工具调用，在最后一步宣布「接下来我先…」后误停。
 * 因此 `toolCallCount` 与 `text` 均取自本轮最后一条 `assistant/message`，而不是整轮累加。
 *
 * @param {any} session
 * @param {number} turn
 * @param {any} [fallbackReply]
 * @returns {{ provider: string | undefined, text: string, toolCallCount: number } | null}
 */
export function summarizeTurn(session, turn, fallbackReply) {
  const events = session?.events;
  let lastMsg = null;

  if (Array.isArray(events)) {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i];
      if (!ev) continue;
      if (ev.type === 'turn/start' && ev.data?.turn === turn) break;
      if (ev.type !== 'assistant/message') continue;
      if (turn !== undefined && ev.data?.turn !== undefined && ev.data.turn !== turn) continue;
      if (ev.data?.message) {
        lastMsg = ev.data.message;
        break;
      }
    }
  }

  if (!lastMsg && fallbackReply) {
    lastMsg = fallbackReply;
  }
  if (!lastMsg) return null;

  const provider = lastMsg.source?.provider;
  let toolCallCount = 0;
  const textParts = [];
  for (const block of lastMsg.content ?? []) {
    if (!block) continue;
    if (block.type === 'tool-call') toolCallCount += 1;
    else if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
    }
  }
  return { provider, text: textParts.join('\n').trim(), toolCallCount };
}

export { CONTINUE_PROMPT, detectStall, looksLikeAbandonedStep };

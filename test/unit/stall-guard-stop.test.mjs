// test/unit/stall-guard-stop.test.mjs
//
// installStallGuard 的**装配层**行为锁定：判定口径由 stall-guard.test.mjs 覆盖，
// 这里覆盖「什么时候不该续跑」。此前这层零测试，而线上出现的正是它抢在用户停止
// 之后又开了一轮（SunmiScanner 会话 session-6c1ed57e，31 轮全部 completed，
// 用户按停止时回合正好处于轮间空档）。
//
// 依赖 @deepseek-ai/dsh-llm 的 createUserMessage，故须用真实 SDK 跑：
//   node --import ./tmp/with-dsh-sdk.mjs --test test/unit/stall-guard-stop.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installStallGuard, QWENWORK_PROVIDER } from '../../lib/index.js';
import { CONTINUE_PROMPT, MAX_AUTO_CONTINUES } from '../../lib/stall-guard.js';

const ABANDONED_TEXT = '以 Gradle 为准。先把故障脚本改成共享计数器，再编译上机：';
const FINISHED_TEXT = '状态标为待修复、待验证。需要我现在做就说一声。';

/** 记录 handler 的假 ctx，只实现 guard 用到的三个面。 */
function makeCtx() {
  const handlers = new Map();
  const logs = [];
  const ctx = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    logger: {
      info: (...args) => logs.push(['info', args]),
      warn: (...args) => logs.push(['warn', args]),
    },
  };
  return {
    ctx,
    logs,
    emit(event, ...args) {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
    handlers: (event) => handlers.get(event) ?? [],
  };
}

/**
 * 假 agent：guard 只用 status 事件里带的 agent 对象的 followup() 与 inbox.hasPending。
 * @param {{ hasPending?: boolean, followupError?: Error }} options
 */
function makeAgent(options = {}) {
  const session = {};
  const queued = [];
  let status = 'idle';
  return {
    session,
    queued,
    get status() {
      return status;
    },
    set status(next) {
      status = next;
    },
    inbox: {
      get hasPending() {
        if (options.hasPending instanceof Error) throw options.hasPending;
        return options.hasPending === true;
      },
    },
    followup(message) {
      if (options.followupError) throw options.followupError;
      queued.push(message);
      options.onFollowup?.(this, message);
    },
  };
}

/** @param {any} agent @param {string} text */
function assistantReply(agent, text) {
  return {
    role: 'assistant',
    source: { provider: QWENWORK_PROVIDER },
    content: [{ type: 'text', text }],
  };
}

function userMessage(sourceKind = 'user') {
  return { type: 'user/message', data: { source: { kind: sourceKind }, message: {} } };
}

function assistantMessage(agent, text) {
  return { type: 'assistant/message', data: { message: assistantReply(agent, text) } };
}

/** @param {'completed'|'aborted'|'error'|'interrupted'} kind */
function turnEnd(kind) {
  return { type: 'turn/end', data: { turn: 1, reason: { kind, reason: { kind: 'user' } } } };
}

function idle(agent) {
  agent.status = 'idle';
  return { agent, status: 'idle' };
}

/** 等待 installStallGuard 在 idle 回调里排入的微任务执行完。 */
async function settleIdle(harness, agent) {
  harness.emit('agent/status', idle(agent));
  await new Promise((resolve) => queueMicrotask(resolve));
}

function continuedTexts(agent) {
  return agent.queued.map((message) => message.content?.[0]?.text);
}

function skipLogs(harness) {
  return harness.logs
    .filter(([level, args]) => level === 'info' && /auto-continue (skipped|disarmed)/.test(String(args[0])))
    .map(([, args]) => String(args[0]));
}

function setup() {
  const harness = makeCtx();
  installStallGuard(harness.ctx);
  assert.equal(harness.handlers('session/event').length, 1, 'guard must subscribe session/event');
  assert.equal(harness.handlers('agent/status').length, 1, 'guard must subscribe agent/status');
  return harness;
}

test('正常收尾却宣告下一步 → 空闲后补一条续跑（既有行为不回退）', async () => {
  const harness = setup();
  const agent = makeAgent();
  harness.emit('session/event', agent.session, assistantMessage(agent, ABANDONED_TEXT));
  harness.emit('session/event', agent.session, turnEnd('completed'));
  assert.deepEqual(agent.queued, [], 'turn/end 收尾中不得直接排队');
  await settleIdle(harness, agent);
  assert.deepEqual(continuedTexts(agent), [CONTINUE_PROMPT]);
  const notice = agent.queued[0];
  assert.equal(notice.source.kind, 'qwenwork-auto-continue');
  assert.equal(notice.source.form, 'notice');
});

test('不能在 agent/status(idle) 同步回调栈内重入触发 followup，否则前端 running 状态颠倒变成发送按钮', async () => {
  const harness = setup();
  const apiSessionStatuses = [];
  // 模拟后注册的 dsh-api-session-controller：监听 agent/status 并向前端广播 api-session/status
  harness.ctx.on('agent/status', ({ status }) => {
    apiSessionStatuses.push(status === 'running');
  });

  const agent = makeAgent({
    onFollowup(target) {
      // 模拟真实 ReactLoopAgent.followup() -> wakeDriver() -> setPhase(running) 同步广播
      target.status = 'running';
      harness.emit('agent/status', { agent: target, status: 'running' });
    },
  });

  harness.emit('session/event', agent.session, assistantMessage(agent, ABANDONED_TEXT));
  harness.emit('session/event', agent.session, turnEnd('completed'));

  // 触发外层 setPhase(idle)
  harness.emit('agent/status', idle(agent));
  assert.deepEqual(agent.queued, [], '同步广播栈尚未结束时不得重入 followup');
  assert.deepEqual(apiSessionStatuses, [false], '外层 idle 广播必须先落定为 false');

  await new Promise((resolve) => queueMicrotask(resolve));
  assert.deepEqual(continuedTexts(agent), [CONTINUE_PROMPT]);
  assert.deepEqual(
    apiSessionStatuses,
    [false, true],
    '前端最终必须收到 running=true（显示停止生成按钮），绝不能颠倒成 [true, false]',
  );
});

test('总结式收尾 / 交还用户 → 不续跑', async () => {
  const harness = setup();
  const agent = makeAgent();
  harness.emit('session/event', agent.session, assistantMessage(agent, FINISHED_TEXT));
  harness.emit('session/event', agent.session, turnEnd('completed'));
  await settleIdle(harness, agent);
  assert.deepEqual(agent.queued, []);
});

test('回合被打断 → 撤销续跑意图，用户停止优先', async () => {
  const harness = setup();
  const agent = makeAgent();
  harness.emit('session/event', agent.session, assistantMessage(agent, ABANDONED_TEXT));
  harness.emit('session/event', agent.session, turnEnd('completed'));
  // 打断发生在「已排队、尚未进入 idle」之间：这是线上「按停止后它又跑一轮」的形态。
  harness.emit('session/event', agent.session, turnEnd('aborted'));
  await settleIdle(harness, agent);
  assert.deepEqual(agent.queued, [], '被打断的回合不得自动续跑');
  assert.deepEqual(skipLogs(harness), [
    'dsh-qwen-connect: auto-continue disarmed (turn ended aborted)',
  ]);
});

test('error / interrupted 收尾同样视为用户已打断，不再续跑', async () => {
  for (const kind of ['error', 'interrupted']) {
    const harness = setup();
    const agent = makeAgent();
    harness.emit('session/event', agent.session, assistantMessage(agent, ABANDONED_TEXT));
    harness.emit('session/event', agent.session, turnEnd(kind));
    await settleIdle(harness, agent);
    assert.deepEqual(agent.queued, [], `${kind} 收尾不得续跑`);
  }
});

test('收件箱已有待处理输入 → 让用户的输入开下一轮，不抢在前面', async () => {
  const harness = setup();
  const agent = makeAgent({ hasPending: true });
  harness.emit('session/event', agent.session, assistantMessage(agent, ABANDONED_TEXT));
  harness.emit('session/event', agent.session, turnEnd('completed'));
  await settleIdle(harness, agent);
  assert.deepEqual(agent.queued, []);
  assert.deepEqual(skipLogs(harness), [
    'dsh-qwen-connect: auto-continue skipped (user input already queued)',
  ]);
});

test('被打断后，由后台任务/通知开的回合不得复活续跑', async () => {
  const harness = setup();
  const agent = makeAgent();
  harness.emit('session/event', agent.session, assistantMessage(agent, ABANDONED_TEXT));
  harness.emit('session/event', agent.session, turnEnd('aborted'));
  // 真实会话里 job/settled 类通知会自己开一轮；那一轮不得被当成“用户又发言了”。
  harness.emit('session/event', agent.session, userMessage('tool-jobs'));
  harness.emit('session/event', agent.session, assistantMessage(agent, ABANDONED_TEXT));
  harness.emit('session/event', agent.session, turnEnd('completed'));
  await settleIdle(harness, agent);
  assert.deepEqual(agent.queued, [], '只有用户本人发言才能重新武装');
});

test('被打断后，用户真的再发言 → 重新武装续跑', async () => {
  const harness = setup();
  const agent = makeAgent();
  harness.emit('session/event', agent.session, assistantMessage(agent, ABANDONED_TEXT));
  harness.emit('session/event', agent.session, turnEnd('aborted'));
  await settleIdle(harness, agent);
  assert.deepEqual(agent.queued, []);

  harness.emit('session/event', agent.session, userMessage('user'));
  harness.emit('session/event', agent.session, assistantMessage(agent, ABANDONED_TEXT));
  harness.emit('session/event', agent.session, turnEnd('completed'));
  await settleIdle(harness, agent);
  assert.deepEqual(continuedTexts(agent), [CONTINUE_PROMPT], '用户重新发言后应恢复续跑');
});

test('非用户来源的消息不重置打断状态，也不清空续跑预算', async () => {
  const harness = setup();
  const agent = makeAgent();
  harness.emit('session/event', agent.session, assistantMessage(agent, ABANDONED_TEXT));
  harness.emit('session/event', agent.session, turnEnd('aborted'));
  for (const kind of ['tool-jobs', 'time-context', 'runtime-context', 'qwenwork-auto-continue']) {
    harness.emit('session/event', agent.session, userMessage(kind));
  }
  harness.emit('session/event', agent.session, assistantMessage(agent, ABANDONED_TEXT));
  harness.emit('session/event', agent.session, turnEnd('completed'));
  await settleIdle(harness, agent);
  assert.deepEqual(agent.queued, [], '后台/注入类消息不得解除用户打断');
});

test('连续续跑到上限后停止，用户发言才重新计数', async () => {
  const harness = setup();
  const agent = makeAgent();
  for (let round = 0; round < MAX_AUTO_CONTINUES + 2; round += 1) {
    harness.emit('session/event', agent.session, assistantMessage(agent, ABANDONED_TEXT));
    harness.emit('session/event', agent.session, turnEnd('completed'));
    await settleIdle(harness, agent);
  }
  assert.equal(agent.queued.length, MAX_AUTO_CONTINUES, '上限内每条都应是续跑提示');
  assert.deepEqual(continuedTexts(agent), Array(MAX_AUTO_CONTINUES).fill(CONTINUE_PROMPT));

  harness.emit('session/event', agent.session, userMessage('user'));
  harness.emit('session/event', agent.session, assistantMessage(agent, ABANDONED_TEXT));
  harness.emit('session/event', agent.session, turnEnd('completed'));
  await settleIdle(harness, agent);
  assert.equal(agent.queued.length, MAX_AUTO_CONTINUES + 1, '用户发言后预算重置');
});

test('followup 抛错只记日志，不影响后续回合', async () => {
  const harness = setup();
  const failing = makeAgent({ followupError: new Error('agent disposed') });
  harness.emit('session/event', failing.session, assistantMessage(failing, ABANDONED_TEXT));
  harness.emit('session/event', failing.session, turnEnd('completed'));
  await settleIdle(harness, failing);
  assert.deepEqual(failing.queued, []);
  assert.ok(
    harness.logs.some(([level, args]) => level === 'warn' && String(args[0]).includes('could not be queued')),
    '排队失败要留下痕迹',
  );
});

test('inbox.hasPending 读取抛错（投影未激活）时按未知处理，仍维持既有续跑', async () => {
  const harness = setup();
  const agent = makeAgent({ hasPending: new Error('projection registration is not active') });
  harness.emit('session/event', agent.session, assistantMessage(agent, ABANDONED_TEXT));
  harness.emit('session/event', agent.session, turnEnd('completed'));
  await settleIdle(harness, agent);
  assert.deepEqual(continuedTexts(agent), [CONTINUE_PROMPT]);
});

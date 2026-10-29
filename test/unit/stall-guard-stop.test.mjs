// test/unit/stall-guard-stop.test.mjs
//
// installStallGuard 的**装配层**行为锁定：判定口径由 stall-guard.test.mjs 覆盖，
// 这里覆盖 `agent/turn-stopping` + `agent.steer(...)` 的原位续跑与用户停止优先级：
//   1. 在 `agent/turn-stopping` 内调用 `agent.steer()`，当前轮不断开、前端 `running` 保持为 true（停止生成按钮常驻）；
//   2. `signal.aborted` 为真、或会话经历过非 completed 的 `turn/end`（aborted/error/interrupted）时，绝不续跑；
//   3. 被打断后由后台通知/任务开的回合不得复活续跑，直到用户本人发言（`source.kind === 'user'`）；
//   4. 收件箱已有待处理输入（`agent.inbox.hasPending`）时让位给用户输入；
//   5. 仅对 `provider === 'qwenwork'` 生效，且受单轮与跨轮 `MAX_AUTO_CONTINUES` 预算限制。
//
// 依赖 @deepseek-ai/dsh-llm 的 createUserMessage，故须用真实 SDK 跑：
//   node --import ./tmp/with-dsh-sdk.mjs --test test/unit/stall-guard-stop.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installStallGuard, QWENWORK_PROVIDER } from '../../lib/index.js';
import { CONTINUE_PROMPT, MAX_AUTO_CONTINUES } from '../../lib/stall-guard.js';

const ABANDONED_TEXT = '以 Gradle 为准。先把故障脚本改成共享计数器，再编译上机：';
const FINISHED_TEXT = '状态标为待修复、待验证。需要我现在做就说一声。';

/** 记录 handler 的假 ctx。 */
function makeCtx() {
  const handlers = new Map();
  const logs = [];
  const ctx = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      const list = handlers.get(event);
      list.push(handler);
      return () => {
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      };
    },
    logger: {
      debug: (...args) => logs.push(['debug', args]),
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
    async emitSerial(event, payload) {
      for (const handler of handlers.get(event) ?? []) {
        await handler(payload);
      }
    },
    handlers: (event) => handlers.get(event) ?? [],
  };
}

/**
 * 假 agent：模拟 `session.events`、`inbox.hasPending` 与 `steer(msg)`。
 * @param {{ hasPending?: boolean | Error, steerError?: Error }} [options]
 */
function makeAgent(options = {}) {
  const session = { events: [] };
  const steered = [];
  return {
    session,
    steered,
    inbox: {
      get hasPending() {
        if (options.hasPending instanceof Error) throw options.hasPending;
        return options.hasPending === true;
      },
    },
    steer(message) {
      if (options.steerError) throw options.steerError;
      steered.push(message);
    },
  };
}

function appendAssistant(harness, agent, text, opts = {}) {
  const turn = opts.turn ?? 1;
  const provider = opts.provider ?? QWENWORK_PROVIDER;
  const content = [];
  if (opts.toolCalls) {
    for (let i = 0; i < opts.toolCalls; i += 1) {
      content.push({ type: 'tool-call', id: `tc-${i}`, name: 'bash', input: {} });
    }
  }
  content.push({ type: 'text', text });
  const ev = {
    type: 'assistant/message',
    data: {
      turn,
      step: opts.step ?? 1,
      message: {
        role: 'assistant',
        source: { provider },
        content,
      },
    },
  };
  agent.session.events.push(ev);
  harness.emit('session/event', agent.session, ev);
}

function appendUserMessage(harness, agent, sourceKind = 'user') {
  const ev = {
    type: 'user/message',
    data: { source: { kind: sourceKind }, message: {} },
  };
  agent.session.events.push(ev);
  harness.emit('session/event', agent.session, ev);
}

/** @param {'completed'|'aborted'|'error'|'interrupted'} kind */
function appendTurnEnd(harness, agent, kind, turn = 1) {
  const ev = {
    type: 'turn/end',
    data: { turn, reason: { kind, reason: { kind: 'user' } } },
  };
  agent.session.events.push(ev);
  harness.emit('session/event', agent.session, ev);
}

async function fireTurnStopping(harness, agent, turn = 1, signal = new AbortController().signal) {
  await harness.emitSerial('agent/turn-stopping', { agent, turn, signal });
}

function steeredTexts(agent) {
  return agent.steered.map((message) => message.content?.[0]?.text);
}

function infoLogs(harness) {
  return harness.logs
    .filter(([level]) => level === 'info')
    .map(([, args]) => String(args[0]));
}

function setup() {
  const harness = makeCtx();
  const dispose = installStallGuard(harness.ctx);
  assert.equal(harness.handlers('session/event').length, 1, 'guard must subscribe session/event');
  assert.equal(
    harness.handlers('agent/turn-stopping').length,
    1,
    'guard must subscribe agent/turn-stopping',
  );
  return { ...harness, dispose };
}

test('正常收尾却宣告下一步 → 在 agent/turn-stopping 内直接 steer 原位续跑（不切 idle，停止按钮常驻）', async () => {
  const harness = setup();
  const agent = makeAgent();
  appendAssistant(harness, agent, ABANDONED_TEXT, { turn: 1 });
  await fireTurnStopping(harness, agent, 1);

  assert.deepEqual(steeredTexts(agent), [CONTINUE_PROMPT]);
  const notice = agent.steered[0];
  assert.equal(notice.source.kind, 'qwenwork-stall-continue');
  assert.equal(notice.source.form, 'notice');
});

test('多步回合在最后一步漏调工具 → 按最后一步判定并原位续跑', async () => {
  const harness = setup();
  const agent = makeAgent();
  agent.session.events.push({ type: 'turn/start', data: { turn: 2 } });
  appendAssistant(harness, agent, '先读取文件', { turn: 2, step: 1, toolCalls: 1 });
  appendAssistant(harness, agent, ABANDONED_TEXT, { turn: 2, step: 2, toolCalls: 0 });
  await fireTurnStopping(harness, agent, 2);

  assert.deepEqual(steeredTexts(agent), [CONTINUE_PROMPT]);
});

test('非 qwenwork provider 的回复绝不触发续跑', async () => {
  const harness = setup();
  const agent = makeAgent();
  appendAssistant(harness, agent, ABANDONED_TEXT, { turn: 1, provider: 'deepseek' });
  await fireTurnStopping(harness, agent, 1);
  assert.deepEqual(agent.steered, []);
});

test('总结式收尾 / 交还用户 / 确认长期规则 → 不续跑', async () => {
  const harness = setup();
  const agent = makeAgent();
  appendAssistant(harness, agent, FINISHED_TEXT, { turn: 1 });
  await fireTurnStopping(harness, agent, 1);
  assert.deepEqual(agent.steered, []);
});

test('signal.aborted 为真时（用户刚按停止）→ 立即放弃续跑', async () => {
  const harness = setup();
  const agent = makeAgent();
  appendAssistant(harness, agent, ABANDONED_TEXT, { turn: 1 });
  const ac = new AbortController();
  ac.abort({ kind: 'user' });
  await fireTurnStopping(harness, agent, 1, ac.signal);
  assert.deepEqual(agent.steered, [], '已 abort 的信号不得 steer');
});

test('回合被打断（aborted / error / interrupted）→ 锁定会话，后续后台任务回合也不得复活续跑', async () => {
  for (const kind of ['aborted', 'error', 'interrupted']) {
    const harness = setup();
    const agent = makeAgent();
    appendAssistant(harness, agent, ABANDONED_TEXT, { turn: 1 });
    appendTurnEnd(harness, agent, kind, 1);

    // 后台通知/任务自动开第 2 轮，模型又停在半途 —— 仍不得续跑
    appendUserMessage(harness, agent, 'tool-jobs');
    appendAssistant(harness, agent, ABANDONED_TEXT, { turn: 2 });
    await fireTurnStopping(harness, agent, 2);

    assert.deepEqual(agent.steered, [], `${kind} 收尾后未收到真实用户消息前不得续跑`);
    assert.ok(
      infoLogs(harness).some((msg) => msg.includes(`turn ended ${kind}`)),
      '应记录 disarmed 日志',
    );
  }
});

test('被打断后，用户本人再次发言（source.kind === "user"）→ 解除锁定并恢复续跑', async () => {
  const harness = setup();
  const agent = makeAgent();
  appendAssistant(harness, agent, ABANDONED_TEXT, { turn: 1 });
  appendTurnEnd(harness, agent, 'aborted', 1);

  appendUserMessage(harness, agent, 'user');
  appendAssistant(harness, agent, ABANDONED_TEXT, { turn: 2 });
  await fireTurnStopping(harness, agent, 2);

  assert.deepEqual(steeredTexts(agent), [CONTINUE_PROMPT], '真实用户发言后应恢复续跑');
});

test('非用户来源的消息不解除打断锁定，也不清空续跑预算', async () => {
  const harness = setup();
  const agent = makeAgent();
  appendAssistant(harness, agent, ABANDONED_TEXT, { turn: 1 });
  appendTurnEnd(harness, agent, 'aborted', 1);
  for (const kind of ['tool-jobs', 'time-context', 'runtime-context', 'qwenwork-stall-continue']) {
    appendUserMessage(harness, agent, kind);
  }
  appendAssistant(harness, agent, ABANDONED_TEXT, { turn: 2 });
  await fireTurnStopping(harness, agent, 2);
  assert.deepEqual(agent.steered, []);
});

test('收件箱已有待处理输入（hasPending === true）→ 让位给用户输入，不抢跑', async () => {
  const harness = setup();
  const agent = makeAgent({ hasPending: true });
  appendAssistant(harness, agent, ABANDONED_TEXT, { turn: 1 });
  await fireTurnStopping(harness, agent, 1);
  assert.deepEqual(agent.steered, []);
  assert.ok(
    infoLogs(harness).some((msg) => msg.includes('user input already queued')),
    '应记录让位日志',
  );
});

test('单轮与跨轮连续续跑到 MAX_AUTO_CONTINUES 上限后停止，真实用户发言后重置预算', async () => {
  const harness = setup();
  const agent = makeAgent();
  for (let i = 0; i < MAX_AUTO_CONTINUES + 2; i += 1) {
    appendAssistant(harness, agent, ABANDONED_TEXT, { turn: 1, step: i + 1 });
    await fireTurnStopping(harness, agent, 1);
  }
  assert.equal(agent.steered.length, MAX_AUTO_CONTINUES, '单轮达到上限后停止');

  // 没有真实用户发言就进入第 2 轮，跨轮预算依然受限
  appendUserMessage(harness, agent, 'tool-jobs');
  appendAssistant(harness, agent, ABANDONED_TEXT, { turn: 2, step: 1 });
  await fireTurnStopping(harness, agent, 2);
  assert.equal(agent.steered.length, MAX_AUTO_CONTINUES, '无真实用户发言时跨轮也不得突破上限');

  // 真实用户发言重置预算
  appendUserMessage(harness, agent, 'user');
  appendAssistant(harness, agent, ABANDONED_TEXT, { turn: 3, step: 1 });
  await fireTurnStopping(harness, agent, 3);
  assert.equal(agent.steered.length, MAX_AUTO_CONTINUES + 1, '真实用户发言后预算重置');
});

test('steer 抛错或 inbox.hasPending 抛错时安全兜底，不崩宿主', async () => {
  const harness = setup();
  const failing = makeAgent({ steerError: new Error('agent disposed') });
  appendAssistant(harness, failing, ABANDONED_TEXT, { turn: 1 });
  await fireTurnStopping(harness, failing, 1);
  assert.deepEqual(failing.steered, []);
  assert.ok(
    harness.logs.some(
      ([level, args]) => level === 'debug' && String(args[0]).includes('skipped due to error'),
    ),
  );

  const inactiveInbox = makeAgent({
    hasPending: new Error('projection registration is not active'),
  });
  appendAssistant(harness, inactiveInbox, ABANDONED_TEXT, { turn: 1 });
  await fireTurnStopping(harness, inactiveInbox, 1);
  assert.deepEqual(steeredTexts(inactiveInbox), [CONTINUE_PROMPT]);
});

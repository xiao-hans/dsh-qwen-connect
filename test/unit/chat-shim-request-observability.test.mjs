// 回归目标：任何一次 shim 请求都不得只留下一个孤立的 `request-in`。
//
// 2026-10-30 事故归因时踩到的坑：DSH 侧边会话在 02:36–02:38 的 502 风暴里，
// 有 33 条请求在 trace 里只写了 `request-in`，之后一行都没有，导致无法判断
// 它们是我们提前返回、客户端先挂断，还是处理器抛异常。原因有两处：
//   1) 若干提前返回分支（体过大 / JSON 非法 / 缺 messages / 缺 user 消息 /
//      签名会话构建失败）只回错误响应，不写 trace；
//   2) `res.on('close')` 在 SSE 阶段才注册，之前的断开完全不可见；
//   3) `readBody()` 在客户端写完一半就挂断时既不 end 也不 error，直接悬挂。
// 本文件用真实 HTTP 请求逐条验证这三处现在都能留下可读的终止记录。
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, test } from 'node:test';
import { readFile } from 'node:fs/promises';

import './trace-sandbox.mjs';

const { startChatShim } = await import('../../lib/chat-shim.js');
const { traceLogPath } = await import('../../lib/trace.js');

const SECRET = 'request-observability-test';

async function readTrace() {
  try {
    const text = await readFile(traceLogPath(), 'utf8');
    const trimmed = text.trim();
    return trimmed === '' ? [] : trimmed.split('\n').map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** 从 afterCount 起等待新行出现（客户端中途挂断时没有响应可等）。 */
async function waitForNewRows(afterCount, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let rows = await readTrace();
  while (rows.length <= afterCount && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    rows = await readTrace();
  }
  assert.ok(rows.length > afterCount, `no trace row appeared after request #${afterCount}`);
  return rows.slice(afterCount);
}

async function startShim(t) {
  // 上游对多数用例不会被触碰（都在写上游之前返回）；给一个立刻返回错误状态
  // 的哑上游，保证「走漏到上游」在用例里也是可观察的。
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(500);
    res.end('{}');
  });
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    const closed = new Promise((resolve) => upstream.close(resolve));
    upstream.closeAllConnections();
    await closed;
  });
  const endpoint = `http://127.0.0.1:${upstream.address().port}/agent_chat_generation`;
  const shim = await startChatShim({
    endpoint,
    sharedSecret: SECRET,
    getCredential: async () => ({ token: 'synthetic-test-token' }),
    getIdleTimeoutMs: 2000,
    signerFactory: async () => ({
      signInferRequest: () => ({ url: endpoint, headers: { 'Content-Type': 'application/json' }, body: '{}' }),
    }),
  });
  t.after(() => shim.close());
  return shim;
}

function post(shim, body, headers = {}) {
  return fetch(shim.baseUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json', ...headers },
    body,
  });
}

test('invalid JSON body is reported as a traced rejection, not a bare request-in', { timeout: 8000 }, async (t) => {
  const shim = await startShim(t);
  const before = (await readTrace()).length;
  const response = await post(shim, 'this is not json {{{');
  assert.equal(response.status, 400);

  const rows = await waitForNewRows(before);
  const reject = rows.filter((row) => row.event === 'reject');
  assert.equal(reject.length, 1, JSON.stringify(rows));
  assert.equal(reject[0].reason, 'invalid-json');
  assert.equal(reject[0].status, 400);
  assert.ok(Number.isFinite(reject[0].ms));
  assert.match(reject[0].requestId, /^[0-9a-f-]{36}$/);
});

test('missing messages is reported as a traced rejection', { timeout: 8000 }, async (t) => {
  const shim = await startShim(t);
  const before = (await readTrace()).length;
  const response = await post(shim, JSON.stringify({ model: 'qwen3.8-flash', messages: [] }));
  assert.equal(response.status, 400);

  const rows = await waitForNewRows(before);
  const reject = rows.filter((row) => row.event === 'reject');
  assert.equal(reject.length, 1, JSON.stringify(rows));
  assert.equal(reject[0].reason, 'no-messages');
});

test('a body without any user message is reported as a traced rejection', { timeout: 8000 }, async (t) => {
  const shim = await startShim(t);
  const before = (await readTrace()).length;
  const response = await post(
    shim,
    JSON.stringify({ model: 'qwen3.8-flash', messages: [{ role: 'system', content: 'synthetic system' }] }),
  );
  assert.equal(response.status, 400);

  const rows = await waitForNewRows(before);
  const reject = rows.filter((row) => row.event === 'reject');
  assert.equal(reject.length, 1, JSON.stringify(rows));
  assert.equal(reject[0].reason, 'no-user-message');
});

test('an oversize body is reported as body-too-large', { timeout: 20000 }, async (t) => {
  const shim = await startShim(t);
  const before = (await readTrace()).length;
  // 8MiB 上限之上留足余量：JSON 本身合法，唯一问题是体积。
  const huge = JSON.stringify({
    model: 'qwen3.8-flash',
    messages: [{ role: 'user', content: 'x'.repeat(9 * 1024 * 1024) }],
  });
  const response = await post(shim, huge);
  assert.equal(response.status, 413);

  const rows = await waitForNewRows(before);
  const reject = rows.filter((row) => row.event === 'reject');
  assert.equal(reject.length, 1, JSON.stringify(rows));
  assert.equal(reject[0].reason, 'body-too-large');
  assert.equal(reject[0].status, 413);
});

test('a client that hangs up mid-upload leaves a terminal record with the stage', { timeout: 12000 }, async (t) => {
  const shim = await startShim(t);
  const before = (await readTrace()).length;
  await new Promise((resolve, reject) => {
    const req = http.request(
      shim.baseUrl,
      { method: 'POST', headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' } },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('error', () => resolve());
    // 只写半截 JSON 就拆连接：旧版本在此处悬挂，永远只留下 request-in。
    req.write('{"model":"qwen3.8-flash","messages":[{"role":"user","content":"synthetic partial');
    setTimeout(() => {
      req.destroy();
      resolve();
    }, 120);
  });

  const rows = await waitForNewRows(before);
  const terminal = rows.filter((row) => row.event === 'reject' || row.event === 'request-end');
  assert.equal(terminal.length, 1, JSON.stringify(rows));
  const last = terminal[0];
  assert.ok(
    last.reason === 'body-read-failed' || (last.event === 'request-end' && last.stage === 'request-in'),
    JSON.stringify(last),
  );
  assert.ok(Number.isFinite(last.ms));
  // 断掉的连接上不可能有成功的上游调用。
  assert.equal(rows.some((row) => row.event === 'upstream-headers'), false);
});

test('every traced request belongs to exactly one requestId and leaks no payload', { timeout: 20000 }, async (t) => {
  const shim = await startShim(t);
  const before = (await readTrace()).length;
  const responses = await Promise.all([
    post(shim, JSON.stringify({ model: 'qwen3.8-flash', messages: [{ role: 'user', content: 'synthetic probe needle' }] })),
    post(shim, 'broken json {'),
  ]);
  // 哑上游回 500：该请求的终止记录是 upstream-rejected（状态码透传）。
    assert.equal(responses[0].status, 500);
  assert.equal(responses[1].status, 400);

  const rows = await waitForNewRows(before);
  const ids = new Set(rows.map((row) => row.requestId));
  assert.equal(ids.size, 2, JSON.stringify(rows));
  for (const id of ids) {
    const mine = rows.filter((row) => row.requestId === id);
    assert.equal(mine.filter((row) => row.event === 'request-in').length, 1);
    assert.ok(mine.length > 1, `requestId ${id} left a bare request-in`);
    // 每个请求恰好一条终止记录。
    const terminals = mine.filter((row) =>
      ['reject', 'upstream-fail', 'upstream-rejected', 'stream-end', 'request-end'].includes(row.event),
    );
    assert.equal(terminals.length, 1, JSON.stringify(mine));
  }
  const all = await readFile(traceLogPath(), 'utf8');
  for (const secret of ['synthetic probe needle', 'synthetic-test-token', SECRET, 'broken json']) {
    assert.equal(all.includes(secret), false, `trace leaked ${secret}`);
  }
});

after(() => {});

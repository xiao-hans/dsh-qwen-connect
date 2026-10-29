import assert from 'node:assert/strict';
import http from 'node:http';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 把本测试进程的 trace 写入重定向到项目内临时目录：故障注入用例（500ms 看门狗）
// 必须与真实排障日志隔，否则测试伪数据会被误当成线上事故。
const tmpRoot = fileURLToPath(new URL('../../tmp/', import.meta.url));
await mkdir(tmpRoot, { recursive: true });
const traceDir = await mkdtemp(path.join(tmpRoot, 'stream-robustness-'));
const tracePath = path.join(traceDir, 'trace.log');
const previousTracePath = process.env.QWEN_CONNECT_TRACE_PATH;
process.env.QWEN_CONNECT_TRACE_PATH = tracePath;
const { startChatShim } = await import('../../lib/chat-shim.js');
const { SseParser } = await import('../../lib/sse.js');
const { traceLogPath } = await import('../../lib/trace.js');
after(async () => {
  if (previousTracePath === undefined) delete process.env.QWEN_CONNECT_TRACE_PATH;
  else process.env.QWEN_CONNECT_TRACE_PATH = previousTracePath;
  await rm(traceDir, { recursive: true, force: true });
});

function qwenFrame(body) {
  return `data: ${JSON.stringify({ body: JSON.stringify(body) })}\n\n`;
}

function readFrames(text) {
  const parser = new SseParser();
  const frames = parser.push(text).map((payload) => JSON.parse(payload));
  assert.equal(parser.done, true);
  return frames;
}

async function readRequestTrace(frames) {
  const responseId = frames.find((frame) => typeof frame.id === 'string')?.id;
  assert.match(responseId, /^chatcmpl-[0-9a-f-]{36}$/);
  const requestId = responseId.slice('chatcmpl-'.length);
  const text = await readFile(traceLogPath(), 'utf8');
  const rows = text.trim().split('\n').map((line) => JSON.parse(line))
    .filter((row) => row.requestId === requestId);
  assert.ok(rows.some((row) => row.event === 'request-in'));
  assert.ok(rows.every((row) => row.pid === process.pid && row.source === 'dsh-qwen-connect'));
  assert.equal(rows.find((row) => row.event === 'stream-end')?.responseId, responseId);
  return { rows, text, requestId };
}

async function startFixture(t, respond, idleTimeoutMs = 80) {
  let requests = 0;
  const upstream = http.createServer((req, res) => {
    requests += 1;
    req.resume();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('X-Request-ID', 'synthetic-upstream-request-id');
    res.setHeader('Authorization', 'sensitive-response-header');
    respond(res);
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
    sharedSecret: 'stream-regression-test',
    getCredential: async () => ({ token: 'synthetic-test-token' }),
    getIdleTimeoutMs: idleTimeoutMs,
    signerFactory: async () => ({
      signInferRequest: () => ({
        url: endpoint,
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    }),
  });
  t.after(() => shim.close());
  return {
    get requests() {
      return requests;
    },
    request: (signal) =>
      fetch(shim.baseUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${shim.sharedSecret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'qwen3.8-flash',
          messages: [{ role: 'user', content: 'synthetic stream regression' }],
          stream: true,
        }),
        signal,
      }),
  };
}

test('partial thinking followed by silence emits one explicit timeout and aborts upstream', { timeout: 5000 }, async (t) => {
  let onUpstreamClosed;
  const upstreamClosed = new Promise((resolve) => {
    onUpstreamClosed = resolve;
  });
  const fixture = await startFixture(t, (res) => {
    res.once('close', onUpstreamClosed);
    res.write(qwenFrame({ choices: [{ delta: { reasoning_content: 'synthetic thinking' } }] }));
  });

  const response = await fixture.request();
  assert.equal(response.status, 200);
  const text = await response.text();
  const frames = readFrames(text);
  const errors = frames.filter((frame) => frame.error);
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0].error, {
    message: 'upstream idle timeout: no data for 80ms',
    type: 'api_error',
  });
  assert.ok(frames.some((frame) => frame.choices?.[0]?.delta?.reasoning_content === 'synthetic thinking'));
  assert.equal(frames.some((frame) => frame.choices?.[0]?.finish_reason), false);
  assert.equal((text.match(/\[DONE\]/g) ?? []).length, 1);
  const { rows, text: traceText } = await readRequestTrace(frames);
  const timeout = rows.find((row) => row.event === 'idle-watchdog-fired');
  const end = rows.find((row) => row.event === 'stream-end');
  assert.equal(timeout.lastChunkAt, end.lastChunkAt);
  assert.ok(Number.isFinite(Date.parse(timeout.lastChunkAt)));
  assert.ok(timeout.idleMs >= 0);
  assert.ok(timeout.upstreamChunks >= 1);
  assert.ok(timeout.upstreamBytes > 0);
  assert.equal(timeout.thinkingChars, 'synthetic thinking'.length);
  assert.equal(timeout.outputChars, 0);
  assert.equal(timeout.toolCallsEmitted, false);
  assert.equal(timeout.usageSeen, false);
  assert.ok(Number.isFinite(timeout.watchdogDelayMs));
  assert.equal(timeout.eventLoopDelayMs.resolutionMs, 20);
  assert.ok(timeout.eventLoopDelayMs.max > 0);
  assert.deepEqual(end.upstreamRequestIds, { 'x-request-id': 'synthetic-upstream-request-id' });
  assert.equal(end.abortReason, 'upstream idle timeout');
  for (const secret of ['synthetic thinking', 'synthetic stream regression', 'synthetic-test-token', 'stream-regression-test', 'sensitive-response-header']) {
    assert.equal(traceText.includes(secret), false);
  }
  await upstreamClosed;
  assert.equal(fixture.requests, 1);
});

test('a normal response keeps its stop reason and real usage', { timeout: 5000 }, async (t) => {
  const fixture = await startFixture(t, (res) => {
    res.end(
      qwenFrame({ choices: [{ delta: { content: 'ok' } }] }) +
        qwenFrame({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          raw_usage: { data: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
        }) +
        'data: [DONE]\n\n',
    );
  });

  const response = await fixture.request();
  const frames = readFrames(await response.text());
  assert.equal(frames.some((frame) => frame.error), false);
  const finishFrames = frames.filter((frame) => frame.choices?.[0]?.finish_reason);
  assert.equal(finishFrames.length, 1);
  assert.equal(finishFrames[0].choices[0].finish_reason, 'stop');
  assert.deepEqual(finishFrames[0].usage, {
    prompt_tokens: 3,
    completion_tokens: 2,
    total_tokens: 5,
  });
  assert.equal(fixture.requests, 1);
  const { rows } = await readRequestTrace(frames);
  const end = rows.find((row) => row.event === 'stream-end');
  assert.equal(end.finished, true);
  assert.equal(end.idleFired, false);
  assert.equal(end.usageSeen, true);
  assert.equal(end.abortReason, null);
});

test('client cancellation aborts the current upstream without replaying it', { timeout: 10000 }, async (t) => {
  let onUpstreamClosed;
  const upstreamClosed = new Promise((resolve) => {
    onUpstreamClosed = resolve;
  });
  const fixture = await startFixture(t, (res) => {
    res.once('close', onUpstreamClosed);
    res.write(qwenFrame({ choices: [{ delta: { reasoning_content: 'synthetic thinking' } }] }));
  }, 1000);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fixture.request(controller.signal);
  const reader = response.body.getReader();
  assert.equal((await reader.read()).done, false);
  controller.abort();
  await assert.rejects(reader.read(), { name: 'AbortError' });
  await upstreamClosed;
  assert.equal(fixture.requests, 1);
});

test('concurrent requests keep separate response IDs and trace records', { timeout: 5000 }, async (t) => {
  const fixture = await startFixture(t, (res) => {
    res.end(qwenFrame({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
  });
  const responses = await Promise.all([fixture.request(), fixture.request()]);
  const frames = await Promise.all(responses.map(async (response) => readFrames(await response.text())));
  const traces = await Promise.all(frames.map((items) => readRequestTrace(items)));
  assert.notEqual(traces[0].requestId, traces[1].requestId);
  for (const { rows } of traces) {
    assert.equal(rows.filter((row) => row.event === 'request-in').length, 1);
    assert.equal(rows.filter((row) => row.event === 'stream-end').length, 1);
  }
  assert.equal(fixture.requests, 2);
});

test('a blocked event loop is visible in the watchdog diagnostics', { timeout: 5000 }, async (t) => {
  const fixture = await startFixture(t, (res) => {
    res.write(qwenFrame({ choices: [{ delta: { reasoning_content: 'synthetic thinking' } }] }));
  });
  const response = await fixture.request();
  // Deliberately block only this synthetic test process after the histogram has sampled.
  const blocker = setTimeout(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 160), 30);
  t.after(() => clearTimeout(blocker));
  const { rows } = await readRequestTrace(readFrames(await response.text()));
  const timeout = rows.find((row) => row.event === 'idle-watchdog-fired');
  const end = rows.find((row) => row.event === 'stream-end');
  assert.ok(timeout.watchdogDelayMs >= 50, JSON.stringify(timeout));
  assert.ok(end.eventLoopDelayMs.max >= 100, JSON.stringify(end));
});

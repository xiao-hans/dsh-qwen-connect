/**
 * 回归测试：header 超时不得掐死 body 流（2026-10-28 事故）。
 *
 * 事故回放：pi 会话里 thinkingLevel=high 的长思考请求，响应头秒回、
 * reasoning deltas 正常流 ~175s，到 180.0s 整被
 * `The operation was aborted due to timeout` 掐死，pi 重试 4 次全挂。
 *
 * 根因：fetchUpstreamWithRetry 用 AbortSignal.timeout(headerTimeoutMs) 作为
 * fetch signal —— undici 把它绑到整个请求生命周期（含 body 流），
 * 「header 超时」实际成了「全响应硬上限」。
 *
 * 修复：可清除的 AbortController + setTimeout，headers 到手即 clearTimeout。
 * 本文件两个用例分别锁住修复的两半：
 *   ① headers 秒回 + body 流总时长 > headerTimeoutMs → 必须完整收尾；
 *   ② headers 永不来 → header 超时仍生效（~headerTimeoutMs 后 502，不重试）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createChatShimHandler } from '../../lib/chat-shim.js';

// ---------------------------------------------------------------------------
// 工具（与 stream-robustness.test.mjs 同构，刻意保持独立以便单独跑）
// ---------------------------------------------------------------------------

const sleep = (ms) => {
  // unref：测试结束后残留定时器不得拖住 node --test 进程退出。
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
};

/** 构造一个上游风格的信封帧。 */
function envelope(body, extra = {}) {
  return `data:${JSON.stringify({ ...extra, body: typeof body === 'string' ? body : JSON.stringify(body) })}`;
}

/** 构造一个模型分块帧。 */
function chunkFrame(delta, finishReason = undefined) {
  return envelope(
    JSON.stringify({
      choices: [{ delta, index: 0, ...(finishReason === undefined ? {} : { finish_reason: finishReason }) }],
      object: 'chat.completion.chunk',
    }),
    { statusCodeValue: 200, statusCode: 'OK', headers: { 'X-Model-Name': ['flash'] } },
  );
}

/**
 * 起一个可控节奏的假上游：
 * - headerDelayMs：推迟 writeHead（模拟上游连响应头都不给）；
 * - pieces/pieceDelayMs：200 后逐帧慢推（模拟长思考流）。
 */
function startPacedUpstream({ headerDelayMs = 0, pieces = [], pieceDelayMs = 250 } = {}) {
  const server = http.createServer(async (req, res) => {
    req.resume();
    await new Promise((r) => req.on('end', r));
    try {
      if (headerDelayMs > 0) await sleep(headerDelayMs);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const piece of pieces) {
        res.write(piece);
        await sleep(pieceDelayMs);
      }
      res.end();
    } catch {
      /* 客户端已中止（用例②的正常路径） */
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => {
          server.closeAllConnections?.();
          return new Promise((d) => server.close(() => d()));
        },
      });
    });
  });
}

/** 起 shim（假签名器直连假上游），可注入 header/idle 超时。 */
function startShim(upstreamUrl, opts = {}) {
  const sharedSecret = 'test-shared-secret';
  const handler = createChatShimHandler({
    getCredential: async () => ({ token: 'fake-token', user: { id: 'u1' }, loginDeviceId: 'dev-1' }),
    endpoint: upstreamUrl,
    sharedSecret,
    signerFactory: async () => ({
      describe: () => ({}),
      dispose: () => {},
      signInferRequest: (bodyJson) => ({
        url: upstreamUrl,
        headers: { 'Content-Type': 'application/json' },
        body: bodyJson,
        headerCount: 1,
      }),
    }),
    ...opts,
  });
  const server = http.createServer((req, res) => {
    if (!req.url || !req.url.startsWith('/v1/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    handler(req, res).catch(() => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
        secret: sharedSecret,
        close: () => new Promise((d) => server.close(() => d())),
      });
    });
  });
}

/** 收集 OpenAI SSE 帧（data: 负载数组）。 */
async function collectSse(res) {
  const frames = [];
  const decoder = new TextDecoder();
  let buf = '';
  for await (const c of res.body) {
    buf += decoder.decode(c, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const p = line.slice(5).trim();
      if (p === '') continue;
      frames.push(p);
    }
  }
  return frames;
}

const CHAT_BODY = JSON.stringify({
  model: 'flash',
  messages: [{ role: 'user', content: '长思考测试' }],
});

const CHAT_HEADERS = { 'Content-Type': 'application/json' };

// ---------------------------------------------------------------------------
// 用例①：慢流必须活过 header 超时（修复前在 800ms 处被掐死）
// ---------------------------------------------------------------------------

test('shim: headers 到手后，body 流总时长超过 headerTimeoutMs 仍完整收尾', async () => {
  // 节奏：8 帧 × 250ms ≈ 2000ms，远超 headerTimeoutMs=800。
  // 修复前：AbortSignal.timeout(800) 绑住 body 流 → ~800ms 抛 TimeoutError
//           → 流内 error 帧（message 含 aborted due to timeout）。
  const pieces = [
    ...Array.from({ length: 6 }, () => chunkFrame({ reasoning_content: '思' }) + '\n\n'),
    chunkFrame({ content: '好' }) + '\n\n',
    chunkFrame({}, 'stop') + '\n\n',
  ];
  const upstream = await startPacedUpstream({ pieces, pieceDelayMs: 250 });
  const shim = await startShim(upstream.url, {
    getHeaderTimeoutMs: 800,
    getIdleTimeoutMs: 10_000, // 帧间隔 250ms，idle 不该掺和
  });
  try {
    const t0 = Date.now();
    const res = await fetch(shim.base, {
      method: 'POST',
      headers: { ...CHAT_HEADERS, Authorization: `Bearer ${shim.secret}` },
      body: CHAT_BODY,
    });
    assert.equal(res.status, 200);
    const frames = await collectSse(res);
    const ms = Date.now() - t0;

    // 流总时长确实越过了 header 超时窗口 —— 这是本测试成立的前提。
    assert.ok(ms > 800, `流应慢于 headerTimeoutMs 跑完，实测 ${ms}ms`);

    const parsed = frames.filter((f) => f !== '[DONE]').map((f) => JSON.parse(f));
    const errFrame = parsed.find((p) => p.error !== undefined);
    assert.equal(errFrame, undefined, `不得出现错误帧：${JSON.stringify(errFrame?.error)}`);

    // 内容完整到达：6 个思考帧 + 1 个正文帧 + finish 帧。
    const content = parsed
      .flatMap((p) => p.choices ?? [])
      .map((c) => c.delta?.content ?? '')
      .join('');
    assert.equal(content, '好');
    const reasoning = parsed
      .flatMap((p) => p.choices ?? [])
      .map((c) => c.delta?.reasoning_content ?? c.delta?.reasoning ?? '')
      .join('');
    assert.equal(reasoning, '思思思思思思');

    const finish = parsed.flatMap((p) => p.choices ?? []).find((c) => c.finish_reason);
    assert.ok(finish, '应有 finish_reason 帧');
    assert.equal(finish.finish_reason, 'stop');
    assert.equal(frames.at(-1), '[DONE]');
  } finally {
    await shim.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// 用例②：headers 永不来 → header 超时仍生效，且不重试（快速失败）
// ---------------------------------------------------------------------------

test('shim: headers 迟迟不来时按 headerTimeoutMs 失败（502），单次尝试不重试', async () => {
  const upstream = await startPacedUpstream({ headerDelayMs: 4000, pieces: [] });
  const shim = await startShim(upstream.url, {
    getHeaderTimeoutMs: 800,
    getIdleTimeoutMs: 10_000,
  });
  try {
    const t0 = Date.now();
    const res = await fetch(shim.base, {
      method: 'POST',
      headers: { ...CHAT_HEADERS, Authorization: `Bearer ${shim.secret}` },
      body: CHAT_BODY,
    });
    const ms = Date.now() - t0;
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.match(body.error.message, /timeout|aborted/i);
    // 超时不重试：总耗时 ≈ 一个 headerTimeoutMs 窗口（远小于 2×800 + 退避）。
    assert.ok(ms < 2000, `应单次快速失败，实测 ${ms}ms`);
  } finally {
    await shim.close();
    await upstream.close();
  }
});

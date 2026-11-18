// research/probe-flash-thinking.mjs
// 用 hermes 实际模型 qwen3.8-flash 复现"整份回答进思考通道"并测试关思考字段。
import { createSignerSession } from '../../lib/signer-session.js';
import { resolveGatewayEndpoint } from '../../lib/endpoint.js';
import { getValidCredential } from '../../lib/credentials-seam.js';

const credential = await getValidCredential();
const session = await createSignerSession({
  credential,
  endpoint: resolveGatewayEndpoint(credential),
});

const FILLER = '当前记忆条目：'.repeat(800);
const TEXT = `你是记忆回顾器。${FILLER}\n请只输出 JSON：{"ok":true,"note":"done"}`;

function buildBody(text, variant, modelKey) {
  const rid = globalThis.crypto.randomUUID();
  let parameters = { max_tokens: 32000 };
  let mc = { key: modelKey, source: 'system' };
  let innerMc = { key: modelKey, source: 'system' };
  if (variant === 'baseline') {
    // 现状：is_reasoning:true 能力位
    mc.is_reasoning = true; innerMc.is_reasoning = true;
  } else if (variant === 'off-sdk-style') {
    // 官方 SDK thinking off 的等价形态：is_reasoning 降级 false + reasoning_effort none
    mc.is_reasoning = false; innerMc.is_reasoning = false;
    parameters.reasoning_effort = 'none';
  } else if (variant === 'off-enable-thinking') {
    mc.is_reasoning = false; innerMc.is_reasoning = false;
    parameters.enable_thinking = false;
  } else if (variant === 'low-effort') {
    // hermes llmThinkingOverride="low" 走到 pi-ai openai 路径会发的字段。
    // 2026-11-08 两轮实测：reasoning_effort='low' 对思考量无稳定影响
    // （134~262 字符波动，与 baseline 同分布），上游同样无视该字段。
    mc.is_reasoning = true; innerMc.is_reasoning = true;
    parameters.reasoning_effort = 'low';
  }
  return JSON.stringify({
    request_id: rid,
    request_set_id: rid,
    chat_record_id: rid,
    session_id: `sess-${Date.now().toString(36)}`,
    stream: true,
    chat_task: 'FREE_INPUT',
    chat_context: {
      text,
      features: [],
      extra: { context: [], modelConfig: innerMc, originalContent: text },
      chatPrompt: '',
      imageUrls: null,
    },
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    agent_id: 'agent_common',
    task_id: 'common',
    session_type: 'qoder_work',
    aliyun_user_type: '',
    model_config: {
      key: modelKey, display_name: modelKey, model: '', format: 'openai',
      is_vl: true, is_reasoning: mc.is_reasoning ?? false, api_key: '', url: '', source: 'system',
      max_input_tokens: 1000000,
    },
    messages: [{ role: 'user', content: text }],
    tools: [],
    parameters,
  });
}

async function run(variant, modelKey) {
  const body = buildBody(TEXT, variant, modelKey);
  const signed = session.signInferRequest(body, { modelKey, modelSource: 'system' });
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(signed.url, { method: 'POST', headers: signed.headers, body: signed.body });
  } catch (e) {
    return { variant, modelKey, err: e.message.slice(0, 80) };
  }
  if (!res.ok) return { variant, modelKey, err: `HTTP ${res.status}: ${(await res.text()).slice(0, 100)}` };
  const decoder = new TextDecoder('utf-8');
  let buf = '', content = '', reasoning = '', code = null;
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    const evs = buf.split('\n\n'); buf = evs.pop() ?? '';
    for (const e of evs) {
      if (!e.startsWith('data:')) continue;
      const p = e.slice(5).trim();
      if (!p || p === '[DONE]') continue;
      try {
        const o = JSON.parse(p);
        const inner = typeof o.body === 'string' ? JSON.parse(o.body) : o;
        if (inner.code && String(inner.code) !== '200') code = inner.message ?? String(inner.code);
        const d = inner.choices?.[0]?.delta ?? {};
        if (d.content) content += d.content;
        if (d.reasoning_content) reasoning += d.reasoning_content;
      } catch {}
    }
  }
  return { variant, modelKey, ms: Date.now() - t0, content: content.length, reasoning: reasoning.length, code,
    head: (content || reasoning).slice(0, 60) };
}

for (const modelKey of ['flash']) {
  for (const variant of ['baseline', 'off-sdk-style', 'off-enable-thinking', 'low-effort']) {
    const r = await run(variant, modelKey);
    if (r.err) console.log(`${modelKey} ${r.variant}: ❌ ${r.err}`);
    else console.log(`${modelKey} ${r.variant}: ${((r.ms)/1000).toFixed(1)}s | 正文${r.content} 思考${r.reasoning}${r.code?' | '+r.code:''} | ${JSON.stringify(r.head)}`);
  }
}

await session.dispose?.();
process.exit(0);

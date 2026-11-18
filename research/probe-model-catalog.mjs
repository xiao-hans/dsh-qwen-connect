#!/usr/bin/env node
/**
 * 只读探针：验证签名后的 `GET /api/v2/model/list` 是否被上游接受。
 *
 * 目的（t-dynamic-catalog 第一步）：确认「动态模型目录」到底是
 *   (a) 端点存在、只是需要 WASM 签名  → 可接，
 *   (b) 端点对本账号不开放            → 维持静态目录，不编造。
 *
 * 边界：
 *   - 只发 GET，**不走推理**，不消耗任何额度；
 *   - 不打印 token / masterKey / 签名值，只打印 header 名与状态码；
 *   - 响应体里的 JWT 一律掩码后才输出。
 *
 * 用法：node research/probe-model-catalog.mjs
 */
import { getValidCredential } from '../lib/credentials-seam.js';
import { createSignerSession } from '../lib/signer-session.js';
import { resolveGatewayEndpoint, relaxTlsForVpc } from '../lib/endpoint.js';

const PATH = '/api/v2/model/list';
const MODES = ['auth', 'sign', 'infer', 'post'];

/** 输出脱敏：JWT / Bearer / 长 base64 签名一律不落屏。 */
function mask(text) {
  return String(text)
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, 'eyJ…<masked>')
    .replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer <masked>')
    .replace(/([?&](?:token|access_token|signature|sign)=)[^&\s]+/gi, '$1<masked>');
}

function summarize(payload) {
  if (payload === null || typeof payload !== 'object') return { shape: typeof payload };
  if (Array.isArray(payload)) return { shape: 'array', length: payload.length, first: payload[0] };
  const keys = Object.keys(payload);
  const out = { shape: 'object', keys };
  for (const k of ['data', 'models', 'model_list', 'list', 'result']) {
    const v = payload[k];
    if (Array.isArray(v)) {
      out.arrayField = k;
      out.length = v.length;
      out.first = v[0];
      out.ids = v.map((m) => m?.key ?? m?.model_key ?? m?.id ?? m?.name ?? null);
    } else if (v !== null && typeof v === 'object') {
      out.objectField = k;
      out.subKeys = Object.keys(v);
    }
  }
  return out;
}

async function main() {
  const credential = await getValidCredential();
  const endpoint = resolveGatewayEndpoint(credential);
  const doFetch = relaxTlsForVpc(endpoint);
  console.log(`endpoint = ${endpoint}`);
  console.log(`credential: token=${credential?.token ? 'present' : 'MISSING'} user=${credential?.user?.id ? 'present' : 'MISSING'}`);

  const session = await createSignerSession({ credential, endpoint });
  console.log(`session.describe = ${JSON.stringify(session.describe?.() ?? {})}`);

  const results = [];
  for (const mode of MODES) {
    let signed;
    try {
      signed = session.signRequest({ path: PATH, method: 'GET', mode });
    } catch (error) {
      console.log(`\n[mode=${mode}] signRequest THREW: ${error?.message ?? error}`);
      results.push({ mode, stage: 'sign', ok: false });
      continue;
    }
    const headerNames = Object.keys(signed.headers ?? {});
    console.log(`\n[mode=${mode}] url = ${mask(signed.url)}`);
    console.log(`[mode=${mode}] header names = ${headerNames.join(', ')}`);
    console.log(`[mode=${mode}] body = ${signed.body === undefined || signed.body === '' ? '(empty)' : `${String(signed.body).length} bytes`}`);

    let response;
    try {
      response = await doFetch(signed.url, {
        method: 'GET',
        headers: signed.headers,
        signal: AbortSignal.timeout(25000),
      });
    } catch (error) {
      console.log(`[mode=${mode}] fetch THREW: ${error?.message ?? error}`);
      results.push({ mode, stage: 'fetch', ok: false });
      continue;
    }
    const text = await response.text();
    console.log(`[mode=${mode}] HTTP ${response.status} · ${text.length} bytes`);
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      console.log(`[mode=${mode}] non-JSON head: ${mask(text.slice(0, 240))}`);
    }
    if (payload !== null) {
      console.log(`[mode=${mode}] summary = ${mask(JSON.stringify(summarize(payload), null, 2)).slice(0, 2400)}`);
    }
    results.push({ mode, stage: 'http', status: response.status, ok: response.ok, bytes: text.length });
    if (response.ok && payload !== null) {
      // 命中即停：避免同一账号连打四次
      console.log('\n>>> 命中：该 mode 可用于动态模型目录。完整响应见下方 dump。');
      console.log(mask(JSON.stringify(payload, null, 2)).slice(0, 6000));
      break;
    }
  }

  session.dispose?.();
  console.log(`\n=== 汇总 ===\n${JSON.stringify(results, null, 2)}`);
}

main().catch((error) => {
  console.error('probe failed:', error?.stack ?? error);
  process.exitCode = 1;
});

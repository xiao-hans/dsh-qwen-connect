/**
 * 测试专用：把 shim 的 trace 诊断写入隔离到项目内临时目录。
 *
 * 为什么需要它：lib/trace.js 写的是 os.tmpdir() 下的共享文件，而 DSH 与
 * pi-provider-qwenwork 两个插件用同一个文件名。故障注入用例（例如 500ms
 * 看门狗）会往里写伪数据，混进用户真正用来排障的日志里就会被误读成线上事故
 * （2026-10-29 实际踩过：三条 unit-test 伪 watchfire 出现在真实日志窗口内）。
 *
 * 用法：在测试文件顶部 `import './trace-sandbox.mjs';`（副作用导入）。
 * trace.js 在每次写入时才解析路径，因此静态 import 的顺序不影响隔离效果。
 */
import { after } from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmpRoot = fileURLToPath(new URL('../../tmp/', import.meta.url));
await mkdir(tmpRoot, { recursive: true });
const traceDir = await mkdtemp(path.join(tmpRoot, 'trace-sandbox-'));

const previous = process.env.QWEN_CONNECT_TRACE_PATH;
process.env.QWEN_CONNECT_TRACE_PATH = path.join(traceDir, 'trace.log');

after(async () => {
  if (previous === undefined) delete process.env.QWEN_CONNECT_TRACE_PATH;
  else process.env.QWEN_CONNECT_TRACE_PATH = previous;
  await rm(traceDir, { recursive: true, force: true });
});

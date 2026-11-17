// 明文文件凭据：只用临时目录，不读不写真实 home 或真实凭据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCredentials, probeCredentials, normalizeCredentials } from '../../lib/credentials.js';
import { persistRefreshedCredentials } from '../../lib/auth.js';
import { ErrorCode, QwenAuthError } from '../../lib/errors.js';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), { mode });
}

function removeLater(t, ...dirs) {
  t.after(() => {
    for (const dir of dirs) {
      try { fs.chmodSync(dir, 0o700); } catch { /* 只读目录先改回才能删 */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

function catchError(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}

const USER = { id: 'u1', name: 'Tester', tier: 'Free', planId: 'subscription-cn-free' };

test('QWENWORK_CREDENTIAL_FILE takes priority over the default path', (t) => {
  const home = tempDir('qwenfile-home-');
  removeLater(t, home);
  const defaultFile = path.join(home, '.dsh', 'qwenwork-desktop.json');
  const envFile = path.join(home, 'override.json');
  writeJson(defaultFile, { token: 'token-from-default', refreshToken: 'rt-default', user: { ...USER, name: 'Default' } });
  writeJson(envFile, { token: 'token-from-env', refreshToken: 'rt-env', user: { ...USER, name: 'Env' } });

  const creds = loadCredentials({
    homedir: home,
    env: { QWENWORK_CREDENTIAL_FILE: `  ${envFile}  ` },
  });

  assert.equal(creds.source, 'file');
  assert.equal(creds.sourceFile, envFile);
  assert.equal(creds.token, 'token-from-env');
  assert.equal(creds.user.name, 'Env');
  assert.equal(creds.masterKey, null);
  assert.equal(fs.readFileSync(defaultFile, 'utf8').includes('token-from-default'), true);
});

test('blank QWENWORK_CREDENTIAL_FILE falls back to ~/.dsh/qwenwork-desktop.json', (t) => {
  const home = tempDir('qwenfile-home-');
  removeLater(t, home);
  const defaultFile = path.join(home, '.dsh', 'qwenwork-desktop.json');
  writeJson(defaultFile, {
    schemaVersion: 2,
    token: 'token-from-default',
    refreshToken: 'rt-default',
    expiresAt: '2099-09-18T03:29:01Z',
    user: USER,
    loginDeviceId: 'device-uuid-0001',
    extraNote: 'keep-me',
  });

  const creds = loadCredentials({
    homedir: home,
    env: { QWENWORK_CREDENTIAL_FILE: ' \t ' },
  });

  assert.equal(creds.source, 'file');
  assert.equal(creds.sourceFile, defaultFile);
  assert.equal(creds.token, 'token-from-default');
  assert.equal(creds.user.name, 'Tester');
  assert.equal(creds.loginDeviceId, 'device-uuid-0001');
  assert.equal(creds.schemaVersion, 2);
  assert.ok(creds.expiresAt instanceof Date);
  assert.equal(creds.masterKey, null);
});

test('missing plaintext file still uses the DPAPI path', (t) => {
  const home = tempDir('qwenfile-home-');
  const roaming = tempDir('qwenfile-roaming-');
  const appData = path.join(roaming, 'QwenWorkCN');
  fs.mkdirSync(appData);
  removeLater(t, home, roaming);
  const missing = path.join(home, 'missing-creds.json');

  const viaFileFallback = catchError(() => loadCredentials({
    homedir: home,
    env: { APPDATA: roaming, QWENWORK_CREDENTIAL_FILE: missing },
  }));
  const viaExplicit = catchError(() => loadCredentials({ appDataDir: appData }));

  assert.ok(viaFileFallback instanceof QwenAuthError);
  assert.ok(viaExplicit instanceof QwenAuthError);
  assert.equal(viaFileFallback.code, viaExplicit.code);
  assert.equal(viaFileFallback.message, viaExplicit.message);
  assert.equal(viaFileFallback.code, ErrorCode.CREDENTIALS_MISSING);
  assert.match(viaFileFallback.message, /Local State/);
  assert.ok(viaFileFallback.message.includes(appData));
});

test('a missing env file is not replaced by the default plaintext file', (t) => {
  const home = tempDir('qwenfile-home-');
  const appData = tempDir('qwenfile-app-');
  removeLater(t, home, appData);
  const defaultFile = path.join(home, '.dsh', 'qwenwork-desktop.json');
  writeJson(defaultFile, { token: 'token-from-default', user: USER });
  const before = fs.readFileSync(defaultFile);

  const err = catchError(() => loadCredentials({
    homedir: home,
    env: {
      APPDATA: appData,
      QWENWORK_CREDENTIAL_FILE: path.join(home, 'does-not-exist.json'),
    },
  }));

  assert.ok(err instanceof QwenAuthError);
  assert.equal(err.code, ErrorCode.CREDENTIALS_MISSING);
  assert.match(err.message, /Local State/);
  assert.deepEqual(fs.readFileSync(defaultFile), before);
});

test('explicit appDataDir does not read the plaintext credential file', (t) => {
  const home = tempDir('qwenfile-home-');
  const appData = tempDir('qwenfile-app-');
  removeLater(t, home, appData);
  const defaultFile = path.join(home, '.dsh', 'qwenwork-desktop.json');
  const envFile = path.join(home, 'override.json');
  writeJson(defaultFile, { token: 'token-from-default', user: USER });
  writeJson(envFile, { token: 'token-from-env', user: USER });

  const err = catchError(() => loadCredentials({
    appDataDir: appData,
    homedir: home,
    env: { APPDATA: appData, QWENWORK_CREDENTIAL_FILE: envFile },
  }));

  assert.ok(err instanceof QwenAuthError);
  assert.equal(err.code, ErrorCode.CREDENTIALS_MISSING);
  assert.match(err.message, /Local State/);
  assert.equal(err.message.includes('token-from-env'), false);
  assert.equal(err.message.includes(envFile), false);
});

test('corrupt plaintext JSON throws SCHEMA_INVALID and names the file', (t) => {
  const home = tempDir('qwenfile-home-');
  removeLater(t, home);
  const file = path.join(home, 'broken.json');
  const secret = 'leak-me-not-plaintext-token';
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(file, `{"token":"${secret}",`);

  const err = catchError(() => loadCredentials({
    homedir: home,
    env: { QWENWORK_CREDENTIAL_FILE: file },
  }));

  assert.ok(err instanceof QwenAuthError);
  assert.equal(err.name, 'QwenAuthError');
  assert.equal(err.code, ErrorCode.SCHEMA_INVALID);
  assert.match(err.message, /不是合法 JSON/);
  assert.ok(err.message.includes(file));
  assert.ok(err.recovery.includes(file));
  assert.ok(err.cause instanceof SyntaxError);
  assert.equal(JSON.stringify(err, Object.getOwnPropertyNames(err)).includes(secret), false);

  const probed = probeCredentials({
    homedir: home,
    env: { QWENWORK_CREDENTIAL_FILE: file },
  });
  assert.equal(probed.ok, false);
  assert.equal(probed.error.code, ErrorCode.SCHEMA_INVALID);
  assert.match(probed.error.message, /不是合法 JSON/);
  assert.equal(JSON.stringify(probed).includes(secret), false);
});

test('plaintext JSON missing token throws SCHEMA_INVALID and names the file', (t) => {
  const home = tempDir('qwenfile-home-');
  removeLater(t, home);
  const file = path.join(home, 'missing-token.json');
  const refresh = 'leak-me-not-refresh';
  writeJson(file, { refreshToken: refresh, user: USER, expiresAt: '2099-01-01T00:00:00Z' });

  const err = catchError(() => loadCredentials({
    homedir: home,
    env: { QWENWORK_CREDENTIAL_FILE: file },
  }));

  assert.ok(err instanceof QwenAuthError);
  assert.equal(err.code, ErrorCode.SCHEMA_INVALID);
  assert.match(err.message, /缺少必要字段/);
  assert.match(err.message, /token/);
  assert.ok(err.message.includes(file));
  assert.ok(err.recovery.includes(file));
  assert.equal(JSON.stringify(err, Object.getOwnPropertyNames(err)).includes(refresh), false);
});

test('plaintext JSON that is not an object throws SCHEMA_INVALID and names the file', (t) => {
  const home = tempDir('qwenfile-home-');
  removeLater(t, home);
  const file = path.join(home, 'not-object.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });

  for (const text of ['null', '[]', '"just-a-string"']) {
    fs.writeFileSync(file, text);
    const err = catchError(() => loadCredentials({
      homedir: home,
      env: { QWENWORK_CREDENTIAL_FILE: file },
    }));
    assert.ok(err instanceof QwenAuthError, text);
    assert.equal(err.code, ErrorCode.SCHEMA_INVALID);
    assert.match(err.message, /顶层不是对象/);
    assert.ok(err.message.includes(file));
  }
});

test('file refresh write-back updates token fields, preserves others, and replaces atomically', (t) => {
  const home = tempDir('qwenfile-home-');
  removeLater(t, home);
  const file = path.join(home, '.dsh', 'qwenwork-desktop.json');
  const original = {
    schemaVersion: 2,
    token: 'tok-old',
    refreshToken: 'rt-old',
    expiresAt: '2000-01-01T00:00:00.000Z',
    refreshTokenExpiresAt: '2000-06-01T00:00:00.000Z',
    user: USER,
    loginDeviceId: 'dev-1',
    refreshStrategy: 'device_token',
    extraNote: 'keep-me',
  };
  writeJson(file, original, 0o644);

  const creds = loadCredentials({ homedir: home, env: {} });
  assert.equal(creds.source, 'file');
  assert.equal(creds.sourceFile, file);
  assert.equal(creds.masterKey, null);

  const res = persistRefreshedCredentials(creds, creds.masterKey, {
    token: 'tok-new',
    refreshToken: 'rt-new',
    expiresAt: new Date('2099-09-18T06:12:11Z'),
    refreshTokenExpiresAt: new Date('2099-12-01T00:00:00Z'),
  });

  assert.equal(res.written, true);
  assert.equal(res.file, file);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.token, 'tok-new');
  assert.equal(after.refreshToken, 'rt-new');
  assert.equal(after.expiresAt, '2099-09-18T06:12:11.000Z');
  assert.equal(after.refreshTokenExpiresAt, '2099-12-01T00:00:00.000Z');
  assert.equal(after.user.name, 'Tester');
  assert.equal(after.user.planId, 'subscription-cn-free');
  assert.equal(after.loginDeviceId, 'dev-1');
  assert.equal(after.refreshStrategy, 'device_token');
  assert.equal(after.schemaVersion, 2);
  assert.equal(after.extraNote, 'keep-me');
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((name) => name.includes('tmp')),
    [],
  );
  if (process.platform !== 'win32') {
    // 先写成 0644，成功后变成临时文件的 0600，说明是改名替换而不是原地截断。
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});

test('plaintext write-back failure returns written:false and does not throw', (t) => {
  const dir = tempDir('qwenfile-ro-');
  removeLater(t, dir);
  const file = path.join(dir, 'creds.json');
  const body = { token: 'tok-old', refreshToken: 'rt-old', extraNote: 'keep-me', user: USER };
  writeJson(file, body, 0o600);
  const before = fs.readFileSync(file);
  fs.chmodSync(dir, 0o555);

  const creds = normalizeCredentials(body, { source: 'file', sourceFile: file });
  let res;
  assert.doesNotThrow(() => {
    res = persistRefreshedCredentials(creds, null, {
      token: 'tok-should-not-land',
      refreshToken: 'rt-should-not-land',
      expiresAt: new Date('2099-01-01T00:00:00Z'),
      refreshTokenExpiresAt: new Date('2099-06-01T00:00:00Z'),
    });
  });

  assert.equal(res.written, false);
  assert.match(res.reason, /file-write-failed/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.readFileSync(file, 'utf8').includes('tok-should-not-land'), false);
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')),
    [],
  );
});

test('plaintext write-back of a non-object JSON returns written:false and keeps the file', (t) => {
  const dir = tempDir('qwenfile-badjson-');
  removeLater(t, dir);
  const file = path.join(dir, 'creds.json');
  fs.writeFileSync(file, '[]');
  const before = fs.readFileSync(file);
  const creds = normalizeCredentials(
    { token: 'tok-old', user: USER },
    { source: 'file', sourceFile: file },
  );
  const res = persistRefreshedCredentials(creds, null, {
    token: 'tok-new',
    refreshToken: 'rt-new',
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  });
  assert.equal(res.written, false);
  assert.match(res.reason, /file-write-failed/);
  assert.deepEqual(fs.readFileSync(file), before);
});

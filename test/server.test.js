import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

let child;
let base;
let dataDir;
let cookie;
let csrf;

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function api(route, { method = 'GET', body, headers = {} } = {}) {
  return fetch(`${base}${route}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual'
  });
}

test('secure API uses sessions, CSRF, encrypted-vault config and fail-closed trading', async t => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const alternateOrigin = `http://localhost:${port}`;
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'vexon-test-'));
  const backendEnv = {
    ...process.env,
    NODE_ENV: 'development', HOST: '0.0.0.0', PORT: String(port),
    VEXON_ALLOWED_ORIGINS: base,
    VEXON_MANAGEABLE_ORIGINS: `${base},${alternateOrigin}`,
    VEXON_ADMIN_USERNAME: 'test-admin',
    VEXON_ADMIN_PASSWORD: 'test-only-password-928374!',
    VEXON_MASTER_KEY: randomBytes(32).toString('hex'),
    VEXON_DATA_DIR: dataDir,
    VEXON_ENABLE_EXCHANGE_CONNECTIONS: 'false',
    VEXON_LIVE_TRADING: 'false'
  };
  child = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: backendEnv, stdio: 'ignore' });
  t.after(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`Backend exited: ${child.exitCode}`);
    try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, 'backend should start');

  const health = await (await api('/api/health')).json();
  assert.deepEqual(health, { ok: true, exchangeConnectionsEnabled: false, tradingEnabled: false, liveTradingEnabled: false });
  const providers = await (await api('/api/providers')).json();
  assert.ok(Array.isArray(providers.providers));
  assert.ok(providers.providers.every(provider => typeof provider.supported === 'boolean'));
  assert.equal((await api('/')).status, 200);
  assert.equal((await api('/api/auth/login', { method: 'POST', body: { username: 'test-admin', password: 'incorrect-password' }, headers: { Origin: base } })).status, 401);

  const login = await api('/api/auth/login', { method: 'POST', body: { username: 'test-admin', password: 'test-only-password-928374!' }, headers: { Origin: base } });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  const loginData = await login.json();
  csrf = loginData.csrfToken;
  assert.equal(loginData.authenticated, true);
  assert.equal((await api('/api/exchanges')).status, 401);
  assert.deepEqual(await (await api('/api/exchanges', { headers: { Cookie: cookie } })).json(), { exchanges: [] });

  const initialFeatures = await (await api('/api/features')).json();
  assert.equal(initialFeatures.features.find(f => f.id === 'aiAnalysis').unlocked, true);
  const lockFeatures = await api('/api/admin/features', { method: 'POST', body: { featureLocks: { aiAnalysis: true } }, headers: { Cookie: cookie, Origin: base, 'X-CSRF-Token': csrf } });
  assert.equal(lockFeatures.status, 200);
  assert.equal((await (await api('/api/features')).json()).features.find(f => f.id === 'aiAnalysis').unlocked, false);
  const createdCode = await api('/api/admin/access-codes', { method: 'POST', body: { feature: 'aiAnalysis', expiresInHours: 2, maxUses: 1 }, headers: { Cookie: cookie, Origin: base, 'X-CSRF-Token': csrf } });
  assert.equal(createdCode.status, 201);
  const issued = await createdCode.json();
  assert.match(issued.code, /^VEX-[A-F0-9]{20}$/);
  const codeList = await (await api('/api/admin/access-codes', { headers: { Cookie: cookie } })).json();
  assert.equal(codeList.codes[0].hash, undefined, 'raw access-code hashes are never exposed');
  assert.equal(JSON.stringify(codeList).includes(issued.code), false, 'raw access codes are never returned by the listing API');
  const unlock = await api('/api/features/unlock', { method: 'POST', body: { feature: 'aiAnalysis', code: issued.code }, headers: { Origin: base } });
  assert.equal(unlock.status, 200);
  const featureCookie = unlock.headers.get('set-cookie').split(';')[0];
  assert.equal((await (await api('/api/features', { headers: { Cookie: featureCookie } })).json()).features.find(f => f.id === 'aiAnalysis').unlocked, true);
  assert.equal((await api('/api/features/unlock', { method: 'POST', body: { feature: 'aiAnalysis', code: issued.code }, headers: { Origin: base } })).status, 401, 'single-use access codes cannot be reused');
  const codeId = codeList.codes[0].id;
  assert.equal((await api(`/api/admin/access-codes/${codeId}`, { method: 'DELETE', headers: { Cookie: cookie, Origin: base, 'X-CSRF-Token': csrf } })).status, 200);
  assert.equal((await (await api('/api/features', { headers: { Cookie: featureCookie } })).json()).features.find(f => f.id === 'aiAnalysis').unlocked, false, 'revoking an access code revokes its feature grant');
  const secondCodeResponse = await api('/api/admin/access-codes', { method: 'POST', body: { feature: 'aiAnalysis', expiresInHours: 2, maxUses: 1 }, headers: { Cookie: cookie, Origin: base, 'X-CSRF-Token': csrf } });
  const secondCode = await secondCodeResponse.json();
  const secondUnlock = await api('/api/features/unlock', { method: 'POST', body: { feature: 'aiAnalysis', code: secondCode.code }, headers: { Origin: base } });
  const secondFeatureCookie = secondUnlock.headers.get('set-cookie').split(';')[0];
  assert.equal((await (await api('/api/features', { headers: { Cookie: secondFeatureCookie } })).json()).features.find(f => f.id === 'aiAnalysis').unlocked, true);
  await api('/api/admin/features', { method: 'POST', body: { featureLocks: { aiAnalysis: false } }, headers: { Cookie: cookie, Origin: base, 'X-CSRF-Token': csrf } });
  await api('/api/admin/features', { method: 'POST', body: { featureLocks: { aiAnalysis: true } }, headers: { Cookie: cookie, Origin: base, 'X-CSRF-Token': csrf } });
  assert.equal((await (await api('/api/features', { headers: { Cookie: secondFeatureCookie } })).json()).features.find(f => f.id === 'aiAnalysis').unlocked, false, 'changing a feature lock invalidates earlier grants');

  const connect = await api('/api/exchanges/connect', { method: 'POST', body: { exchange: 'binance', apiKey: 'test-public-key', apiSecret: 'test-secret', permissions: { withdrawals: false } }, headers: { Cookie: cookie, Origin: base, 'X-CSRF-Token': csrf } });
  assert.equal(connect.status, 503, 'exchange connections remain disabled by default');
  await assert.rejects(access(path.join(dataDir, 'credentials.vault')));

  const settings = await (await api('/api/admin/settings', { headers: { Cookie: cookie, Origin: base } })).json();
  assert.equal(settings.username, 'test-admin');
  assert.deepEqual(settings.approvedOrigins, [base, alternateOrigin]);

  const order = { exchange: 'binance', symbol: 'BTC/USDT', side: 'buy', type: 'limit', amount: 0.001, price: 1000, clientOrderId: 'e81cf735-bfa7-4db6-945f-a5721719fd23', confirmLive: true };
  assert.equal((await api('/api/orders', { method: 'POST', body: order, headers: { Cookie: cookie, Origin: base } })).status, 403, 'mutations require CSRF token');
  const disabled = await api('/api/orders', { method: 'POST', body: order, headers: { Cookie: cookie, Origin: base, 'X-CSRF-Token': csrf } });
  assert.equal(disabled.status, 503, 'live orders must be disabled by default');

  const changed = await api('/api/auth/change-password', { method: 'POST', body: { currentPassword: 'test-only-password-928374!', newPassword: 'new-test-only-password-382947!' }, headers: { Cookie: cookie, Origin: base, 'X-CSRF-Token': csrf } });
  assert.equal(changed.status, 200);
  const expiredSession = await (await api('/api/auth/session', { headers: { Cookie: cookie } })).json();
  assert.equal(expiredSession.authenticated, false);
  assert.equal((await api('/api/exchanges', { headers: { Cookie: cookie } })).status, 401, 'password change revokes existing sessions');
  assert.equal((await api('/api/auth/login', { method: 'POST', body: { username: 'test-admin', password: 'test-only-password-928374!' }, headers: { Origin: base } })).status, 401);
  const relogin = await api('/api/auth/login', { method: 'POST', body: { username: 'test-admin', password: 'new-test-only-password-382947!' }, headers: { Origin: base } });
  assert.equal(relogin.status, 200, 'new password persists for login');
  const reauth = await relogin.json();
  cookie = relogin.headers.get('set-cookie').split(';')[0];
  csrf = reauth.csrfToken;
  const savedDomain = await api('/api/admin/settings', { method: 'POST', body: { serverOrigin: alternateOrigin }, headers: { Cookie: cookie, Origin: base, 'X-CSRF-Token': csrf } });
  assert.equal(savedDomain.status, 200, 'admin can switch only to a preapproved origin');
  assert.equal((await fetch(`${base}/api/health`)).status, 421, 'old host is rejected after domain switch');

  child.kill('SIGTERM');
  await once(child, 'exit');
  base = alternateOrigin;
  child = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: backendEnv, stdio: 'ignore' });
  let restarted = false;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`Restarted backend exited: ${child.exitCode}`);
    try { if ((await fetch(`${base}/api/health`)).ok) { restarted = true; break; } } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(restarted, true, 'saved origin survives a backend restart');
  assert.equal((await api('/api/auth/login', { method: 'POST', body: { username: 'test-admin', password: 'test-only-password-928374!' }, headers: { Origin: base } })).status, 401);
  assert.equal((await api('/api/auth/login', { method: 'POST', body: { username: 'test-admin', password: 'new-test-only-password-382947!' }, headers: { Origin: base } })).status, 200, 'changed admin password survives a backend restart');
});

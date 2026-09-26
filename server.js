import http from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync,
  timingSafeEqual, randomUUID
} from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === 'production';
const secureCookies = isProduction || process.env.VEXON_COOKIE_SECURE === 'true';
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '0.0.0.0';
const bootstrapAdminName = process.env.VEXON_ADMIN_USERNAME || '';
const bootstrapAdminPassword = process.env.VEXON_ADMIN_PASSWORD || '';
const masterKeyHex = process.env.VEXON_MASTER_KEY || '';
const dataDir = path.resolve(process.env.VEXON_DATA_DIR || path.join(ROOT, '.vexon-data'));
const connectionsEnabled = process.env.VEXON_ENABLE_EXCHANGE_CONNECTIONS === 'true';
const liveTradingEnabled = process.env.VEXON_LIVE_TRADING === 'true';
const allowedExchanges = new Set((process.env.VEXON_ALLOWED_EXCHANGES || 'binance,okx,kucoin,nobitex,wallex,bitpin').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
const orderLimits = parseOrderLimits(process.env.VEXON_ORDER_QUOTE_LIMITS || '{"USDT":100}');
const FEATURES = [
  { id: 'aiAnalysis', label: 'AI assistant' },
  { id: 'exchangeConnections', label: 'Exchange connections' },
  { id: 'liveTrading', label: 'Live trading' },
  { id: 'automation', label: 'Automated trader' },
  { id: 'marketExplorer', label: 'Market explorer' },
  { id: 'activityExport', label: 'Activity export' }
];
const featureIds = new Set(FEATURES.map(feature => feature.id));
const maxLimitDeviation = Number(process.env.VEXON_MAX_LIMIT_DEVIATION_PERCENT || 2);
if (!Number.isFinite(maxLimitDeviation) || maxLimitDeviation <= 0 || maxLimitDeviation > 10) throw new Error('VEXON_MAX_LIMIT_DEVIATION_PERCENT must be between 0 and 10.');
const allowedHosts = new Set((process.env.VEXON_ALLOWED_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
const allowedOrigins = new Set((process.env.VEXON_ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean));
const manageableOrigins = new Set((process.env.VEXON_MANAGEABLE_ORIGINS || process.env.VEXON_ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean));
for (const origin of [...allowedOrigins, ...manageableOrigins]) {
  const parsed = new URL(origin);
  if (parsed.origin !== origin || !(parsed.protocol === 'https:' || (!isProduction && ['localhost','127.0.0.1'].includes(parsed.hostname)))) throw new Error(`Invalid approved origin: ${origin}`);
}
for (const origin of manageableOrigins) allowedHosts.add(new URL(origin).host.toLowerCase());
let activeOrigin = null;
let activeHost = null;
let adminRecord = null;

function parseOrderLimits(raw) {
  try {
    const parsed = JSON.parse(raw);
    return new Map(Object.entries(parsed).map(([quote, value]) => [quote.toUpperCase(), Number(value)]).filter(([, value]) => Number.isFinite(value) && value > 0));
  } catch { throw new Error('VEXON_ORDER_QUOTE_LIMITS must be a JSON object of quote currency limits.'); }
}
function requireConfig() {
  if (!/^[a-f\d]{64}$/i.test(masterKeyHex)) throw new Error('Configure VEXON_MASTER_KEY as 64 hexadecimal characters (32 random bytes).');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  if (isProduction && (!allowedHosts.size || !allowedOrigins.size)) throw new Error('Production requires explicit VEXON_ALLOWED_HOSTS and VEXON_ALLOWED_ORIGINS.');
}
requireConfig();
const masterKey = Buffer.from(masterKeyHex, 'hex');
const sessions = new Map();
const loginAttempts = new Map();
const idempotency = new Map();
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, session] of sessions) if (session.expiresAt <= now) sessions.delete(key);
  for (const [key, attempt] of loginAttempts) if (attempt.until <= now) loginAttempts.delete(key);
  for (const [key, usedAt] of idempotency) if (usedAt < now - 60 * 60 * 1000) idempotency.delete(key);
}, 60_000);
cleanupTimer.unref();
let ccxtPromise;
let auditQueue = Promise.resolve();
let idempotencyQueue = Promise.resolve();
let accessCodeQueue = Promise.resolve();

const mime = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.svg', 'image/svg+xml'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'], ['.png', 'image/png'],
  ['.ico', 'image/x-icon'], ['.txt', 'text/plain; charset=utf-8']
]);

function json(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function passwordMatches(record, password) {
  const candidate = scryptSync(String(password), Buffer.from(record.salt, 'hex'), 64);
  return timingSafeEqual(candidate, Buffer.from(record.passwordHash, 'hex'));
}
function randomToken(bytes = 32) { return randomBytes(bytes).toString('base64url'); }
function parseCookies(header = '') {
  const result = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0) result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}
function cookieName() { return secureCookies ? '__Host-vexon_session' : 'vexon_session'; }
function cookieValue(token, maxAge) {
  return `${cookieName()}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
}
function sessionFor(req) {
  const token = parseCookies(req.headers.cookie)[cookieName()];
  if (!token) return null;
  const key = sha256(token);
  const session = sessions.get(key);
  if (!session || session.expiresAt < Date.now()) { sessions.delete(key); return null; }
  session.expiresAt = Date.now() + 20 * 60 * 1000;
  return { key, ...session };
}
function requireSession(req, res) {
  const session = sessionFor(req);
  if (!session) { json(res, 401, { message: 'ورود لازم است.' }); return null; }
  return session;
}
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return !isProduction;
  if (activeOrigin) return origin === activeOrigin;
  if (allowedOrigins.size) return allowedOrigins.has(origin);
  try {
    const parsed = new URL(origin);
    return parsed.host.toLowerCase() === String(req.headers.host || '').toLowerCase() && (parsed.protocol === 'https:' || parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  } catch { return false; }
}
function requireMutationGuards(req, res, session) {
  if (!originAllowed(req)) { json(res, 403, { message: 'مبدأ درخواست مجاز نیست.' }); return false; }
  if (req.headers['sec-fetch-site'] === 'cross-site') { json(res, 403, { message: 'درخواست cross-site رد شد.' }); return false; }
  if (req.headers['x-csrf-token'] !== session.csrfToken) { json(res, 403, { message: 'توکن امنیتی منقضی یا نامعتبر است.' }); return false; }
  return true;
}
function clientIp(req) {
  if (process.env.VEXON_TRUST_PROXY === 'true') return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  return req.socket.remoteAddress || 'unknown';
}
function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  const record = loginAttempts.get(key);
  if (!record || record.until <= now) { loginAttempts.set(key, { count: 1, until: now + windowMs }); return false; }
  record.count++;
  return record.count > limit;
}
async function readBody(req, maxBytes = 32 * 1024) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw Object.assign(new Error('Content-Type must be application/json.'), { statusCode: 415 });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('درخواست بیش از حد بزرگ است.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('JSON درخواست معتبر نیست.'), { statusCode: 400 }); }
}
function encryptVault(payload) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') });
}
function decryptVault(envelope) {
  if (envelope.version !== 1) throw new Error('Unsupported credential vault format.');
  const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8');
  return JSON.parse(plaintext);
}
async function readVault() {
  try { return decryptVault(JSON.parse(await fs.readFile(path.join(dataDir, 'credentials.vault'), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return { exchanges: [] }; throw new Error('Credential vault could not be decrypted; check VEXON_MASTER_KEY.'); }
}
async function writeVault(vault) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await fs.chmod(dataDir, 0o700);
  const file = path.join(dataDir, 'credentials.vault');
  const temp = `${file}.${randomToken(8)}.tmp`;
  await fs.writeFile(temp, encryptVault(vault), { mode: 0o600, flag: 'wx' });
  await fs.rename(temp, file);
  await fs.chmod(file, 0o600);
}
async function writePrivateJson(file, value) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await fs.chmod(dataDir, 0o700);
  const temp = `${file}.${randomToken(8)}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  await fs.rename(temp, file);
  await fs.chmod(file, 0o600);
}
async function readAdminSettings() {
  try { return JSON.parse(await fs.readFile(path.join(dataDir, 'admin-settings.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('Admin settings store is unavailable.'); }
}
async function readAccessCodes() {
  try { return JSON.parse(await fs.readFile(path.join(dataDir, 'access-codes.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw new Error('Access-code store is unavailable.'); }
}
function accessCodeHash(code) { return createHmac('sha256', masterKey).update('vexon-access-code-v1:').update(code).digest('hex'); }
function featureCookieName() { return secureCookies ? '__Host-vexon_features' : 'vexon_features'; }
function featureCookieValue(grants, maxAge) {
  const payload = Buffer.from(JSON.stringify({ grants })).toString('base64url');
  const signature = createHmac('sha256', masterKey).update(`vexon-feature-grant-v1:${payload}`).digest('base64url');
  return `${featureCookieName()}=${payload}.${signature}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.min(maxAge, 365 * 24 * 60 * 60))}${secureCookies ? '; Secure' : ''}`;
}
function readFeatureGrant(req) {
  const token = parseCookies(req.headers.cookie)[featureCookieName()];
  if (!token) return {};
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return {};
  const expected = createHmac('sha256', masterKey).update(`vexon-feature-grant-v1:${payload}`).digest();
  let supplied;
  try { supplied = Buffer.from(signature, 'base64url'); } catch { return {}; }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return {};
  try { const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); return data.grants || {}; }
  catch { return {}; }
}
async function featureAccessFor(req) {
  const settings = await readAdminSettings();
  const epochs = settings.featureEpochs || {};
  const locks = settings.featureLocks || {};
  const storedGrants = readFeatureGrant(req);
  const codes = await readAccessCodes();
  const activeCodes = new Map(codes.filter(code => !code.revoked && code.expiresAt > Date.now()).map(code => [code.id, code]));
  const admin = Boolean(sessionFor(req));
  const items = FEATURES.map(feature => {
    const locked = locks[feature.id] === true;
    const grant = storedGrants[feature.id];
    const code = grant ? activeCodes.get(grant.codeId) : null;
    const granted = Boolean(grant && code && grant.expiresAt > Date.now() && grant.epoch === (epochs[feature.id] || 0) && code.features.includes(feature.id));
    return { ...feature, locked, unlocked: admin || !locked || granted };
  });
  return { settings, epochs, locks, storedGrants, codes: activeCodes, admin, items };
}
async function featureAllowed(req, featureId) {
  if (!featureIds.has(featureId)) return false;
  const access = await featureAccessFor(req);
  const feature = access.items.find(item => item.id === featureId);
  return Boolean(feature?.unlocked);
}
async function initializeAdminAndSettings() {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await fs.chmod(dataDir, 0o700);
  const adminFile = path.join(dataDir, 'admin.json');
  try {
    const record = JSON.parse(await fs.readFile(adminFile, 'utf8'));
    if (typeof record.username !== 'string' || !/^[a-zA-Z0-9_.-]{3,50}$/.test(record.username) || !/^[a-f\d]{32}$/i.test(record.salt) || !/^[a-f\d]{128}$/i.test(record.passwordHash)) throw new Error('Admin account file is invalid.');
    adminRecord = record;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Admin account store is invalid; refusing to start.');
    if (!/^[a-zA-Z0-9_.-]{3,50}$/.test(bootstrapAdminName) || bootstrapAdminPassword.length < 16 || bootstrapAdminPassword.length > 128) throw new Error('First run: set VEXON_ADMIN_USERNAME (3-50 chars) and VEXON_ADMIN_PASSWORD (16-128 chars).');
    const salt = randomBytes(16);
    adminRecord = { username: bootstrapAdminName, salt: salt.toString('hex'), passwordHash: scryptSync(bootstrapAdminPassword, salt, 64).toString('hex'), createdAt: new Date().toISOString(), passwordUpdatedAt: new Date().toISOString() };
    await writePrivateJson(adminFile, adminRecord);
  }

  const settingsFile = path.join(dataDir, 'admin-settings.json');
  let savedOrigin = null;
  try {
    const settings = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
    savedOrigin = settings.serverOrigin || null;
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('Admin settings store is invalid; refusing to start.'); }
  const initialOrigin = allowedOrigins.values().next().value || manageableOrigins.values().next().value || null;
  const selectedOrigin = savedOrigin || initialOrigin;
  if (selectedOrigin && manageableOrigins.size && !manageableOrigins.has(selectedOrigin)) throw new Error('Saved server origin is not in VEXON_MANAGEABLE_ORIGINS.');
  if (isProduction && !selectedOrigin) throw new Error('Production requires at least one approved public origin.');
  activeOrigin = selectedOrigin;
  activeHost = activeOrigin ? new URL(activeOrigin).host.toLowerCase() : null;
}
async function reserveDurableOrderId(id) {
  const reservation = idempotencyQueue.then(async () => {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(dataDir, 'order-ids.json');
    let records = [];
    try { records = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Idempotency store is unavailable; order blocked.'); }
    if (!Array.isArray(records) || records.includes(id)) return false;
    records.push(id);
    if (records.length > 100_000) records = records.slice(-100_000);
    const temp = `${file}.${randomToken(8)}.tmp`;
    await fs.writeFile(temp, JSON.stringify(records), { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, file);
    await fs.chmod(file, 0o600);
    return true;
  });
  idempotencyQueue = reservation.catch(() => {});
  return reservation;
}
async function audit(event) {
  const safe = { timestamp: new Date().toISOString(), ...event };
  auditQueue = auditQueue.then(async () => {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    await fs.appendFile(path.join(dataDir, 'audit.jsonl'), `${JSON.stringify(safe)}\n`, { mode: 0o600 });
    await fs.chmod(path.join(dataDir, 'audit.jsonl'), 0o600);
  });
  return auditQueue;
}
async function getCCXT() {
  ccxtPromise ||= import('ccxt').catch(() => null);
  return ccxtPromise;
}
async function makeExchange(provider, credential) {
  if (!allowedExchanges.has(provider)) throw Object.assign(new Error('این صرافی در allowlist سرور نیست.'), { statusCode: 400 });
  const module = await getCCXT();
  const Exchange = module?.[provider] || module?.default?.[provider];
  if (!Exchange) throw Object.assign(new Error('آداپتور این صرافی در نسخهٔ نصب‌شدهٔ CCXT موجود نیست.'), { statusCode: 501 });
  const exchange = new Exchange({
    apiKey: credential.apiKey,
    secret: credential.apiSecret,
    password: credential.passphrase || undefined,
    enableRateLimit: true,
    timeout: 15000,
    options: { defaultType: 'spot' }
  });
  if (!exchange.has?.fetchBalance || !exchange.has?.createOrder || !exchange.has?.fetchTicker) {
    if (exchange.close) await exchange.close().catch(() => {});
    throw Object.assign(new Error('این آداپتور قابلیت لازم برای اتصال امن اسپات را ندارد.'), { statusCode: 501 });
  }
  return exchange;
}
function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-DNS-Prefetch-Control': 'off',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'"
  };
}
function serveStatic(req, res, url) {
  let requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const resolved = path.resolve(ROOT, `.${requested}`);
  if (!resolved.startsWith(`${ROOT}${path.sep}`) && resolved !== path.join(ROOT, 'index.html')) { json(res, 403, { message: 'Forbidden' }); return; }
  const ext = path.extname(resolved).toLowerCase();
  if (!mime.has(ext)) { json(res, 404, { message: 'Not found' }); return; }
  const headers = { ...securityHeaders(), 'Content-Type': mime.get(ext), 'X-Content-Type-Options': 'nosniff' };
  if (ext === '.html') headers['Cache-Control'] = 'no-cache';
  else headers['Cache-Control'] = 'public, max-age=300';
  res.writeHead(200, headers);
  createReadStream(resolved).on('error', () => { if (!res.headersSent) json(res, 404, { message: 'Not found' }); else res.destroy(); }).pipe(res);
}
function parseAmount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1e12) return null;
  return number;
}

const server = http.createServer(async (req, res) => {
  for (const [name, value] of Object.entries(securityHeaders())) res.setHeader(name, value);
  res.setHeader('Cache-Control', 'no-store');
  const requestHost = String(req.headers.host || '').toLowerCase();
  if ((activeHost && requestHost !== activeHost) || (!activeHost && allowedHosts.size && !allowedHosts.has(requestHost))) { json(res, 421, { message: 'Host is not allowed.' }); return; }
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { json(res, 400, { message: 'Invalid URL.' }); return; }

  try {
    if (req.method === 'GET' && url.pathname === '/api/providers') {
      const module = await getCCXT();
      const providers = [...allowedExchanges].map(id => {
        const Exchange = module?.[id] || module?.default?.[id];
        if (!Exchange) return { id, supported: false, reason: 'آداپتور در نسخهٔ نصب‌شده موجود نیست.' };
        try {
          const adapter = new Exchange({ enableRateLimit: true, options: { defaultType: 'spot' } });
          const supported = Boolean(adapter.has?.fetchBalance && adapter.has?.createOrder && adapter.has?.fetchTicker);
          if (adapter.close) Promise.resolve(adapter.close()).catch(() => {});
          return { id, supported, reason: supported ? null : 'قابلیت‌های لازم اسپات پشتیبانی نمی‌شود.' };
        } catch { return { id, supported: false, reason: 'آداپتور قابل بارگذاری نیست.' }; }
      });
      json(res, 200, { providers });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      const ready = connectionsEnabled && Boolean(masterKey) && Boolean(adminRecord);
      json(res, 200, { ok: true, exchangeConnectionsEnabled: ready, tradingEnabled: ready && liveTradingEnabled, liveTradingEnabled: ready && liveTradingEnabled });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const ip = clientIp(req);
      if (rateLimited(`login:${ip}`, 8, 15 * 60 * 1000)) { json(res, 429, { message: 'تلاش‌های ورود بیش از حد مجاز است.' }); return; }
      if (!originAllowed(req)) { json(res, 403, { message: 'مبدأ درخواست مجاز نیست.' }); return; }
      const body = await readBody(req, 8 * 1024);
      const suppliedName = String(body.username || '');
      const suppliedPassword = String(body.password || '');
      const nameOk = suppliedName === adminRecord.username;
      const passwordOk = passwordMatches(adminRecord, suppliedPassword);
      if (!nameOk || !passwordOk) { await audit({ type: 'login_failed', ip }); json(res, 401, { message: 'نام کاربری یا گذرواژه نادرست است.' }); return; }
      loginAttempts.delete(`login:${ip}`);
      const token = randomToken();
      const key = sha256(token);
      const csrfToken = randomToken(24);
      sessions.set(key, { csrfToken, expiresAt: Date.now() + 20 * 60 * 1000, createdAt: Date.now() });
      await audit({ type: 'login_success' });
      json(res, 200, { authenticated: true, csrfToken }, { 'Set-Cookie': cookieValue(token, 20 * 60) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/session') {
      const session = sessionFor(req);
      json(res, 200, { authenticated: Boolean(session), csrfToken: session?.csrfToken || null });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/features') {
      const access = await featureAccessFor(req);
      json(res, 200, { features: access.items, isAdmin: access.admin });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/features/unlock') {
      if (!originAllowed(req) || req.headers['sec-fetch-site'] === 'cross-site') { json(res, 403, { message: 'مبدأ درخواست مجاز نیست.' }); return; }
      const ip = clientIp(req);
      if (rateLimited(`unlock:${ip}`, 8, 15 * 60 * 1000)) { json(res, 429, { message: 'تعداد تلاش ورود کلید بیش از حد است.' }); return; }
      const body = await readBody(req, 8 * 1024);
      const featureId = String(body.feature || '');
      const codeText = String(body.code || '').trim().toUpperCase().replace(/\s+/g, '');
      if (!featureIds.has(featureId) || !/^VEX-[A-F0-9]{20}$/.test(codeText)) { json(res, 400, { message: 'کلید ورود معتبر نیست.' }); return; }
      const access = await featureAccessFor(req);
      const feature = access.items.find(item => item.id === featureId);
      if (!feature?.locked || access.admin) { json(res, 200, { unlocked: true }); return; }
      const codeHash = accessCodeHash(codeText);
      const consumption = accessCodeQueue.then(async () => {
        const records = await readAccessCodes();
        const record = records.find(item => item.hash === codeHash && !item.revoked && item.features.includes(featureId));
        if (!record || record.expiresAt <= Date.now() || record.uses >= record.maxUses) return null;
        record.uses += 1;
        record.lastUsedAt = new Date().toISOString();
        await writePrivateJson(path.join(dataDir, 'access-codes.json'), records);
        return record;
      });
      accessCodeQueue = consumption.catch(() => {});
      const record = await consumption;
      if (!record) { json(res, 401, { message: 'کلید ورود نامعتبر، منقضی یا مصرف‌شده است.' }); return; }
      const grants = {};
      for (const [id, grant] of Object.entries(access.storedGrants)) {
        const previousCode = access.codes.get(grant.codeId);
        if (previousCode && grant.expiresAt > Date.now() && grant.epoch === (access.epochs[id] || 0)) grants[id] = grant;
      }
      const epoch = access.epochs[featureId] || 0;
      grants[featureId] = { codeId: record.id, expiresAt: record.expiresAt, epoch };
      const maxAge = Math.max(1, Math.floor((record.expiresAt - Date.now()) / 1000));
      await audit({ type: 'feature_unlocked', feature: featureId, accessCodeId: record.id });
      json(res, 200, { unlocked: true, feature: featureId, expiresAt: record.expiresAt }, { 'Set-Cookie': featureCookieValue(grants, maxAge) });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const session = requireSession(req, res);
      if (!session) return;
      if (req.method !== 'GET' && !requireMutationGuards(req, res, session)) return;

      if (req.method === 'POST' && url.pathname === '/api/auth/change-password') {
        if (rateLimited(`password-change:${session.key}`, 5, 15 * 60 * 1000)) { json(res, 429, { message: 'تعداد تلاش تغییر گذرواژه بیش از حد است.' }); return; }
        const body = await readBody(req, 8 * 1024);
        const currentPassword = String(body.currentPassword || '');
        const newPassword = String(body.newPassword || '');
        if (!passwordMatches(adminRecord, currentPassword)) { json(res, 400, { message: 'گذرواژهٔ فعلی نادرست است.' }); return; }
        if (newPassword.trim().length < 16 || newPassword.length > 128 || /[\u0000-\u001f\u007f]/.test(newPassword)) { json(res, 400, { message: 'گذرواژهٔ جدید باید ۱۶ تا ۱۲۸ نویسه باشد.' }); return; }
        if (timingSafeEqual(scryptSync(newPassword, Buffer.from(adminRecord.salt, 'hex'), 64), Buffer.from(adminRecord.passwordHash, 'hex'))) { json(res, 400, { message: 'گذرواژهٔ جدید باید با گذرواژهٔ فعلی متفاوت باشد.' }); return; }
        const salt = randomBytes(16);
        adminRecord = { ...adminRecord, salt: salt.toString('hex'), passwordHash: scryptSync(newPassword, salt, 64).toString('hex'), passwordUpdatedAt: new Date().toISOString() };
        await writePrivateJson(path.join(dataDir, 'admin.json'), adminRecord);
        sessions.clear();
        await audit({ type: 'admin_password_changed' });
        json(res, 200, { passwordChanged: true }, { 'Set-Cookie': cookieValue('', 0) });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/features') {
        const settings = await readAdminSettings();
        json(res, 200, { features: FEATURES.map(feature => ({ ...feature, locked: settings.featureLocks?.[feature.id] === true, epoch: settings.featureEpochs?.[feature.id] || 0 })) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/features') {
        const body = await readBody(req, 8 * 1024);
        if (!body.featureLocks || typeof body.featureLocks !== 'object' || Array.isArray(body.featureLocks)) { json(res, 400, { message: 'تنظیم قفل قابلیت‌ها معتبر نیست.' }); return; }
        const settings = await readAdminSettings();
        const featureLocks = { ...(settings.featureLocks || {}) };
        const featureEpochs = { ...(settings.featureEpochs || {}) };
        for (const [id, locked] of Object.entries(body.featureLocks)) {
          if (!featureIds.has(id) || typeof locked !== 'boolean') { json(res, 400, { message: 'شناسه یا وضعیت قفل قابلیت معتبر نیست.' }); return; }
          if ((featureLocks[id] === true) !== locked) featureEpochs[id] = (featureEpochs[id] || 0) + 1;
          featureLocks[id] = locked;
        }
        await writePrivateJson(path.join(dataDir, 'admin-settings.json'), { ...settings, featureLocks, featureEpochs, updatedAt: new Date().toISOString() });
        await audit({ type: 'feature_locks_changed', features: Object.keys(body.featureLocks) });
        json(res, 200, { features: FEATURES.map(feature => ({ ...feature, locked: featureLocks[feature.id] === true, epoch: featureEpochs[feature.id] || 0 })) });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/access-codes') {
        const records = await readAccessCodes();
        json(res, 200, { codes: records.map(({ id, features, uses, maxUses, expiresAt, createdAt, revoked }) => ({ id, features, uses, maxUses, expiresAt, createdAt, revoked: Boolean(revoked) })) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/access-codes') {
        const body = await readBody(req, 8 * 1024);
        const featureId = String(body.feature || '');
        const expiresInHours = Number(body.expiresInHours ?? 24);
        const maxUses = Number(body.maxUses ?? 1);
        if (!featureIds.has(featureId) || !Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 8760 || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > 500) { json(res, 400, { message: 'قابلیت، زمان انقضا یا تعداد استفاده معتبر نیست.' }); return; }
        const code = `VEX-${randomBytes(10).toString('hex').toUpperCase()}`;
        const record = { id: randomUUID(), hash: accessCodeHash(code), features: [featureId], uses: 0, maxUses, expiresAt: Date.now() + expiresInHours * 60 * 60 * 1000, createdAt: new Date().toISOString(), revoked: false };
        const records = await readAccessCodes();
        records.push(record);
        await writePrivateJson(path.join(dataDir, 'access-codes.json'), records);
        await audit({ type: 'feature_access_code_created', accessCodeId: record.id, feature: featureId, maxUses, expiresAt: record.expiresAt });
        json(res, 201, { code, feature: featureId, maxUses, expiresAt: record.expiresAt });
        return;
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/api/admin/access-codes/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/admin/access-codes/'.length));
        const records = await readAccessCodes();
        const record = records.find(item => item.id === id);
        if (!record) { json(res, 404, { message: 'کد ورود پیدا نشد.' }); return; }
        record.revoked = true;
        record.revokedAt = new Date().toISOString();
        await writePrivateJson(path.join(dataDir, 'access-codes.json'), records);
        await audit({ type: 'feature_access_code_revoked', accessCodeId: id });
        json(res, 200, { revoked: true });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/settings') {
        const displayedOrigin = activeOrigin || `${secureCookies ? 'https' : 'http'}://${req.headers.host}`;
        json(res, 200, { username: adminRecord.username, serverOrigin: displayedOrigin, approvedOrigins: [...manageableOrigins], canChangeServerOrigin: manageableOrigins.size > 1, exchangeConnectionsEnabled: connectionsEnabled, liveTradingEnabled });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/settings') {
        const body = await readBody(req, 8 * 1024);
        const nextOrigin = String(body.serverOrigin || '');
        if (!manageableOrigins.has(nextOrigin)) { json(res, 400, { message: 'دامنه در فهرست دامنه‌های از پیش مجاز سرور نیست.' }); return; }
        const parsedOrigin = new URL(nextOrigin);
        if (parsedOrigin.origin !== nextOrigin || !(parsedOrigin.protocol === 'https:' || (!isProduction && ['localhost','127.0.0.1'].includes(parsedOrigin.hostname)))) { json(res, 400, { message: 'دامنهٔ عمومی باید HTTPS باشد.' }); return; }
        const currentSettings = await readAdminSettings();
        await writePrivateJson(path.join(dataDir, 'admin-settings.json'), { ...currentSettings, serverOrigin: nextOrigin, updatedAt: new Date().toISOString() });
        activeOrigin = nextOrigin;
        activeHost = parsedOrigin.host.toLowerCase();
        await audit({ type: 'server_origin_changed', origin: nextOrigin });
        json(res, 200, { saved: true, serverOrigin: activeOrigin, message: 'برای اثر کامل تغییر، DNS و گواهی TLS و reverse proxy دامنهٔ جدید باید از قبل به همین سرور اشاره کنند.' });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        const token = parseCookies(req.headers.cookie)[cookieName()];
        sessions.delete(sha256(token));
        json(res, 200, { ok: true }, { 'Set-Cookie': cookieValue('', 0) });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/exchanges') {
        const vault = await readVault();
        json(res, 200, { exchanges: vault.exchanges.map(({ id, provider, connectedAt }) => ({ id: provider, name: provider, connected: true, connectedAt })) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/exchanges/connect') {
        if (!await featureAllowed(req, 'exchangeConnections')) { json(res, 423, { message: 'برای اتصال صرافی ابتدا کلید ورود این قابلیت را وارد کنید.', featureLocked: true }); return; }
        if (rateLimited(`connect:${session.key}`, 5, 60 * 60 * 1000)) { json(res, 429, { message: 'تعداد تلاش اتصال بیش از حد است.' }); return; }
        if (!connectionsEnabled) { json(res, 503, { message: 'Exchange connections are disabled by the server operator.' }); return; }
        const body = await readBody(req);
        const provider = String(body.exchange || '').toLowerCase();
        const apiKey = String(body.apiKey || '');
        const apiSecret = String(body.apiSecret || '');
        const passphrase = String(body.passphrase || '');
        if (!/^[a-z0-9_-]{2,30}$/.test(provider) || !apiKey || !apiSecret || apiKey.length > 512 || apiSecret.length > 1024 || passphrase.length > 512) { json(res, 400, { message: 'اطلاعات اتصال معتبر نیست.' }); return; }
        if (body.permissions?.withdrawals !== false) { json(res, 400, { message: 'دسترسی برداشت باید خاموش باشد.' }); return; }
        let exchange;
        try {
          exchange = await makeExchange(provider, { apiKey, apiSecret, passphrase });
          await exchange.loadMarkets();
          await exchange.fetchBalance(); // Read-only credential verification; no orders are sent here.
        } catch (error) {
          await audit({ type: 'exchange_connect_failed', provider });
          const status = error.statusCode || 400;
          json(res, status, { message: status === 501 ? error.message : 'صرافی کلیدها را نپذیرفت یا دسترسی خواندن موجودی ندارد.' });
          return;
        } finally { if (exchange?.close) await exchange.close().catch(() => {}); }
        const vault = await readVault();
        const existing = vault.exchanges.find(x => x.provider === provider);
        const connection = { id: existing?.id || randomUUID(), provider, apiKey, apiSecret, passphrase, connectedAt: new Date().toISOString() };
        vault.exchanges = [...vault.exchanges.filter(x => x.provider !== provider), connection];
        await writeVault(vault);
        await audit({ type: 'exchange_connected', provider, connectionId: connection.id });
        json(res, 200, { connected: true, exchange: { id: provider, name: provider, connected: true } });
        return;
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/api/exchanges/')) {
        const provider = decodeURIComponent(url.pathname.slice('/api/exchanges/'.length)).toLowerCase();
        const vault = await readVault();
        const removed = vault.exchanges.some(x => x.provider === provider);
        vault.exchanges = vault.exchanges.filter(x => x.provider !== provider);
        if (removed) await writeVault(vault);
        await audit({ type: 'exchange_disconnected', provider });
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/orders') {
        if (!await featureAllowed(req, 'liveTrading')) { json(res, 423, { message: 'برای معامله ابتدا کلید ورود این قابلیت را وارد کنید.', featureLocked: true }); return; }
        if (rateLimited(`order:${session.key}`, 10, 60 * 1000)) { json(res, 429, { message: 'حداکثر ۱۰ سفارش در دقیقه مجاز است.' }); return; }
        if (!liveTradingEnabled || !connectionsEnabled) { json(res, 503, { message: 'Real trading is disabled by the server operator.' }); return; }
        const body = await readBody(req);
        if (body.confirmLive !== true) { json(res, 400, { message: 'تأیید صریح سفارش واقعی الزامی است.' }); return; }
        const provider = String(body.exchange || '').toLowerCase();
        const side = String(body.side || '').toLowerCase();
        const type = String(body.type || '').toLowerCase();
        const symbol = String(body.symbol || '').replaceAll(' ', '').toUpperCase();
        const amount = parseAmount(body.amount);
        const clientOrderId = String(body.clientOrderId || '');
        if (!allowedExchanges.has(provider) || !['buy', 'sell'].includes(side) || !['limit'].includes(type) || !/^[A-Z0-9]{2,20}\/[A-Z0-9]{2,20}$/.test(symbol) || !amount || !/^[a-f0-9-]{36}$/i.test(clientOrderId)) {
          json(res, 400, { message: 'پارامتر سفارش معتبر نیست؛ در نسخه امن فقط سفارش محدود پشتیبانی می‌شود.' }); return;
        }
        const price = parseAmount(body.price);
        if (!price) { json(res, 400, { message: 'برای سفارش محدود قیمت معتبر لازم است.' }); return; }
        if (idempotency.has(clientOrderId)) { json(res, 409, { message: 'این شناسه سفارش قبلاً استفاده شده است.' }); return; }
        idempotency.set(clientOrderId, Date.now());
        const vault = await readVault();
        const credential = vault.exchanges.find(x => x.provider === provider);
        if (!credential) { json(res, 404, { message: 'این صرافی به حساب متصل نیست.' }); return; }
        let exchange;
        try {
          exchange = await makeExchange(provider, credential);
          await exchange.loadMarkets();
          const market = exchange.market(symbol);
          if (!market || market.active === false || market.spot !== true || market.contract || market.swap || market.future) throw Object.assign(new Error('این بازار اسپات در صرافی فعال نیست.'), { statusCode: 400 });
          const ticker = await exchange.fetchTicker(symbol);
          const reference = side === 'buy' ? (ticker.ask || ticker.last) : (ticker.bid || ticker.last);
          if (!reference || !Number.isFinite(reference) || Math.abs(price / reference - 1) * 100 > maxLimitDeviation) throw Object.assign(new Error('قیمت سفارش بیش از محدودهٔ مجاز با قیمت بازار اختلاف دارد.'), { statusCode: 400 });
          const quoteLimit = orderLimits.get(String(market.quote).toUpperCase());
          const quoteCost = amount * price;
          if (!quoteLimit || quoteCost > quoteLimit) throw Object.assign(new Error(`سقف مجاز سفارش برای ${market.quote} تنظیم نشده یا رعایت نشده است.`), { statusCode: 400 });
          const amountFormatted = Number(exchange.amountToPrecision(symbol, amount));
          const priceFormatted = Number(exchange.priceToPrecision(symbol, price));
          if (!Number.isFinite(amountFormatted) || !Number.isFinite(priceFormatted) || amountFormatted <= 0 || priceFormatted <= 0 || Math.abs(amountFormatted - amount) > Math.max(amount * 1e-8, 1e-12)) throw Object.assign(new Error('مقدار سفارش با دقت مجاز بازار سازگار نیست.'), { statusCode: 400 });
          if (market.limits?.amount?.min && amountFormatted < market.limits.amount.min) throw Object.assign(new Error('مقدار سفارش از حداقل مجاز بازار کمتر است.'), { statusCode: 400 });
          if (market.limits?.cost?.min && quoteCost < market.limits.cost.min) throw Object.assign(new Error('ارزش سفارش از حداقل مجاز بازار کمتر است.'), { statusCode: 400 });
          const balance = await exchange.fetchBalance();
          const available = side === 'buy' ? Number(balance.free?.[market.quote]) : Number(balance.free?.[market.base]);
          if (!Number.isFinite(available) || available < (side === 'buy' ? quoteCost : amountFormatted)) throw Object.assign(new Error('موجودی آزاد کافی نیست.'), { statusCode: 400 });
          if (!await reserveDurableOrderId(clientOrderId)) throw Object.assign(new Error('شناسه سفارش قبلاً مصرف شده است؛ برای جلوگیری از ثبت تکراری، وضعیت را در صرافی بررسی کنید.'), { statusCode: 409 });
          const order = await exchange.createOrder(symbol, 'limit', side, amountFormatted, priceFormatted, { clientOrderId });
          await audit({ type: 'live_order_accepted', provider, symbol, side, orderType: 'limit', amount: amountFormatted, price: priceFormatted, quote: market.quote, orderId: String(order.id || '') });
          json(res, 200, { status: 'accepted', orderId: String(order.id || clientOrderId), exchangeStatus: order.status || 'open' });
        } catch (error) {
          await audit({ type: 'live_order_rejected', provider, symbol, side, reason: error.statusCode ? 'validation_or_exchange_error' : 'provider_error' });
          json(res, error.statusCode || 502, { message: error.statusCode ? error.message : 'صرافی سفارش را نپذیرفت؛ وضعیت سفارش را مستقیماً در صرافی بررسی کنید.' });
        } finally { if (exchange?.close) await exchange.close().catch(() => {}); }
        return;
      }
      json(res, 404, { message: 'API route not found.' });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { message: 'Method not allowed.' }); return; }
    serveStatic(req, res, url);
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error('Vexon request failed:', error.message);
    if (!res.headersSent) json(res, status, { message: status >= 500 ? 'خطای داخلی سرور.' : error.message });
  }
});

server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;
initializeAdminAndSettings().then(() => {
  server.listen(port, host, () => {
    console.log(`Vexon secure backend listening on ${host}:${port}`);
    console.log(`Admin account: ${adminRecord.username} (password stored as scrypt hash)`);
    console.log(`Exchange connection: ${connectionsEnabled ? 'enabled (CCXT verification required)' : 'disabled'}`);
    console.log(`Live orders: ${liveTradingEnabled ? 'enabled with strict spot/limit controls' : 'disabled (default)'}`);
  });
}).catch(error => {
  console.error('Vexon startup configuration error:', error.message);
  process.exit(1);
});

/*
 * SpaceKit Logistic — сервер (Yandex Cloud Function, Node.js 22).
 * Вызывается через API Gateway:
 *   POST /api      — запросы мини-приложения (проверка Telegram initData)
 *   POST /tg/<секрет> — webhook бота
 */
'use strict';

const crypto = require('crypto');
const { Core } = require('./core');
const { ydbStore } = require('./store');

const TOKEN = process.env.TG_BOT_TOKEN || '';
const APP_URL = process.env.APP_URL || '';
const MAX_AUTH_AGE = 7 * 24 * 3600;

let store = null;
function getStore() {
  if (!store) store = ydbStore(process.env.YDB_ENDPOINT, process.env.YDB_DATABASE);
  return store;
}

const tg = {
  async call(method, params) {
    const res = await fetch('https://api.telegram.org/bot' + TOKEN + '/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params || {}),
      signal: AbortSignal.timeout(15000)
    });
    const d = await res.json().catch(() => ({}));
    if (!d.ok) throw new Error(method + ': ' + (d.description || res.status));
    return d.result;
  }
};

/** Секрет для адреса webhook — производный от токена, чтобы не хранить ещё один */
function hookSecret() {
  return crypto.createHash('sha256').update('hook:' + TOKEN).digest('hex').slice(0, 32);
}

function verifyInitData(initData) {
  if (!initData || !TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  const check = [...params.entries()].filter(([k]) => k !== 'hash').sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + '=' + v).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > MAX_AUTH_AGE) return null;
  let u;
  try { u = JSON.parse(params.get('user') || '{}'); } catch (e) { return null; }
  if (!u.id) return null;
  return { id: String(u.id), name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || String(u.id), username: u.username || null };
}

function reply(status, obj) {
  return { statusCode: status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(obj) };
}

function readBody(event) {
  let b = event.body || '';
  if (event.isBase64Encoded) b = Buffer.from(b, 'base64').toString('utf8');
  try { return JSON.parse(b || '{}'); } catch (e) { return {}; }
}

function header(event, name) {
  const h = event.headers || {};
  const key = Object.keys(h).find((k) => k.toLowerCase() === name);
  return key ? h[key] : '';
}

module.exports.handler = async function (event) {
  // API Gateway кладёт реальный путь в url, а шаблон из спецификации — в path
  const path = (event.url || event.path || '').split('?')[0];
  const core = new Core(getStore(), tg, Date.now, { appUrl: APP_URL });
  try {
    if (path.startsWith('/tg/')) {
      const secret = (event.pathParams && event.pathParams.secret) || path.slice(4);
      if (secret !== hookSecret()) return reply(404, { ok: false });
      await core.onUpdate(readBody(event));
      return reply(200, { ok: true });
    }
    if (path === '/api' || path === '/api/') {
      const ident = verifyInitData(header(event, 'x-tg-init'));
      if (!ident) return reply(401, { ok: false, error: 'Открой приложение из Telegram' });
      const user = await core.session(ident);
      const body = readBody(event);
      const result = await core.op(user, body);
      return reply(200, { ok: true, result });
    }
    if (path === '/api/health') return reply(200, { ok: true, at: Date.now() });
    return reply(404, { ok: false, error: 'Не найдено' });
  } catch (e) {
    if (e && e.userError) return reply(200, { ok: false, error: e.message });
    console.error(JSON.stringify({ msg: 'error', path, error: String(e && e.stack || e) }));
    return reply(500, { ok: false, error: 'Ошибка сервера, попробуй ещё раз' });
  }
};

module.exports._test = { verifyInitData, hookSecret };

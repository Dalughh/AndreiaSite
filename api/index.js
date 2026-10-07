'use strict';
const auth = require('../lib/auth');
const db = require('../lib/db');
const svc = require('../lib/services');
const { HttpError, clientIp } = require('../lib/util');

function send(res, status, data, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(data));
}

function bodyOf(req) {
  const b = req.body;
  if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return b;
  if (typeof b === 'string' && b) {
    try { const j = JSON.parse(b); if (j && typeof j === 'object') return j; } catch (_) { /* inválido */ }
  }
  return {};
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  // Na Vercel, /api/* é reescrito para esta função com o caminho original em ?__p= (ver vercel.json).
  const rewritten = url.searchParams.get('__p');
  const rawPath = rewritten !== null ? rewritten : url.pathname.replace(/^\/api\/?/, '');
  url.searchParams.delete('__p');
  const parts = rawPath.split('/').filter(Boolean).map(decodeURIComponent);
  const method = req.method;
  const body = bodyOf(req);
  const [a, b, c, d] = parts;
  const ip = clientIp(req);

  if (MUTATING.has(method)) auth.checkCsrf(req);

  /* ----- Públicas ----- */
  if (a === 'health' && method === 'GET') {
    const info = { ok: false, env: { DATABASE_URL: !!db.connectionStringRaw(), ADMIN_PASSWORD: auth.adminConfigured(), SESSION_SECRET: !!process.env.SESSION_SECRET } };
    try { await db.query('SELECT 1'); info.ok = true; }
    catch (e) { info.stage = 'database'; info.error = e instanceof HttpError ? e.message : `${e.code || e.name}: ${String(e.message).slice(0, 160)}`; }
    return send(res, info.ok ? 200 : 503, info);
  }
  if (a === 'store' && method === 'GET') {
    return send(res, 200, await svc.publicStore(), { 'Cache-Control': 'public, max-age=0, s-maxage=5, stale-while-revalidate=10' });
  }
  if (a === 'photo' && b && method === 'GET') {
    const p = await svc.getPhoto(b);
    if (!p) throw new HttpError(404, 'Foto não encontrada.');
    res.statusCode = 200;
    res.setHeader('Content-Type', p.mime);
    res.setHeader('Content-Length', p.buf.length);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.end(p.buf);
  }
  if (a === 'affiliate' && b === 'resolve' && method === 'GET') {
    const found = await svc.resolveAffiliate(url.searchParams.get('code'));
    return send(res, 200, { affiliate: found });
  }
  if (a === 'leads' && method === 'POST') {
    await db.rateLimit('lead:' + ip, 60, 3600000);
    return send(res, 200, await svc.recordLead(body));
  }
  if (a === 'affiliate' && b === 'login' && method === 'POST') {
    await db.rateLimit('afflogin:' + ip, 10, 900000);
    return send(res, 200, await svc.affiliateDashboard(body.code, body.token));
  }

  /* ----- Admin: sessão ----- */
  if (a === 'admin' && b === 'login' && method === 'POST') {
    if (!auth.adminConfigured()) throw new HttpError(503, 'Acesso do administrador não configurado no servidor.');
    await db.rateLimit('login:' + ip, 8, 900000);
    if (!auth.checkAdminCredentials(body.username, body.password)) throw new HttpError(401, 'Usuário ou senha incorretos.');
    await db.rateReset('login:' + ip);
    const s = auth.createSession();
    auth.setSessionCookie(req, res, s.token, s.exp);
    return send(res, 200, { ok: true });
  }
  if (a === 'admin' && b === 'logout' && method === 'POST') {
    auth.clearSessionCookie(req, res);
    return send(res, 200, { ok: true });
  }
  if (a === 'admin' && b === 'session' && method === 'GET') {
    return send(res, 200, { authenticated: auth.isAdmin(req), configured: auth.adminConfigured() });
  }

  /* ----- Admin: tudo abaixo exige sessão ----- */
  if (a === 'admin') {
    auth.requireAdmin(req);

    if (b === 'data' && method === 'GET') return send(res, 200, await svc.adminData());
    if (b === 'settings' && !c && method === 'PUT') return send(res, 200, { settings: await svc.saveSettings(body) });
    if (b === 'settings' && c === 'affiliate' && method === 'PUT') return send(res, 200, { settings: await svc.saveAffiliateSettings(body) });

    if (b === 'products' && !c && method === 'POST') return send(res, 200, { product: await svc.saveProduct(body) });
    if (b === 'products' && c && method === 'DELETE') return send(res, 200, await svc.deleteProduct(c));

    if (b === 'affiliates' && !c && method === 'POST') return send(res, 200, await svc.createAffiliate(body));
    if (b === 'affiliates' && c && !d && method === 'PATCH') return send(res, 200, await svc.updateAffiliate(c, body));
    if (b === 'affiliates' && c && d === 'regenerate-token' && method === 'POST') return send(res, 200, await svc.regenerateToken(c));

    if (b === 'orders' && !c && method === 'POST') return send(res, 200, await svc.createOrder(body));
    if (b === 'orders' && c && d === 'status' && method === 'PATCH') return send(res, 200, await svc.setOrderStatus(c, body.status));
    if (b === 'orders' && c && d === 'commission' && method === 'PATCH') return send(res, 200, await svc.payCommission(c));
  }

  throw new HttpError(404, 'Rota não encontrada.');
}

module.exports = async function handler(req, res) {
  try {
    await route(req, res);
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    console.error('API error:', err && err.stack || err);
    const ref = String((err && (err.code || err.name)) || 'ERR').slice(0, 30);
    const dbDown = err && (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT' || /connect|timeout/i.test(String(err.message)));
    return send(res, dbDown ? 503 : 500, { error: (dbDown ? 'Serviço temporariamente indisponível. Tente novamente.' : 'Erro interno. Tente novamente.') + ` (código: ${ref})` });
  } finally {
    if (Math.random() < 0.01) db.cleanup().catch(() => {});
  }
};


'use strict';
const crypto = require('crypto');
const { HttpError, safeEqual, sha256, randomHex } = require('./util');

const COOKIE = 'aurea_admin';

function secret() {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16) return s;
  // Fallback determinístico para nunca quebrar o login por falta de variável.
  // Recomendado definir SESSION_SECRET na Vercel.
  return sha256('aurea|' + (process.env.ADMIN_PASSWORD || '') + '|' + (process.env.DATABASE_URL || ''));
}

function sessionMs() {
  const h = Number(process.env.SESSION_HOURS || 12);
  return (Number.isFinite(h) && h > 0 ? Math.min(h, 24 * 30) : 12) * 3600000;
}

function adminConfigured() {
  return !!process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length >= 8;
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

function createSession() {
  const exp = Date.now() + sessionMs();
  const payload = `${exp}.${randomHex(12)}`;
  return { token: `${payload}.${sign(payload)}`, exp };
}

function verifySession(token) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const payload = parts[0] + '.' + parts[1];
  const expected = sign(payload);
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const exp = Number(parts[0]);
  return Number.isFinite(exp) && exp > Date.now();
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isHttps(req) {
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';
}

function setSessionCookie(req, res, token, exp) {
  const maxAge = Math.max(0, Math.floor((exp - Date.now()) / 1000));
  const flags = [`${COOKIE}=${encodeURIComponent(token)}`, 'Path=/api', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`];
  if (isHttps(req)) flags.push('Secure');
  res.setHeader('Set-Cookie', flags.join('; '));
}

function clearSessionCookie(req, res) {
  const flags = [`${COOKIE}=`, 'Path=/api', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (isHttps(req)) flags.push('Secure');
  res.setHeader('Set-Cookie', flags.join('; '));
}

function isAdmin(req) {
  return verifySession(parseCookies(req)[COOKIE]);
}

function requireAdmin(req) {
  if (!isAdmin(req)) throw new HttpError(401, 'Sessão expirada. Entre novamente.');
}

/** Proteção CSRF para métodos que alteram dados: exige Origin do mesmo host e cabeçalho customizado. */
function checkCsrf(req) {
  if (req.headers['x-requested-with'] !== 'aurea') throw new HttpError(403, 'Requisição bloqueada.');
  const origin = req.headers.origin;
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch (_) { /* inválido */ }
    const own = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (!host || host !== own) throw new HttpError(403, 'Origem não permitida.');
  }
}

function checkAdminCredentials(username, password) {
  const u = process.env.ADMIN_USERNAME || 'admin';
  // Avalia os dois para não vazar qual campo errou por tempo de resposta.
  const okU = safeEqual(String(username || ''), u);
  const okP = safeEqual(String(password || ''), process.env.ADMIN_PASSWORD || '');
  return okU && okP;
}

module.exports = {
  adminConfigured, createSession, setSessionCookie, clearSessionCookie, isAdmin, requireAdmin,
  checkCsrf, checkAdminCredentials
};

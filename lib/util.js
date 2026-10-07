'use strict';
const crypto = require('crypto');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomHex = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

function cleanStr(v, max, { required = false, label = 'Campo' } = {}) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (required && !s) throw new HttpError(400, `${label} é obrigatório.`);
  if (s.length > max) throw new HttpError(400, `${label} deve ter no máximo ${max} caracteres.`);
  return s;
}

const digits = v => String(v == null ? '' : v).replace(/\D/g, '');

function validPhone(v) {
  v = digits(v);
  if (v.startsWith('55')) {
    return /^55(?:1[1-9]|2[12478]|3[1-578]|4[1-9]|5[13-5]|6[1-9]|7[134579]|8[1-9]|9[1-9])(?:[2-5]\d{7}|9\d{8})$/.test(v);
  }
  return /^[1-9]\d{9,14}$/.test(v);
}

/** Converte valor decimal (reais) em centavos inteiros. Aceita number ou string "1.234,56". */
function toCents(v) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return NaN;
    return Math.round(v * 100);
  }
  const s = String(v == null ? '' : v).trim();
  if (!s) return NaN;
  let n;
  if (/^\d+(?:\.\d{1,2})?$/.test(s)) n = Number(s);
  else if (/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(s)) n = Number(s.replace(/\./g, '').replace(',', '.'));
  else return NaN;
  return Math.round(n * 100);
}

function normalizeCode(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 24);
}

function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || 'unknown';
}

module.exports = { HttpError, sha256, randomHex, safeEqual, clamp, cleanStr, digits, validPhone, toCents, normalizeCode, clientIp };

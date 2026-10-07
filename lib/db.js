'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { HttpError } = require('./util');

let pool;
let ready;

function connectionString() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL || '';
}

function getPool() {
  if (pool) return pool;
  const cs = connectionString();
  if (!cs) throw new HttpError(503, 'Banco de dados não configurado.');
  pool = new Pool({ connectionString: cs, max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 8000 });
  pool.on('error', () => { /* conexões ociosas podem cair; o pool recria */ });
  return pool;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  photo TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS affiliates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,
  commission NUMERIC(5,2) NULL CHECK (commission IS NULL OR (commission >= 0 AND commission <= 100)),
  pix TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','blocked')),
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  affiliate_code TEXT NOT NULL,
  product_id TEXT NOT NULL DEFAULT '',
  product_name TEXT NOT NULL DEFAULT '',
  value_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','converted')),
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  customer TEXT NOT NULL,
  value_cents INTEGER NOT NULL CHECK (value_cents > 0),
  affiliate_code TEXT NULL,
  reference TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','cancelled','refunded')),
  commission_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  commission_cents INTEGER NOT NULL DEFAULT 0 CHECK (commission_cents >= 0),
  commission_status TEXT NOT NULL DEFAULT 'none' CHECK (commission_status IN ('none','pending','approved','paid','reversed','clawback')),
  created_at BIGINT NOT NULL,
  paid_at BIGINT NULL,
  cancelled_at BIGINT NULL,
  commission_paid_at BIGINT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  window_start BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_affiliate ON orders(affiliate_code);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_affiliate ON leads(affiliate_code);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_products_position ON products(position, created_at);
`;

function loadCatalog() {
  try {
    const p = path.join(__dirname, '..', 'public', 'catalog.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return { name: 'Andreia semijoias', whatsapp: '5534998005534', instagram: 'andreiaqueirozjoias', products: [] };
  }
}

async function migrate() {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(727401)');
    await client.query(SCHEMA);
    const cat = loadCatalog();
    const defaults = {
      name: cat.name || 'Andreia semijoias',
      whatsapp: cat.whatsapp || '',
      instagram: cat.instagram || '',
      defaultCommission: '10',
      attributionDays: '30',
      minPayout: '50',
      affiliateEnabled: 'true',
      seeded: 'false'
    };
    for (const [k, v] of Object.entries(defaults)) {
      await client.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO NOTHING', [k, v]);
    }
    const seeded = await client.query("SELECT value FROM settings WHERE key='seeded'");
    if (seeded.rows[0] && seeded.rows[0].value !== 'true') {
      const t = Date.now();
      let i = 0;
      for (const p of cat.products || []) {
        await client.query(
          'INSERT INTO products(id,name,price_cents,photo,position,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT (id) DO NOTHING',
          [String(p.id), p.name, Math.round(Number(p.price) * 100), p.photo, i++, t]
        );
      }
      await client.query("UPDATE settings SET value='true' WHERE key='seeded'");
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

/** Garante que o schema existe (uma vez por instância). Se falhar, tenta de novo na próxima requisição. */
function ensureReady() {
  if (!ready) {
    ready = migrate().catch(err => { ready = null; throw err; });
  }
  return ready;
}

async function query(text, params) {
  await ensureReady();
  return getPool().query(text, params);
}

/** Executa fn(client) dentro de uma transação, com rollback automático. */
async function tx(fn) {
  await ensureReady();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

async function getSettings() {
  const { rows } = await query('SELECT key,value FROM settings');
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  return {
    name: s.name || 'Andreia semijoias',
    whatsapp: s.whatsapp || '',
    instagram: s.instagram || '',
    affiliate: {
      enabled: s.affiliateEnabled !== 'false',
      defaultCommission: Number(s.defaultCommission || 10),
      attributionDays: Number(s.attributionDays || 30),
      minPayout: Number(s.minPayout || 50)
    }
  };
}

async function setSettings(client, entries) {
  for (const [k, v] of Object.entries(entries)) {
    await client.query(
      'INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value',
      [k, String(v)]
    );
  }
}

/** Limitador de tentativas por janela fixa. Lança 429 se exceder. */
async function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const { rows } = await query(
    `INSERT INTO rate_limits(key,hits,window_start) VALUES($1::text,1,$2::bigint)
     ON CONFLICT (key) DO UPDATE SET
       hits = CASE WHEN rate_limits.window_start < $2::bigint - $3::bigint THEN 1 ELSE rate_limits.hits + 1 END,
       window_start = CASE WHEN rate_limits.window_start < $2::bigint - $3::bigint THEN $2::bigint ELSE rate_limits.window_start END
     RETURNING hits, window_start`,
    [key, now, windowMs]
  );
  if (rows[0].hits > max) {
    const wait = Math.max(1, Math.ceil((Number(rows[0].window_start) + windowMs - now) / 60000));
    throw new HttpError(429, `Muitas tentativas. Tente novamente em ${wait} min.`);
  }
}

async function rateReset(key) {
  await query('DELETE FROM rate_limits WHERE key=$1', [key]);
}

async function cleanup() {
  await query('DELETE FROM rate_limits WHERE window_start < $1', [Date.now() - 86400000]);
}

module.exports = { query, tx, getSettings, setSettings, rateLimit, rateReset, cleanup, ensureReady, connectionString };

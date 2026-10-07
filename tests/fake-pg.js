'use strict';
/* Banco falso em memória que entende exatamente as consultas usadas pelo app.
   Serve para testar toda a lógica (rotas, autenticação, validações, comissões) sem um Postgres real. */
const T = { settings: new Map(), products: [], affiliates: [], leads: [], orders: [], rate: new Map() };
const norm = s => s.replace(/\s+/g, ' ').trim();
const clone = o => (o ? { ...o } : o);
const big = v => (v === null || v === undefined ? v : String(v)); // pg devolve BIGINT/NUMERIC como string

function row(table, r) {
  const o = { ...r };
  for (const k of ['created_at', 'updated_at', 'paid_at', 'cancelled_at', 'commission_paid_at', 'window_start']) if (k in o) o[k] = big(o[k]);
  for (const k of ['commission', 'commission_rate']) if (k in o) o[k] = o[k] === null ? null : Number(o[k]).toFixed(2);
  return o;
}
const rows = (table, arr) => ({ rows: arr.map(r => row(table, r)), rowCount: arr.length });

function check(cond, msg) { if (!cond) { const e = new Error(msg); e.code = '23514'; throw e; } }

function run(sqlRaw, p = []) {
  const sql = norm(sqlRaw);
  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) || /^SELECT pg_advisory_xact_lock/.test(sql) || /^CREATE TABLE/.test(sql)) return { rows: [], rowCount: 0 };
  if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }], rowCount: 1 };

  // settings
  if (sql === 'SELECT key,value FROM settings') return { rows: [...T.settings].map(([key, value]) => ({ key, value })), rowCount: T.settings.size };
  let m;
  if (/^INSERT INTO settings\(key,value\) VALUES\(\$1,\$2\) ON CONFLICT \(key\) DO NOTHING$/.test(sql)) { if (!T.settings.has(p[0])) T.settings.set(p[0], p[1]); return { rows: [], rowCount: 1 }; }
  if (/^INSERT INTO settings\(key,value\) VALUES\(\$1,\$2\) ON CONFLICT \(key\) DO UPDATE/.test(sql)) { T.settings.set(p[0], p[1]); return { rows: [], rowCount: 1 }; }
  if ((m = /^SELECT value FROM settings WHERE key='(\w+)'$/.exec(sql))) return { rows: T.settings.has(m[1]) ? [{ value: T.settings.get(m[1]) }] : [], rowCount: 1 };
  if (sql === "UPDATE settings SET value='true' WHERE key='seeded'") { T.settings.set('seeded', 'true'); return { rows: [], rowCount: 1 }; }

  // products
  if (/^INSERT INTO products\(id,name,price_cents,photo,position,created_at,updated_at\) VALUES\(\$1,\$2,\$3,\$4,\$5,\$6,\$6\)/.test(sql)) {
    if (T.products.some(x => x.id === p[0])) { if (/ON CONFLICT/.test(sql)) return { rows: [], rowCount: 0 }; throw new Error('dup'); }
    check(p[2] > 0, 'price'); T.products.push({ id: p[0], name: p[1], price_cents: p[2], photo: p[3], position: p[4], created_at: p[5], updated_at: p[5] }); return { rows: [], rowCount: 1 };
  }
  if (/^SELECT id,name,price_cents,photo,updated_at FROM products ORDER BY/.test(sql)) return rows('p', [...T.products].sort((a, b) => a.position - b.position || a.created_at - b.created_at));
  if (/^SELECT id,name,price_cents,photo,updated_at FROM products WHERE id=\$1$/.test(sql)) return rows('p', T.products.filter(x => x.id === p[0]));
  if (/^SELECT id FROM products WHERE id=\$1 FOR UPDATE$/.test(sql)) return rows('p', T.products.filter(x => x.id === p[0]).map(x => ({ id: x.id })));
  if (/^SELECT id,name,price_cents FROM products WHERE id=\$1$/.test(sql)) return rows('p', T.products.filter(x => x.id === p[0]));
  if (/^SELECT photo FROM products WHERE id=\$1$/.test(sql)) return rows('p', T.products.filter(x => x.id === p[0]).map(x => ({ photo: x.photo })));
  if (/^SELECT COUNT\(\*\)::int AS n, COALESCE\(MAX\(position\),-1\)\+1 AS next FROM products$/.test(sql)) return { rows: [{ n: T.products.length, next: T.products.reduce((a, x) => Math.max(a, x.position), -1) + 1 }], rowCount: 1 };
  if (/^UPDATE products SET name=\$2,price_cents=\$3,photo=\$4,updated_at=\$5 WHERE id=\$1$/.test(sql)) { const x = T.products.find(r => r.id === p[0]); check(p[2] > 0, 'price'); Object.assign(x, { name: p[1], price_cents: p[2], photo: p[3], updated_at: p[4] }); return { rows: [], rowCount: 1 }; }
  if (/^UPDATE products SET name=\$2,price_cents=\$3,updated_at=\$4 WHERE id=\$1$/.test(sql)) { const x = T.products.find(r => r.id === p[0]); check(p[2] > 0, 'price'); Object.assign(x, { name: p[1], price_cents: p[2], updated_at: p[3] }); return { rows: [], rowCount: 1 }; }
  if (/^DELETE FROM products WHERE id=\$1$/.test(sql)) { const n = T.products.length; T.products = T.products.filter(x => x.id !== p[0]); return { rows: [], rowCount: n - T.products.length }; }

  // affiliates
  if (/^SELECT code,name FROM affiliates WHERE code=\$1 AND status='active'$/.test(sql)) return rows('a', T.affiliates.filter(x => x.code === p[0] && x.status === 'active'));
  if (/^SELECT code FROM affiliates WHERE code=\$1 AND status='active'$/.test(sql)) return rows('a', T.affiliates.filter(x => x.code === p[0] && x.status === 'active'));
  if (/^SELECT \* FROM affiliates ORDER BY created_at DESC$/.test(sql)) return rows('a', [...T.affiliates].sort((a, b) => b.created_at - a.created_at));
  if (/^SELECT \* FROM affiliates WHERE code=\$1$/.test(sql)) return rows('a', T.affiliates.filter(x => x.code === p[0]));
  if (/^SELECT \* FROM affiliates WHERE id=\$1( FOR UPDATE)?$/.test(sql)) return rows('a', T.affiliates.filter(x => x.id === p[0]));
  if (/^SELECT 1 FROM affiliates WHERE code=\$1$/.test(sql)) return { rows: T.affiliates.filter(x => x.code === p[0]).map(() => ({})), rowCount: 1 };
  if (/^INSERT INTO affiliates\(/.test(sql)) {
    check(!T.affiliates.some(x => x.code === p[4]), 'unique code');
    check(p[6] === null || (p[6] >= 0 && p[6] <= 100), 'commission range'); check(['active', 'pending', 'blocked'].includes(p[8]), 'status');
    T.affiliates.push({ id: p[0], name: p[1], email: p[2], phone: p[3], code: p[4], token_hash: p[5], commission: p[6], pix: p[7], status: p[8], created_at: p[9] }); return { rows: [], rowCount: 1 };
  }
  if (/^UPDATE affiliates SET status=\$2 WHERE id=\$1$/.test(sql)) { check(['active', 'pending', 'blocked'].includes(p[1]), 'status'); T.affiliates.find(x => x.id === p[0]).status = p[1]; return { rows: [], rowCount: 1 }; }
  if (/^UPDATE affiliates SET commission=\$2 WHERE id=\$1$/.test(sql)) { check(p[1] === null || (p[1] >= 0 && p[1] <= 100), 'commission range'); T.affiliates.find(x => x.id === p[0]).commission = p[1]; return { rows: [], rowCount: 1 }; }
  if (/^UPDATE affiliates SET token_hash=\$2 WHERE id=\$1 RETURNING code$/.test(sql)) { const x = T.affiliates.find(r => r.id === p[0]); if (!x) return { rows: [], rowCount: 0 }; x.token_hash = p[1]; return { rows: [{ code: x.code }], rowCount: 1 }; }

  // leads
  if (/^INSERT INTO leads\(/.test(sql)) { if (T.leads.some(x => x.id === p[0])) return { rows: [], rowCount: 0 }; T.leads.push({ id: p[0], affiliate_code: p[1], product_id: p[2], product_name: p[3], value_cents: p[4], status: p[5], created_at: p[6] }); return { rows: [], rowCount: 1 }; }
  if (/^SELECT \* FROM leads ORDER BY created_at DESC/.test(sql)) return rows('l', [...T.leads].sort((a, b) => b.created_at - a.created_at));
  if (/^UPDATE leads SET status='converted' WHERE id=\$1$/.test(sql)) { const x = T.leads.find(l => l.id === p[0]); if (x) x.status = 'converted'; return { rows: [], rowCount: x ? 1 : 0 }; }
  if (/^SELECT COUNT\(\*\)::int AS n FROM leads WHERE affiliate_code=\$1$/.test(sql)) return { rows: [{ n: T.leads.filter(l => l.affiliate_code === p[0]).length }], rowCount: 1 };

  // orders
  if (/^INSERT INTO orders\(/.test(sql)) {
    check(p[2] > 0, 'value'); check(['pending', 'paid', 'cancelled', 'refunded'].includes(p[5]), 'status');
    T.orders.push({ id: p[0], customer: p[1], value_cents: p[2], affiliate_code: p[3], reference: p[4], status: p[5], commission_rate: p[6], commission_cents: p[7], commission_status: p[8], created_at: p[9], paid_at: p[10], cancelled_at: null, commission_paid_at: null }); return { rows: [], rowCount: 1 };
  }
  if (/^SELECT \* FROM orders WHERE id=\$1( FOR UPDATE)?$/.test(sql)) return rows('o', T.orders.filter(x => x.id === p[0]));
  if (/^SELECT \* FROM orders ORDER BY created_at DESC LIMIT 200$/.test(sql)) return rows('o', [...T.orders].sort((a, b) => b.created_at - a.created_at));
  if (/^SELECT \* FROM orders WHERE affiliate_code=\$1 ORDER BY created_at DESC LIMIT 100$/.test(sql)) return rows('o', T.orders.filter(x => x.affiliate_code === p[0]).sort((a, b) => b.created_at - a.created_at));
  if (/^UPDATE orders SET status=\$2, commission_status=\$3,/.test(sql)) {
    const o = T.orders.find(x => x.id === p[0]); o.status = p[1]; o.commission_status = p[2];
    if (p[1] === 'paid') o.paid_at = p[3]; if (['cancelled', 'refunded'].includes(p[1])) o.cancelled_at = p[3]; return { rows: [], rowCount: 1 };
  }
  if (/^UPDATE orders SET commission_status='paid', commission_paid_at=\$2 WHERE id=\$1$/.test(sql)) { const o = T.orders.find(x => x.id === p[0]); o.commission_status = 'paid'; o.commission_paid_at = p[1]; return { rows: [], rowCount: 1 }; }

  // rate limits
  if (/^INSERT INTO rate_limits/.test(sql)) {
    const now = Number(p[1]), win = Number(p[2]); const cur = T.rate.get(p[0]);
    if (!cur) T.rate.set(p[0], { hits: 1, window_start: now });
    else if (cur.window_start < now - win) { cur.hits = 1; cur.window_start = now; } else cur.hits++;
    const r = T.rate.get(p[0]); return { rows: [{ hits: r.hits, window_start: String(r.window_start) }], rowCount: 1 };
  }
  if (/^DELETE FROM rate_limits WHERE key=\$1$/.test(sql)) { T.rate.delete(p[0]); return { rows: [], rowCount: 1 }; }
  if (/^DELETE FROM rate_limits WHERE window_start/.test(sql)) return { rows: [], rowCount: 0 };

  throw new Error('FAKE-PG: consulta não suportada: ' + sql);
}

class Client {
  async query(sql, params) { return run(sql, params); }
  release() {}
}
class Pool {
  on() {}
  async connect() { return new Client(); }
  async query(sql, params) { return run(sql, params); }
}
module.exports = { Pool, __tables: T };

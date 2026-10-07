'use strict';
/* Teste de fumaça contra o site JÁ publicado (banco real).
   Uso: BASE_URL=https://seusite.vercel.app ADMIN_USERNAME=... ADMIN_PASSWORD=... node tests/smoke.js
   Cria e remove uma joia de teste. Não deixa dados para trás. */
const base = (process.env.BASE_URL || '').replace(/\/$/, '');
if (!base || !process.env.ADMIN_PASSWORD) { console.error('Defina BASE_URL e ADMIN_PASSWORD (e ADMIN_USERNAME).'); process.exit(1); }
let cookie = '';
const JPG = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 1)]).toString('base64');
async function call(m, p, b) {
  const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'aurea', Origin: base, ...(cookie ? { Cookie: cookie } : {}) }, body: b && m !== 'GET' ? JSON.stringify(b) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const j = (r.headers.get('content-type') || '').includes('json') ? await r.json() : null;
  return { status: r.status, json: j };
}
const step = async (name, fn) => { try { await fn(); console.log('ok -', name); } catch (e) { console.log('FALHA -', name, '->', e.message); process.exitCode = 1; } };
const must = (c, m) => { if (!c) throw new Error(m); };
(async () => {
  let id;
  await step('banco responde (/api/health)', async () => must((await call('GET', '/api/health')).status === 200, 'health != 200'));
  await step('vitrine carrega', async () => must((await call('GET', '/api/store')).json.products.length >= 0, 'store inválido'));
  await step('login do dono', async () => must((await call('POST', '/api/admin/login', { username: process.env.ADMIN_USERNAME || 'admin', password: process.env.ADMIN_PASSWORD })).status === 200, 'login falhou'));
  await step('cria joia', async () => { const r = await call('POST', '/api/admin/products', { name: 'TESTE-SMOKE', priceCents: 100, photo: JPG }); must(r.status === 200, JSON.stringify(r.json)); id = r.json.product.id; });
  await step('joia aparece na vitrine', async () => must((await call('GET', '/api/store')).json.products.some(p => p.id === id), 'não apareceu (cache de até ~15s: tente de novo)'));
  await step('remove joia de teste', async () => must((await call('DELETE', '/api/admin/products/' + id)).status === 200, 'delete falhou'));
  await step('logout', async () => must((await call('POST', '/api/admin/logout', {})).status === 200, 'logout falhou'));
})();

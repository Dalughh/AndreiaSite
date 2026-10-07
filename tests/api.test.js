'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./dev-server');
const { tables } = require('./harness');

let server, base, cookie = '';
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'aurea' };

async function call(method, path, body, opts = {}) {
  const headers = { ...H, ...(opts.headers || {}) };
  if (cookie && !opts.noCookie) headers.Cookie = cookie;
  if (opts.noCsrf) delete headers['X-Requested-With'];
  const res = await fetch(base + path, { method, headers, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body), redirect: 'manual' });
  const sc = res.headers.get('set-cookie');
  if (sc && opts.keepCookie !== false) cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
  let json = null; const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) json = await res.json();
  return { status: res.status, json, res };
}
// JPEG mínimo válido (cabeçalho FFD8 + preenchimento) — só precisa passar na checagem de formato.
const JPG = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 1)]).toString('base64');

test.before(async () => { server = await start(0); base = 'http://127.0.0.1:' + server.address().port; });
test.after(() => server.close());

test('loja pública: semeia catálogo e não vaza dados internos', async () => {
  const r = await call('GET', '/api/store', undefined, { noCookie: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.products.length, 6);
  assert.ok(r.json.products.every(p => Number.isInteger(p.priceCents) && p.priceCents > 0));
  assert.equal(r.json.products[0].photo, '/img/p1.jpg');
  const txt = JSON.stringify(r.json);
  assert.ok(!/commission|token|email|pix/i.test(txt.replace(/attributionDays/g, '')), 'não deve expor afiliados/comissões');
});

test('admin: sem sessão tudo é bloqueado (401)', async () => {
  for (const [m, p] of [['GET', '/api/admin/data'], ['POST', '/api/admin/products'], ['POST', '/api/admin/orders'], ['PUT', '/api/admin/settings'], ['DELETE', '/api/admin/products/x'], ['POST', '/api/admin/affiliates']]) {
    const r = await call(m, p, {}, { noCookie: true });
    assert.equal(r.status, 401, `${m} ${p}`);
  }
});

test('CSRF: mutações sem cabeçalho ou com origem estranha são recusadas', async () => {
  let r = await call('POST', '/api/admin/login', { username: 'dona', password: 'SenhaForte#2026' }, { noCsrf: true, noCookie: true });
  assert.equal(r.status, 403);
  r = await call('POST', '/api/admin/login', { username: 'dona', password: 'SenhaForte#2026' }, { headers: { Origin: 'https://evil.example' }, noCookie: true });
  assert.equal(r.status, 403);
});

test('login: senha errada falha; correta cria cookie HttpOnly/SameSite=Strict', async () => {
  let r = await call('POST', '/api/admin/login', { username: 'dona', password: 'errada' }, { noCookie: true });
  assert.equal(r.status, 401);
  r = await call('POST', '/api/admin/login', { username: 'admin', password: 'SenhaForte#2026' }, { noCookie: true });
  assert.equal(r.status, 401, 'usuário errado também falha');
  r = await call('POST', '/api/admin/login', { username: 'dona', password: 'SenhaForte#2026' }, { noCookie: true });
  assert.equal(r.status, 200);
  const sc = r.res.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/); assert.match(sc, /Path=\/api/);
  assert.ok(cookie.startsWith('aurea_admin='));
  const s = await call('GET', '/api/admin/session');
  assert.equal(s.json.authenticated, true);
});

test('login: cookie adulterado/expirado não vale', async () => {
  const bad = cookie.replace(/.$/, c => (c === 'a' ? 'b' : 'a'));
  const r = await call('GET', '/api/admin/data', undefined, { headers: { Cookie: bad }, noCookie: true });
  assert.equal(r.status, 401);
});

test('login: bloqueio por excesso de tentativas (429)', async () => {
  tables.rate.clear();
  let last;
  for (let i = 0; i < 9; i++) last = await call('POST', '/api/admin/login', { username: 'dona', password: 'x' + i }, { noCookie: true, keepCookie: false });
  assert.equal(last.status, 429);
  tables.rate.clear();
});

let productId;
test('produtos: validação de preço/foto e criação', async () => {
  const bad = [
    { name: '', priceCents: 1000, photo: JPG },
    { name: 'Anel', priceCents: 0, photo: JPG },
    { name: 'Anel', priceCents: -5, photo: JPG },
    { name: 'Anel', priceCents: 10.5, photo: JPG },
    { name: 'Anel', priceCents: 1000 },
    { name: 'Anel', priceCents: 1000, photo: 'data:text/html;base64,PGgxPg==' },
    { name: 'Anel', priceCents: 1000, photo: 'data:image/jpeg;base64,' + Buffer.alloc(300, 65).toString('base64') },
    { name: 'x'.repeat(200), priceCents: 1000, photo: JPG }
  ];
  for (const b of bad) assert.equal((await call('POST', '/api/admin/products', b)).status, 400, JSON.stringify(b).slice(0, 60));
  const ok = await call('POST', '/api/admin/products', { name: 'Anel Teste', price: '1.299,90', photo: JPG });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.product.priceCents, 129990);
  assert.match(ok.json.product.photo, /^\/api\/photo\//);
  productId = ok.json.product.id;
  const ph = await call('GET', ok.json.product.photo, undefined, { noCookie: true });
  assert.equal(ph.status, 200); assert.equal(ph.res.headers.get('content-type'), 'image/jpeg');
});

test('produtos: editar sem trocar foto, id inexistente e exclusão', async () => {
  let r = await call('POST', '/api/admin/products', { id: productId, name: 'Anel Novo', priceCents: 5000 });
  assert.equal(r.status, 200); assert.equal(r.json.product.name, 'Anel Novo'); assert.equal(r.json.product.priceCents, 5000);
  r = await call('POST', '/api/admin/products', { id: 'naoexiste', name: 'X', priceCents: 5000 });
  assert.equal(r.status, 404);
  r = await call('DELETE', '/api/admin/products/' + productId);
  assert.equal(r.status, 200);
  assert.equal((await call('DELETE', '/api/admin/products/' + productId)).status, 404);
});

test('configurações: WhatsApp e Instagram validados', async () => {
  assert.equal((await call('PUT', '/api/admin/settings', { name: 'Loja', whatsapp: '123', instagram: '' })).status, 400);
  assert.equal((await call('PUT', '/api/admin/settings', { name: 'Loja', whatsapp: '5534998005534', instagram: 'a b' })).status, 400);
  assert.equal((await call('PUT', '/api/admin/settings', { name: '', whatsapp: '5534998005534' })).status, 400);
  const ok = await call('PUT', '/api/admin/settings', { name: 'Andreia semijoias', whatsapp: '+55 (34) 99800-5534', instagram: '@andreiaqueirozjoias' });
  assert.equal(ok.status, 200); assert.equal(ok.json.settings.whatsapp, '5534998005534'); assert.equal(ok.json.settings.instagram, 'andreiaqueirozjoias');
  assert.equal((await call('PUT', '/api/admin/settings/affiliate', { defaultCommission: 150, attributionDays: 30, minPayout: 0, enabled: true })).status, 400);
  assert.equal((await call('PUT', '/api/admin/settings/affiliate', { defaultCommission: 10, attributionDays: 0, minPayout: 0, enabled: true })).status, 400);
  assert.equal((await call('PUT', '/api/admin/settings/affiliate', { defaultCommission: 10, attributionDays: 30, minPayout: 50, enabled: true })).status, 200);
});

let aff, token;
test('afiliados: criação, código único, token só aparece uma vez', async () => {
  assert.equal((await call('POST', '/api/admin/affiliates', { name: '' })).status, 400);
  assert.equal((await call('POST', '/api/admin/affiliates', { name: 'Ana', email: 'invalido' })).status, 400);
  assert.equal((await call('POST', '/api/admin/affiliates', { name: 'Ana', commission: 101 })).status, 400);
  const a = await call('POST', '/api/admin/affiliates', { name: 'Ana Júlia', email: 'ana@x.com', commission: 15 });
  assert.equal(a.status, 200); aff = a.json.affiliate; token = a.json.accessToken;
  assert.equal(aff.code, 'ANAJULIA'); assert.match(token, /^AT-[0-9a-f]{32}$/);
  const b = await call('POST', '/api/admin/affiliates', { name: 'Ana Júlia' });
  assert.equal(b.json.affiliate.code, 'ANAJULIA2');
  const list = await call('GET', '/api/admin/data');
  assert.ok(!JSON.stringify(list.json).includes(token), 'token não pode ser listado');
  assert.ok(!JSON.stringify(list.json).includes('token_hash'));
});

test('afiliado: resolve só ativos e login seguro', async () => {
  let r = await call('GET', '/api/affiliate/resolve?code=anajulia', undefined, { noCookie: true });
  assert.equal(r.json.affiliate.code, 'ANAJULIA');
  r = await call('GET', '/api/affiliate/resolve?code=NAOEXISTE', undefined, { noCookie: true });
  assert.equal(r.json.affiliate, null);
  r = await call('POST', '/api/affiliate/login', { code: 'ANAJULIA', token: 'AT-errado' }, { noCookie: true });
  assert.equal(r.status, 401);
  r = await call('POST', '/api/affiliate/login', { code: 'NAOEXISTE', token: token }, { noCookie: true });
  assert.equal(r.status, 401); assert.equal(r.json.error, 'Código ou token inválido.');
  r = await call('POST', '/api/affiliate/login', { code: 'ANAJULIA', token }, { noCookie: true });
  assert.equal(r.status, 200); assert.equal(r.json.affiliate.commission, 15);
});

test('leads: registro válido, idempotente e preço vem do servidor', async () => {
  const store = await call('GET', '/api/store', undefined, { noCookie: true });
  const p = store.json.products[0];
  const body = { affiliateCode: 'anajulia', productId: p.id, leadId: 'LABCDEF0123456789', value: 1 };
  assert.equal((await call('POST', '/api/leads', body, { noCookie: true })).status, 200);
  assert.equal((await call('POST', '/api/leads', body, { noCookie: true })).status, 200);
  const leads = tables.leads.filter(l => l.id === 'LABCDEF0123456789');
  assert.equal(leads.length, 1); assert.equal(leads[0].value_cents, p.priceCents); assert.equal(leads[0].product_name, p.name);
  assert.equal((await call('POST', '/api/leads', { affiliateCode: 'anajulia', leadId: 'x' }, { noCookie: true })).status, 400);
  const ghost = await call('POST', '/api/leads', { affiliateCode: 'FANTASMA', leadId: 'LABCDEF0123456780' }, { noCookie: true });
  assert.equal(ghost.json.tracked, false);
});

let orderId;
test('vendas: validação e comissão calculada em centavos', async () => {
  const bad = [{ customer: '', valueCents: 1000 }, { customer: 'Maria', valueCents: 0 }, { customer: 'Maria', valueCents: 1000, status: 'refunded' }, { customer: 'Maria', valueCents: 1000, affiliateCode: 'FANTASMA' }];
  for (const b of bad) assert.equal((await call('POST', '/api/admin/orders', b)).status, 400, JSON.stringify(b));
  const r = await call('POST', '/api/admin/orders', { customer: 'Maria', value: '129,90', affiliateCode: 'ANAJULIA', leadId: 'LABCDEF0123456789' });
  assert.equal(r.status, 200); const o = r.json.order; orderId = o.id;
  assert.equal(o.valueCents, 12990); assert.equal(o.commissionRate, 15); assert.equal(o.commissionCents, 1949); // 12990*15% = 1948,5 -> 1949
  assert.equal(o.status, 'pending'); assert.equal(o.commissionStatus, 'pending');
  assert.equal(tables.leads.find(l => l.id === 'LABCDEF0123456789').status, 'converted');
});

test('vendas: mudar % do afiliado depois não altera vendas antigas', async () => {
  await call('PATCH', '/api/admin/affiliates/' + aff.id, { commission: 50 });
  const d = await call('GET', '/api/admin/data');
  assert.equal(d.json.orders.find(o => o.id === orderId).commissionCents, 1949);
  await call('PATCH', '/api/admin/affiliates/' + aff.id, { commission: 15 });
});

test('vendas: máquina de estados e comissões', async () => {
  assert.equal((await call('PATCH', `/api/admin/orders/${orderId}/commission`, {})).status, 400, 'não paga comissão de venda pendente');
  let r = await call('PATCH', `/api/admin/orders/${orderId}/status`, { status: 'banana' });
  assert.equal(r.status, 400);
  r = await call('PATCH', `/api/admin/orders/${orderId}/status`, { status: 'refunded' });
  assert.equal(r.status, 400, 'pendente não pode ser reembolsada');
  r = await call('PATCH', `/api/admin/orders/${orderId}/status`, { status: 'paid' });
  assert.equal(r.json.order.commissionStatus, 'approved'); assert.ok(r.json.order.paidAt);
  r = await call('PATCH', `/api/admin/orders/${orderId}/status`, { status: 'paid' });
  assert.equal(r.status, 200, 'repetir é idempotente');
  assert.equal((await call('PATCH', `/api/admin/orders/${orderId}/status`, { status: 'cancelled' })).status, 400, 'paga só pode ser reembolsada');
  r = await call('PATCH', `/api/admin/orders/${orderId}/commission`, {});
  assert.equal(r.json.order.commissionStatus, 'paid');
  assert.equal((await call('PATCH', `/api/admin/orders/${orderId}/commission`, {})).json.order.commissionStatus, 'paid', 'idempotente');
  r = await call('PATCH', `/api/admin/orders/${orderId}/status`, { status: 'refunded' });
  assert.equal(r.json.order.commissionStatus, 'clawback', 'reembolso após comissão paga => a devolver');
  assert.equal((await call('PATCH', `/api/admin/orders/${orderId}/status`, { status: 'paid' })).status, 400, 'estado final');
});

test('vendas: cancelar pendente reverte comissão; venda sem afiliado não gera comissão', async () => {
  let r = await call('POST', '/api/admin/orders', { customer: 'João', valueCents: 10000, affiliateCode: 'ANAJULIA' });
  r = await call('PATCH', `/api/admin/orders/${r.json.order.id}/status`, { status: 'cancelled' });
  assert.equal(r.json.order.commissionStatus, 'reversed');
  r = await call('POST', '/api/admin/orders', { customer: 'Sem', valueCents: 10000, status: 'paid' });
  assert.equal(r.json.order.commissionCents, 0); assert.equal(r.json.order.commissionStatus, 'none');
  assert.equal((await call('PATCH', '/api/admin/orders/NAOEXISTE/status', { status: 'paid' })).status, 404);
});

test('afiliado: painel mostra totais corretos e esconde dados de outros', async () => {
  const r = await call('POST', '/api/affiliate/login', { code: 'ANAJULIA', token }, { noCookie: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.stats.clawbackCents, 1949);
  assert.equal(r.json.stats.salesCents, 0);
  assert.ok(r.json.orders.every(o => !('customer' in o)), 'cliente não aparece para o afiliado');
});

test('afiliado bloqueado perde acesso e atribuição; novo token invalida o antigo', async () => {
  await call('PATCH', '/api/admin/affiliates/' + aff.id, { status: 'blocked' });
  assert.equal((await call('POST', '/api/affiliate/login', { code: 'ANAJULIA', token }, { noCookie: true })).status, 401);
  assert.equal((await call('GET', '/api/affiliate/resolve?code=ANAJULIA', undefined, { noCookie: true })).json.affiliate, null);
  assert.equal((await call('POST', '/api/admin/orders', { customer: 'X', valueCents: 1000, affiliateCode: 'ANAJULIA' })).status, 400);
  await call('PATCH', '/api/admin/affiliates/' + aff.id, { status: 'active' });
  const n = await call('POST', `/api/admin/affiliates/${aff.id}/regenerate-token`, {});
  assert.notEqual(n.json.accessToken, token);
  assert.equal((await call('POST', '/api/affiliate/login', { code: 'ANAJULIA', token }, { noCookie: true })).status, 401);
  assert.equal((await call('POST', '/api/affiliate/login', { code: 'ANAJULIA', token: n.json.accessToken }, { noCookie: true })).status, 200);
});

test('programa pausado: indicações deixam de ser registradas', async () => {
  await call('PUT', '/api/admin/settings/affiliate', { defaultCommission: 10, attributionDays: 30, minPayout: 50, enabled: false });
  assert.equal((await call('GET', '/api/affiliate/resolve?code=ANAJULIA', undefined, { noCookie: true })).json.affiliate, null);
  const r = await call('POST', '/api/leads', { affiliateCode: 'ANAJULIA', leadId: 'LZZZZZZZZZZZZ1' }, { noCookie: true });
  assert.equal(r.json.tracked, false);
  await call('PUT', '/api/admin/settings/affiliate', { defaultCommission: 10, attributionDays: 30, minPayout: 50, enabled: true });
});

test('rotas desconhecidas e logout', async () => {
  assert.equal((await call('GET', '/api/nada', undefined, { noCookie: true })).status, 404);
  await call('POST', '/api/admin/logout', {});
  assert.equal(cookie, '');
});

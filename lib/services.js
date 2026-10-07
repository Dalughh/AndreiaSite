'use strict';
const db = require('./db');
const { HttpError, sha256, randomHex, safeEqual, cleanStr, digits, validPhone, toCents, normalizeCode } = require('./util');

const MAX_PRICE_CENTS = 99999999;
const ORDER_STATUSES = ['pending', 'paid', 'cancelled', 'refunded'];
const AFF_STATUSES = ['active', 'pending', 'blocked'];

/* ---------- Visões (linha do banco -> JSON da API) ---------- */
const num = v => (v === null || v === undefined ? null : Number(v));

function productView(r) {
  const uploaded = r.photo.startsWith('data:');
  return {
    id: r.id,
    name: r.name,
    priceCents: r.price_cents,
    photo: uploaded ? `/api/photo/${encodeURIComponent(r.id)}?v=${r.updated_at}` : r.photo
  };
}
function affiliateView(r) {
  return {
    id: r.id, name: r.name, email: r.email, phone: r.phone, code: r.code,
    commission: num(r.commission), pix: r.pix, status: r.status, createdAt: Number(r.created_at)
  };
}
function orderView(r) {
  return {
    id: r.id, customer: r.customer, valueCents: r.value_cents, affiliateCode: r.affiliate_code,
    reference: r.reference, status: r.status, commissionRate: num(r.commission_rate),
    commissionCents: r.commission_cents, commissionStatus: r.commission_status,
    createdAt: Number(r.created_at), paidAt: num(r.paid_at), cancelledAt: num(r.cancelled_at),
    commissionPaidAt: num(r.commission_paid_at)
  };
}
function leadView(r) {
  return {
    id: r.id, affiliateCode: r.affiliate_code, productId: r.product_id, productName: r.product_name,
    valueCents: r.value_cents, status: r.status, createdAt: Number(r.created_at)
  };
}

/* ---------- Loja pública ---------- */
async function publicStore() {
  const [settings, products] = await Promise.all([
    db.getSettings(),
    db.query('SELECT id,name,price_cents,photo,updated_at FROM products ORDER BY position ASC, created_at ASC')
  ]);
  return {
    name: settings.name,
    whatsapp: settings.whatsapp,
    instagram: settings.instagram,
    affiliate: { enabled: settings.affiliate.enabled, attributionDays: settings.affiliate.attributionDays },
    products: products.rows.map(productView)
  };
}

async function resolveAffiliate(codeRaw) {
  const code = normalizeCode(codeRaw);
  if (!code) return null;
  const settings = await db.getSettings();
  if (!settings.affiliate.enabled) return null;
  const { rows } = await db.query("SELECT code,name FROM affiliates WHERE code=$1 AND status='active'", [code]);
  return rows[0] ? { code: rows[0].code, name: rows[0].name } : null;
}

async function recordLead(body) {
  const settings = await db.getSettings();
  if (!settings.affiliate.enabled) return { ok: true, tracked: false };
  const code = normalizeCode(body && body.affiliateCode);
  const leadId = String((body && body.leadId) || '');
  if (!code || !/^L[A-Z0-9]{6,24}$/.test(leadId)) throw new HttpError(400, 'Dados inválidos.');
  const aff = await db.query("SELECT code FROM affiliates WHERE code=$1 AND status='active'", [code]);
  if (!aff.rows[0]) return { ok: true, tracked: false };
  let productId = '', productName = '', value = 0;
  const pid = String((body && body.productId) || '');
  if (pid) {
    const p = await db.query('SELECT id,name,price_cents FROM products WHERE id=$1', [pid]);
    if (p.rows[0]) { productId = p.rows[0].id; productName = p.rows[0].name; value = p.rows[0].price_cents; }
  }
  await db.query(
    'INSERT INTO leads(id,affiliate_code,product_id,product_name,value_cents,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING',
    [leadId, code, productId, productName, value, 'open', Date.now()]
  );
  return { ok: true, tracked: true };
}

/* ---------- Fotos ---------- */
function parsePhoto(photo) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(photo || ''));
  if (!m) throw new HttpError(400, 'Foto inválida. Use JPG, PNG ou WebP.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 100) throw new HttpError(400, 'Foto inválida.');
  if (buf.length > 2.5 * 1024 * 1024) throw new HttpError(400, 'Foto muito grande. Use uma imagem menor.');
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isWebp = buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP';
  const ok = (m[1] === 'jpeg' && isJpg) || (m[1] === 'png' && isPng) || (m[1] === 'webp' && isWebp);
  if (!ok) throw new HttpError(400, 'O arquivo não é uma imagem válida.');
  return { mime: 'image/' + m[1], buf };
}

async function getPhoto(id) {
  const { rows } = await db.query('SELECT photo FROM products WHERE id=$1', [String(id)]);
  if (!rows[0] || !rows[0].photo.startsWith('data:')) return null;
  return parsePhoto(rows[0].photo);
}

/* ---------- Admin: dados ---------- */
async function adminData() {
  const [settings, products, affiliates, orders, leads] = await Promise.all([
    db.getSettings(),
    db.query('SELECT id,name,price_cents,photo,updated_at FROM products ORDER BY position ASC, created_at ASC'),
    db.query('SELECT * FROM affiliates ORDER BY created_at DESC'),
    db.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200'),
    db.query("SELECT * FROM leads ORDER BY created_at DESC LIMIT 200")
  ]);
  return {
    settings,
    products: products.rows.map(productView),
    affiliates: affiliates.rows.map(affiliateView),
    orders: orders.rows.map(orderView),
    leads: leads.rows.map(leadView)
  };
}

async function saveSettings(body) {
  const name = cleanStr(body.name, 55, { required: true, label: 'Nome da loja' });
  const whatsapp = digits(body.whatsapp);
  if (!validPhone(whatsapp)) throw new HttpError(400, 'WhatsApp inválido. Informe DDI, DDD e número.');
  const instagram = cleanStr(body.instagram, 30).replace(/^@/, '');
  if (instagram && !/^[A-Za-z0-9._]{1,30}$/.test(instagram)) throw new HttpError(400, 'Instagram inválido.');
  await db.tx(c => db.setSettings(c, { name, whatsapp, instagram }));
  return db.getSettings();
}

async function saveAffiliateSettings(body) {
  const dc = Number(body.defaultCommission);
  const days = Number(body.attributionDays);
  const min = Number(body.minPayout);
  if (!Number.isFinite(dc) || dc < 0 || dc > 100) throw new HttpError(400, 'Comissão padrão deve ficar entre 0 e 100.');
  if (!Number.isFinite(days) || days < 1 || days > 365) throw new HttpError(400, 'Janela de atribuição deve ficar entre 1 e 365 dias.');
  if (!Number.isFinite(min) || min < 0 || min > 999999) throw new HttpError(400, 'Valor mínimo inválido.');
  await db.tx(c => db.setSettings(c, {
    defaultCommission: Math.round(dc * 100) / 100,
    attributionDays: Math.round(days),
    minPayout: Math.round(min * 100) / 100,
    affiliateEnabled: body.enabled ? 'true' : 'false'
  }));
  return db.getSettings();
}

/* ---------- Admin: produtos ---------- */
async function saveProduct(body) {
  const name = cleanStr(body.name, 85, { required: true, label: 'Nome da joia' });
  const priceCents = body.priceCents !== undefined ? Number(body.priceCents) : toCents(body.price);
  if (!Number.isInteger(priceCents) || priceCents <= 0 || priceCents > MAX_PRICE_CENTS) {
    throw new HttpError(400, 'Informe um preço válido maior que zero.');
  }
  const id = body.id ? String(body.id) : '';
  if (id && !/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new HttpError(400, 'Identificador inválido.');
  const hasPhoto = typeof body.photo === 'string' && body.photo.length > 0;
  if (hasPhoto) parsePhoto(body.photo);
  const now = Date.now();
  return db.tx(async c => {
    if (id) {
      const cur = await c.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [id]);
      if (!cur.rows[0]) throw new HttpError(404, 'Essa joia não existe mais.');
      if (hasPhoto) {
        await c.query('UPDATE products SET name=$2,price_cents=$3,photo=$4,updated_at=$5 WHERE id=$1', [id, name, priceCents, body.photo, now]);
      } else {
        await c.query('UPDATE products SET name=$2,price_cents=$3,updated_at=$4 WHERE id=$1', [id, name, priceCents, now]);
      }
      const r = await c.query('SELECT id,name,price_cents,photo,updated_at FROM products WHERE id=$1', [id]);
      return productView(r.rows[0]);
    }
    if (!hasPhoto) throw new HttpError(400, 'Selecione uma foto da joia.');
    const count = await c.query('SELECT COUNT(*)::int AS n, COALESCE(MAX(position),-1)+1 AS next FROM products');
    if (count.rows[0].n >= 300) throw new HttpError(400, 'Limite de 300 joias atingido.');
    const newId = 'j' + randomHex(8);
    await c.query(
      'INSERT INTO products(id,name,price_cents,photo,position,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)',
      [newId, name, priceCents, body.photo, count.rows[0].next, now]
    );
    const r = await c.query('SELECT id,name,price_cents,photo,updated_at FROM products WHERE id=$1', [newId]);
    return productView(r.rows[0]);
  });
}

async function deleteProduct(id) {
  const r = await db.query('DELETE FROM products WHERE id=$1', [String(id)]);
  if (!r.rowCount) throw new HttpError(404, 'Essa joia não existe mais.');
  return { ok: true };
}

/* ---------- Admin: afiliados ---------- */
async function uniqueCode(c, name) {
  const base = normalizeCode(name).slice(0, 14) || 'AFILIADO';
  let code = base, n = 2;
  for (;;) {
    const r = await c.query('SELECT 1 FROM affiliates WHERE code=$1', [code]);
    if (!r.rows[0]) return code;
    code = base + n++;
  }
}

function parseCommission(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new HttpError(400, 'Comissão deve ficar entre 0 e 100.');
  return Math.round(n * 100) / 100;
}

async function createAffiliate(body) {
  const name = cleanStr(body.name, 80, { required: true, label: 'Nome do afiliado' });
  const email = cleanStr(body.email, 120, { label: 'E-mail' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'E-mail inválido.');
  const phone = digits(body.phone);
  if (phone && !validPhone(phone)) throw new HttpError(400, 'WhatsApp do afiliado inválido.');
  const pix = cleanStr(body.pix, 160, { label: 'Chave PIX' });
  const status = body.status || 'active';
  if (!AFF_STATUSES.includes(status)) throw new HttpError(400, 'Status inválido.');
  const commission = parseCommission(body.commission);
  const accessToken = 'AT-' + randomHex(16);
  return db.tx(async c => {
    await c.query('SELECT pg_advisory_xact_lock(727402)');
    const code = await uniqueCode(c, name);
    const id = 'a' + randomHex(8);
    await c.query(
      'INSERT INTO affiliates(id,name,email,phone,code,token_hash,commission,pix,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id, name, email, phone, code, sha256(accessToken), commission, pix, status, Date.now()]
    );
    const r = await c.query('SELECT * FROM affiliates WHERE id=$1', [id]);
    return { affiliate: affiliateView(r.rows[0]), accessToken };
  });
}

async function updateAffiliate(id, body) {
  return db.tx(async c => {
    const cur = await c.query('SELECT * FROM affiliates WHERE id=$1 FOR UPDATE', [id]);
    if (!cur.rows[0]) throw new HttpError(404, 'Afiliado não encontrado.');
    if (body.status !== undefined) {
      if (!AFF_STATUSES.includes(body.status)) throw new HttpError(400, 'Status inválido.');
      await c.query('UPDATE affiliates SET status=$2 WHERE id=$1', [id, body.status]);
    }
    if (body.commission !== undefined) {
      await c.query('UPDATE affiliates SET commission=$2 WHERE id=$1', [id, parseCommission(body.commission)]);
    }
    const r = await c.query('SELECT * FROM affiliates WHERE id=$1', [id]);
    return { affiliate: affiliateView(r.rows[0]) };
  });
}

async function regenerateToken(id) {
  const accessToken = 'AT-' + randomHex(16);
  const r = await db.query('UPDATE affiliates SET token_hash=$2 WHERE id=$1 RETURNING code', [id, sha256(accessToken)]);
  if (!r.rows[0]) throw new HttpError(404, 'Afiliado não encontrado.');
  return { code: r.rows[0].code, accessToken };
}

/* ---------- Admin: vendas e comissões ---------- */
function commissionStateFor(hasAffiliate, status, prev) {
  if (!hasAffiliate) return 'none';
  if (status === 'paid') return prev === 'paid' ? 'paid' : 'approved';
  if (status === 'pending') return 'pending';
  // cancelled / refunded
  return prev === 'paid' ? 'clawback' : 'reversed';
}

// Transições permitidas para o status da venda.
const TRANSITIONS = {
  pending: ['paid', 'cancelled'],
  paid: ['refunded'],
  cancelled: [],
  refunded: []
};

async function createOrder(body) {
  const customer = cleanStr(body.customer, 100, { required: true, label: 'Cliente' });
  const valueCents = body.valueCents !== undefined ? Number(body.valueCents) : toCents(body.value);
  if (!Number.isInteger(valueCents) || valueCents <= 0 || valueCents > MAX_PRICE_CENTS) throw new HttpError(400, 'Informe um valor de venda válido.');
  const status = String(body.status || 'pending');
  if (!['pending', 'paid'].includes(status)) throw new HttpError(400, 'A venda deve começar como pendente ou paga.');
  const reference = cleanStr(body.reference, 120, { label: 'Referência' });
  const code = normalizeCode(body.affiliateCode);
  const leadId = String(body.leadId || '');
  return db.tx(async c => {
    let aff = null;
    if (code) {
      const a = await c.query('SELECT * FROM affiliates WHERE code=$1', [code]);
      aff = a.rows[0];
      if (!aff || aff.status !== 'active') throw new HttpError(400, 'Código de afiliado inválido ou inativo.');
    }
    let rate = 0;
    if (aff) {
      const s = await c.query("SELECT value FROM settings WHERE key='defaultCommission'");
      rate = aff.commission !== null ? Number(aff.commission) : Number(s.rows[0] ? s.rows[0].value : 10);
    }
    const commissionCents = aff ? Math.round(valueCents * rate / 100) : 0;
    const id = 'O' + randomHex(6).toUpperCase();
    const now = Date.now();
    await c.query(
      `INSERT INTO orders(id,customer,value_cents,affiliate_code,reference,status,commission_rate,commission_cents,commission_status,created_at,paid_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, customer, valueCents, aff ? aff.code : null, reference, status, rate, commissionCents,
        commissionStateFor(!!aff, status, 'none'), now, status === 'paid' ? now : null]
    );
    if (leadId) await c.query("UPDATE leads SET status='converted' WHERE id=$1", [leadId]);
    const r = await c.query('SELECT * FROM orders WHERE id=$1', [id]);
    return { order: orderView(r.rows[0]) };
  });
}

async function setOrderStatus(id, statusRaw) {
  const status = String(statusRaw || '');
  if (!ORDER_STATUSES.includes(status)) throw new HttpError(400, 'Status inválido.');
  return db.tx(async c => {
    const cur = await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]);
    const o = cur.rows[0];
    if (!o) throw new HttpError(404, 'Venda não encontrada.');
    if (o.status === status) return { order: orderView(o) };
    if (!TRANSITIONS[o.status].includes(status)) throw new HttpError(400, 'Essa mudança de status não é permitida.');
    const now = Date.now();
    const cs = commissionStateFor(!!o.affiliate_code, status, o.commission_status);
    await c.query(
      `UPDATE orders SET status=$2, commission_status=$3,
         paid_at = CASE WHEN $2='paid' THEN $4::bigint ELSE paid_at END,
         cancelled_at = CASE WHEN $2 IN ('cancelled','refunded') THEN $4::bigint ELSE cancelled_at END
       WHERE id=$1`,
      [id, status, cs, now]
    );
    const r = await c.query('SELECT * FROM orders WHERE id=$1', [id]);
    return { order: orderView(r.rows[0]) };
  });
}

async function payCommission(id) {
  return db.tx(async c => {
    const cur = await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]);
    const o = cur.rows[0];
    if (!o) throw new HttpError(404, 'Venda não encontrada.');
    if (o.commission_status === 'paid') return { order: orderView(o) };
    if (o.status !== 'paid' || o.commission_status !== 'approved') {
      throw new HttpError(400, 'A comissão só pode ser paga em uma venda paga com comissão aprovada.');
    }
    await c.query("UPDATE orders SET commission_status='paid', commission_paid_at=$2 WHERE id=$1", [id, Date.now()]);
    const r = await c.query('SELECT * FROM orders WHERE id=$1', [id]);
    return { order: orderView(r.rows[0]) };
  });
}

/* ---------- Afiliado: painel próprio ---------- */
async function affiliateDashboard(codeRaw, token) {
  const code = normalizeCode(codeRaw);
  if (!code || !token) throw new HttpError(400, 'Informe o código e o token.');
  const { rows } = await db.query('SELECT * FROM affiliates WHERE code=$1', [code]);
  const a = rows[0];
  const given = sha256(token);
  // Resposta idêntica para código inexistente, token errado ou conta inativa.
  if (!a || a.status !== 'active' || !safeEqual(given, a.token_hash)) throw new HttpError(401, 'Código ou token inválido.');
  const [orders, settings, leadCount] = await Promise.all([
    db.query('SELECT * FROM orders WHERE affiliate_code=$1 ORDER BY created_at DESC LIMIT 100', [code]),
    db.getSettings(),
    db.query('SELECT COUNT(*)::int AS n FROM leads WHERE affiliate_code=$1', [code])
  ]);
  const stats = { salesCents: 0, pendingCents: 0, approvedCents: 0, paidCents: 0, clawbackCents: 0, orders: 0, leads: leadCount.rows[0].n };
  const items = orders.rows.map(orderView);
  for (const o of items) {
    stats.orders++;
    if (o.status === 'paid') stats.salesCents += o.valueCents;
    if (o.commissionStatus === 'pending') stats.pendingCents += o.commissionCents;
    if (o.commissionStatus === 'approved') stats.approvedCents += o.commissionCents;
    if (o.commissionStatus === 'paid') stats.paidCents += o.commissionCents;
    if (o.commissionStatus === 'clawback') stats.clawbackCents += o.commissionCents;
  }
  const rate = a.commission !== null ? Number(a.commission) : settings.affiliate.defaultCommission;
  return {
    affiliate: { name: a.name, code: a.code, commission: rate, pix: a.pix },
    minPayoutCents: Math.round(settings.affiliate.minPayout * 100),
    stats,
    orders: items.map(o => ({
      id: o.id, valueCents: o.valueCents, status: o.status, commissionCents: o.commissionCents,
      commissionStatus: o.commissionStatus, createdAt: o.createdAt
    }))
  };
}

module.exports = {
  publicStore, resolveAffiliate, recordLead, getPhoto, adminData, saveSettings, saveAffiliateSettings,
  saveProduct, deleteProduct, createAffiliate, updateAffiliate, regenerateToken, createOrder, setOrderStatus,
  payCommission, affiliateDashboard, commissionStateFor, TRANSITIONS
};

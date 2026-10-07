'use strict';
(function () {
  const { $, el, money, validPhone, maskPhone, toast, api, openDialog, initDialogs, waIcon } = Aurea;

  const ATTR_KEY = 'aurea.attribution.v2';
  const FALLBACK_PHOTO = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500"><rect width="400" height="500" fill="#f4eee5"/><path d="M200 190l30 50-30 90-30-90z" fill="none" stroke="#c9a15c" stroke-width="6" stroke-linejoin="round"/></svg>');

  const store = { name: 'Andreia semijoias', whatsapp: '', instagram: '', attributionDays: 30, affiliateEnabled: true, products: [] };
  let sortMode = 'default';
  let memAttr = null; // plano B quando localStorage não está disponível

  /* ---------- Atribuição de afiliado (último clique) ---------- */
  function readAttr() {
    let a = memAttr;
    try { const raw = localStorage.getItem(ATTR_KEY); if (raw) a = JSON.parse(raw); } catch (_) { /* usa memória */ }
    if (!a || typeof a.code !== 'string' || !(a.expiresAt > Date.now())) return null;
    return a;
  }
  function writeAttr(a) {
    memAttr = a;
    try { localStorage.setItem(ATTR_KEY, JSON.stringify(a)); } catch (_) { /* usa memória */ }
  }
  function clearAttr() { memAttr = null; try { localStorage.removeItem(ATTR_KEY); } catch (_) { /* ok */ } }

  function renderBanner() {
    const a = readAttr();
    const box = $('affiliateBanner');
    if (!a) { box.hidden = true; return; }
    const t = $('affiliateBannerText');
    t.replaceChildren(document.createTextNode('Indicação registrada'));
    if (a.name) { t.append(document.createTextNode(' por '), el('strong', '', a.name)); }
    box.hidden = false;
  }

  async function captureAffiliate() {
    const params = new URLSearchParams(location.search);
    const raw = params.get('af') || params.get('ref');
    if (!raw) return;
    // Remove o parâmetro da barra de endereço (o link continua válido para quem o recebeu).
    try {
      params.delete('af'); params.delete('ref');
      const qs = params.toString();
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
    } catch (_) { /* ok */ }
    try {
      const data = await api('GET', '/api/affiliate/resolve?code=' + encodeURIComponent(raw));
      if (data && data.affiliate) {
        writeAttr({ code: data.affiliate.code, name: data.affiliate.name, expiresAt: Date.now() + (store.attributionDays || 30) * 86400000 });
      } else {
        toast('Esse link de indicação não está mais ativo.', true);
      }
    } catch (_) { /* sem rede: mantém a atribuição anterior, se houver */ }
    renderBanner();
  }

  /* ---------- WhatsApp ---------- */
  function newLeadId() {
    const bytes = new Uint8Array(8);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    return 'L' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  function waUrl(product, leadId) {
    const a = readAttr();
    let msg = product
      ? `Olá! Tenho interesse na joia *${product.name}* no valor de *${money(product.priceCents)}*. Ainda está disponível?`
      : `Olá! Gostaria de conhecer as joias da ${store.name}.`;
    if (a) msg += `\n\nIndicação: ${a.code}${leadId ? ' | Ref.: ' + leadId : ''}`;
    return `https://wa.me/${store.whatsapp}?text=${encodeURIComponent(msg)}`;
  }

  /** Link real (<a>): abre o WhatsApp sem depender de JS assíncrono, então nunca é barrado por bloqueador de pop-up. */
  function buyLink(product) {
    const a = el('a', 'btn wa');
    a.append(waIcon(), document.createTextNode('Comprar pelo WhatsApp'));
    if (!validPhone(store.whatsapp)) {
      a.href = '#contato';
      a.addEventListener('click', e => { e.preventDefault(); toast('O WhatsApp da loja ainda não foi configurado.', true); });
      return a;
    }
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.href = waUrl(product, '');
    a.addEventListener('click', () => {
      const attr = readAttr();
      const leadId = attr ? newLeadId() : '';
      a.href = waUrl(product, leadId); // atualizado antes de a navegação acontecer
      if (attr) {
        api('POST', '/api/leads', { affiliateCode: attr.code, productId: product.id, leadId }, { keepalive: true, timeout: 8000 }).catch(() => {});
      }
    });
    return a;
  }

  /* ---------- Renderização ---------- */
  function sorted() {
    const list = store.products.slice();
    if (sortMode === 'asc') list.sort((x, y) => x.priceCents - y.priceCents);
    if (sortMode === 'desc') list.sort((x, y) => y.priceCents - x.priceCents);
    return list;
  }

  function photoEl(p, lazy) {
    const img = el('img');
    img.src = p.photo; img.alt = p.name; img.decoding = 'async';
    if (lazy) img.loading = 'lazy';
    img.addEventListener('error', () => { img.src = FALLBACK_PHOTO; }, { once: true });
    return img;
  }

  function openProduct(p) {
    $('pdImg').src = p.photo; $('pdImg').alt = p.name;
    $('pdImg').onerror = () => { $('pdImg').src = FALLBACK_PHOTO; };
    $('pdName').textContent = p.name;
    $('pdPrice').textContent = money(p.priceCents);
    $('pdBuy').replaceChildren(buyLink(p));
    openDialog('productDialog');
  }

  function renderProducts() {
    const grid = $('products');
    grid.replaceChildren();
    grid.setAttribute('aria-busy', 'false');
    const list = sorted();
    $('count').textContent = list.length === 1 ? '1 peça para descobrir' : `${list.length} peças para descobrir`;
    if (!list.length) {
      grid.append(el('p', 'state-box', 'Novas peças chegarão em breve.'));
      return;
    }
    list.forEach((p, i) => {
      const card = el('article', 'card');
      card.style.animationDelay = Math.min(i, 8) * 70 + 'ms';
      const open = el('button', 'photo'); open.type = 'button';
      open.setAttribute('aria-label', 'Ver detalhes de ' + p.name);
      open.append(photoEl(p, i > 2), el('span', 'tag', 'Seleção especial'), el('span', 'view', 'Ver detalhes'));
      open.addEventListener('click', () => openProduct(p));
      const body = el('div', 'card-body');
      body.append(el('h3', '', p.name), el('p', 'price', money(p.priceCents)), buyLink(p));
      card.append(open, body);
      grid.append(card);
    });
  }

  function renderSkeleton() {
    const grid = $('products');
    grid.replaceChildren();
    for (let i = 0; i < 6; i++) {
      const c = el('div', 'card skeleton'); c.style.animation = 'none'; c.style.opacity = '1'; c.style.transform = 'none';
      c.append(el('div', 'photo'), el('div', 'line'), el('div', 'line'));
      grid.append(c);
    }
  }

  function renderChrome() {
    document.title = store.name + ' · Semijoias com essência';
    document.querySelectorAll('[data-store]').forEach(e => { e.textContent = store.name; });
    $('year').textContent = new Date().getFullYear();

    const contact = $('contact'); contact.replaceChildren();
    const fab = $('fab'); fab.replaceChildren(waIcon());
    const hw = $('headerWa');
    if (validPhone(store.whatsapp)) {
      const link = el('a', '', maskPhone(store.whatsapp));
      link.href = waUrl(); link.target = '_blank'; link.rel = 'noopener noreferrer';
      contact.append(link);
      fab.href = waUrl(); hw.href = waUrl(); hw.target = '_blank'; hw.rel = 'noopener noreferrer';
    } else {
      contact.textContent = 'WhatsApp em breve';
      fab.hidden = true; hw.hidden = true;
    }

    const social = $('social'); social.replaceChildren();
    if (/^[A-Za-z0-9._]{1,30}$/.test(store.instagram || '')) {
      const link = el('a', '', 'Instagram ↗');
      link.href = 'https://www.instagram.com/' + encodeURIComponent(store.instagram) + '/';
      link.target = '_blank'; link.rel = 'noopener noreferrer';
      social.append(link);
    } else social.textContent = 'Novidades em breve';
  }

  function renderError(onRetry) {
    const grid = $('products');
    grid.replaceChildren(); grid.setAttribute('aria-busy', 'false');
    const box = el('div', 'state-box');
    box.append(el('p', '', 'Não conseguimos carregar a coleção agora.'));
    const b = el('button', 'btn small', 'Tentar novamente'); b.type = 'button'; b.onclick = onRetry;
    box.append(b); grid.append(box);
    $('count').textContent = '';
  }

  function applyData(d) {
    store.name = d.name || store.name;
    store.whatsapp = d.whatsapp || '';
    store.instagram = d.instagram || '';
    if (d.affiliate) { store.attributionDays = d.affiliate.attributionDays || 30; store.affiliateEnabled = d.affiliate.enabled !== false; }
    store.products = (Array.isArray(d.products) ? d.products : [])
      .filter(p => p && typeof p.name === 'string' && Number.isFinite(Number(p.priceCents)) && p.priceCents > 0 && typeof p.photo === 'string')
      .map(p => ({ id: String(p.id), name: p.name, priceCents: Math.round(Number(p.priceCents)), photo: p.photo }));
  }

  /** Catálogo estático de reserva: a vitrine continua aparecendo mesmo se o servidor estiver fora do ar. */
  async function loadFallback() {
    const res = await fetch('/catalog.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('fallback');
    const c = await res.json();
    applyData({
      name: c.name, whatsapp: c.whatsapp, instagram: c.instagram,
      products: (c.products || []).map(p => ({ id: p.id, name: p.name, priceCents: Math.round(Number(p.price) * 100), photo: p.photo }))
    });
  }

  async function load() {
    renderSkeleton();
    let live = true;
    try {
      applyData(await api('GET', '/api/store'));
    } catch (_) {
      live = false;
      try { await loadFallback(); } catch (__) { renderChrome(); renderError(load); return; }
    }
    renderChrome();
    renderProducts();
    renderBanner();
    if (live) await captureAffiliate();
    renderChrome(); // reaplica links do WhatsApp com a indicação, se houver
    renderProducts();
  }

  /* ---------- Inicialização ---------- */
  initDialogs();
  $('sort').addEventListener('change', e => { sortMode = e.target.value; renderProducts(); });
  const header = $('siteHeader');
  const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true }); onScroll();
  load();
})();

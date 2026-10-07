'use strict';
(function () {
  const { $, el, money, toast, api, copyText, busy, ORDER_LABEL, COMM_LABEL } = Aurea;
  let creds = null; // somente em memória

  function show(app) { $('loginView').hidden = app; $('appView').hidden = !app; }

  function render(d) {
    $('affName').textContent = d.affiliate.name;
    $('affMeta').textContent = `Código ${d.affiliate.code} · Comissão de ${d.affiliate.commission}% · ${d.stats.leads} cliques no WhatsApp`;
    $('affLink').value = location.origin + '/?af=' + encodeURIComponent(d.affiliate.code);
    $('stSales').textContent = money(d.stats.salesCents);
    $('stPending').textContent = money(d.stats.pendingCents);
    $('stApproved').textContent = money(d.stats.approvedCents);
    $('stPaid').textContent = money(d.stats.paidCents);
    const box = $('orders'); box.replaceChildren();
    if (!d.orders.length) { box.append(el('p', 'empty', 'Nenhuma venda registrada ainda. Divulgue seu link!')); return; }
    const t = el('table'); const hr = el('tr');
    ['Venda', 'Data', 'Valor', 'Situação', 'Comissão'].forEach(h => hr.append(el('th', '', h)));
    const head = el('thead'); head.append(hr); t.append(head);
    const body = el('tbody');
    for (const o of d.orders) {
      const tr = el('tr');
      const st = el('span', 'badge ' + (o.status === 'paid' ? 'ok' : o.status === 'pending' ? 'warn' : 'bad'), ORDER_LABEL[o.status] || o.status);
      const c5 = el('td'); c5.append(el('strong', '', money(o.commissionCents)), el('div', 'sub muted', COMM_LABEL[o.commissionStatus] || ''));
      const c4 = el('td'); c4.append(st);
      tr.append(el('td', '', o.id), el('td', '', new Date(o.createdAt).toLocaleDateString('pt-BR')), el('td', '', money(o.valueCents)), c4, c5);
      body.append(tr);
    }
    t.append(body); box.append(t);
  }

  async function login(code, token) {
    const d = await api('POST', '/api/affiliate/login', { code, token });
    creds = { code, token };
    render(d); show(true);
  }

  $('loginForm').addEventListener('submit', e => {
    e.preventDefault();
    busy(e.submitter || e.target.querySelector('button[type=submit]'), async () => {
      $('loginError').textContent = '';
      try { await login($('code').value.trim(), $('token').value.trim()); $('loginForm').reset(); }
      catch (err) { $('loginError').textContent = err.message; }
    });
  });
  $('refresh').addEventListener('click', e => busy(e.currentTarget, async () => {
    if (!creds) return;
    try { render(await api('POST', '/api/affiliate/login', creds)); toast('Dados atualizados.'); }
    catch (err) { toast(err.message, true); if (err.status === 401) { creds = null; show(false); } }
  }));
  $('logout').addEventListener('click', () => { creds = null; show(false); $('loginForm').reset(); });
  $('copyLink').addEventListener('click', () => copyText($('affLink').value));

  // Link privado do painel: #code=...&token=... (o fragmento nunca é enviado ao servidor e é apagado da URL).
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (h.get('code') && h.get('token')) {
    const code = h.get('code'), token = h.get('token');
    try { history.replaceState(null, '', location.pathname); } catch (_) { /* ok */ }
    login(code, token).catch(err => { $('code').value = code; $('loginError').textContent = err.message; });
  }
})();

'use strict';
(function () {
  const { $, el, money, parseCents, centsToInput, digits, validPhone, maskPhone, toast, api, openDialog, closeDialog, initDialogs, confirmBox, copyText, busy, ORDER_LABEL, COMM_LABEL } = Aurea;

  let data = null;           // último retrato do servidor
  let editingProductId = null;
  let pendingPhoto = '';     // data URL já otimizada
  let photoToken = 0;
  let activeTab = 'overview';
  let prefillLead = null;

  /* ---------- Sessão ---------- */
  function showLogin() { $('appView').hidden = true; $('loginView').hidden = false; $('username').focus(); }
  function showApp() { $('loginView').hidden = true; $('appView').hidden = false; }

  function handleAuthError(e) {
    if (e && e.status === 401) { data = null; showLogin(); toast('Sessão expirada. Entre novamente.', true); return true; }
    return false;
  }
  function fail(e) { if (!handleAuthError(e)) toast(e.message || 'Algo deu errado.', true); }

  async function refresh() {
    data = await api('GET', '/api/admin/data');
    renderAll();
  }

  async function boot() {
    try {
      const s = await api('GET', '/api/admin/session');
      if (!s.configured) {
        showLogin();
        $('loginError').textContent = 'O acesso do administrador ainda não foi configurado no servidor (variável ADMIN_PASSWORD).';
        return;
      }
      if (!s.authenticated) { showLogin(); return; }
      await refresh();
      showApp();
    } catch (e) {
      showLogin();
      $('loginError').textContent = e.message;
    }
  }

  $('loginForm').addEventListener('submit', e => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector('button[type=submit]');
    busy(btn, async () => {
      $('loginError').textContent = '';
      try {
        await api('POST', '/api/admin/login', { username: $('username').value.trim(), password: $('password').value });
        $('loginForm').reset();
        await refresh();
        showApp();
      } catch (err) { $('loginError').textContent = err.message; }
    });
  });

  $('logout').addEventListener('click', async () => {
    try { await api('POST', '/api/admin/logout'); } catch (_) { /* limpa mesmo assim */ }
    data = null; showLogin(); toast('Você saiu do painel.');
  });

  /* ---------- Abas ---------- */
  function selectTab(name, focus) {
    activeTab = name;
    document.querySelectorAll('.tab').forEach(t => {
      const on = t.dataset.tab === name;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    });
    document.querySelectorAll('.pane').forEach(p => { p.hidden = p.id !== 'pane-' + name; });
  }
  document.querySelectorAll('.tab').forEach((t, i, all) => {
    t.addEventListener('click', () => selectTab(t.dataset.tab));
    t.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
      selectTab(next.dataset.tab, true);
    });
  });

  /* ---------- Renderização ---------- */
  function renderAll() {
    $('topName').textContent = data.settings.name;
    $('pillProducts').textContent = data.products.length;
    $('pillAff').textContent = data.affiliates.filter(a => a.status === 'active').length;
    renderOverview(); renderOrders(); renderProducts(); renderAffiliates(); renderSettings();
    selectTab(activeTab);
  }

  function badge(text, kind) { return el('span', 'badge ' + (kind || ''), text); }
  const orderKind = s => (s === 'paid' ? 'ok' : s === 'pending' ? 'warn' : 'bad');
  const dateStr = ts => new Date(ts).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  function act(label, cls, fn) {
    const b = el('button', 'mini ' + (cls || ''), label); b.type = 'button';
    b.addEventListener('click', () => busy(b, fn));
    return b;
  }

  function renderOverview() {
    const paid = data.orders.filter(o => o.status === 'paid');
    $('stPaidCount').textContent = paid.length;
    $('stRevenue').textContent = money(paid.reduce((s, o) => s + o.valueCents, 0));
    $('stCommDue').textContent = money(data.orders.filter(o => o.commissionStatus === 'approved').reduce((s, o) => s + o.commissionCents, 0));
    $('stCommPaid').textContent = money(data.orders.filter(o => o.commissionStatus === 'paid').reduce((s, o) => s + o.commissionCents, 0));
    const box = $('leadList'); box.replaceChildren();
    const open = data.leads.filter(l => l.status === 'open').slice(0, 30);
    if (!open.length) { box.append(el('p', 'empty', 'Nenhum interessado indicado por afiliado no momento.')); return; }
    for (const l of open) {
      const row = el('div', 'row');
      const info = el('div', 'info');
      info.append(el('strong', '', l.productName || 'Joia'), el('div', 'muted', `Afiliado ${l.affiliateCode} · ${dateStr(l.createdAt)} · ${money(l.valueCents)}`));
      const b = el('button', 'mini', 'Registrar venda'); b.type = 'button';
      b.addEventListener('click', () => openOrderDialog(l));
      row.append(info, b); box.append(row);
    }
  }

  function renderOrders() {
    const box = $('orderList'); box.replaceChildren();
    const f = $('orderFilter').value;
    const list = data.orders.filter(o => f === 'all' || o.status === f);
    if (!list.length) { box.append(el('p', 'empty', 'Nenhuma venda por aqui ainda.')); return; }
    for (const o of list) {
      const row = el('div', 'order');
      const c1 = el('div'); c1.append(el('strong', '', o.customer), el('div', 'sub', (o.affiliateCode ? 'Afiliado: ' + o.affiliateCode : 'Sem afiliado') + ' · ' + dateStr(o.createdAt)));
      if (o.reference) c1.append(el('div', 'sub', o.reference));
      const c2 = el('div'); c2.append(el('strong', '', money(o.valueCents)), el('div', 'sub', o.affiliateCode ? `Comissão ${money(o.commissionCents)} (${o.commissionRate}%)` : '—'));
      const c3 = el('div'); c3.append(badge(ORDER_LABEL[o.status], orderKind(o.status)));
      const c4 = el('div', 'sub', o.affiliateCode ? COMM_LABEL[o.commissionStatus] : '');
      const acts = el('div', 'acts');
      if (o.status === 'pending') {
        acts.append(act('Marcar paga', '', () => orderCall(o.id, 'status', 'paid', 'Venda marcada como paga.')));
        acts.append(act('Cancelar', 'danger', async () => { if (await confirmBox('Cancelar esta venda? A comissão será revertida.', 'Cancelar venda')) await orderCall(o.id, 'status', 'cancelled', 'Venda cancelada.'); }));
      }
      if (o.status === 'paid') {
        if (o.commissionStatus === 'approved') acts.append(act('Pagar comissão', '', async () => { if (await confirmBox(`Confirmar que você pagou ${money(o.commissionCents)} ao afiliado ${o.affiliateCode}?`, 'Confirmar pagamento')) await orderCall(o.id, 'commission', null, 'Comissão marcada como paga.'); }));
        acts.append(act('Reembolsar', 'danger', async () => { if (await confirmBox('Registrar reembolso desta venda? A comissão será revertida.', 'Reembolsar')) await orderCall(o.id, 'status', 'refunded', 'Venda reembolsada.'); }));
      }
      row.append(c1, c2, c3, c4, acts); box.append(row);
    }
  }
  $('orderFilter').addEventListener('change', () => data && renderOrders());

  async function orderCall(id, kind, status, okMsg) {
    try {
      await api('PATCH', `/api/admin/orders/${encodeURIComponent(id)}/${kind}`, status ? { status } : {});
      await refresh(); toast(okMsg);
    } catch (e) { fail(e); try { await refresh(); } catch (_) { /* ok */ } }
  }

  function renderProducts() {
    const box = $('productList'); box.replaceChildren();
    if (!data.products.length) { box.append(el('p', 'empty', 'Nenhuma joia cadastrada. Clique em “Adicionar joia”.')); return; }
    for (const p of data.products) {
      const row = el('div', 'row');
      const img = el('img'); img.src = p.photo; img.alt = ''; img.loading = 'lazy';
      const info = el('div', 'info'); info.append(el('strong', '', p.name), el('div', 'muted', money(p.priceCents)));
      const acts = el('div', 'acts');
      const edit = el('button', 'mini', 'Editar'); edit.type = 'button'; edit.addEventListener('click', () => openProductDialog(p));
      const del = act('Excluir', 'danger', async () => {
        if (!(await confirmBox(`Excluir “${p.name}”? Esta ação não pode ser desfeita.`, 'Excluir'))) return;
        try { await api('DELETE', '/api/admin/products/' + encodeURIComponent(p.id)); await refresh(); toast('Joia excluída.'); } catch (e) { fail(e); }
      });
      acts.append(edit, del); row.append(img, info, acts); box.append(row);
    }
  }

  function affiliateLink(a) { return location.origin + '/?af=' + encodeURIComponent(a.code); }
  function panelLink(code, token) { return location.origin + '/afiliado#code=' + encodeURIComponent(code) + '&token=' + encodeURIComponent(token); }

  function renderAffiliates() {
    const box = $('affiliateList'); box.replaceChildren();
    if (!data.affiliates.length) { box.append(el('p', 'empty', 'Nenhum afiliado cadastrado ainda.')); return; }
    const t = el('table');
    const head = el('thead'); const hr = el('tr');
    ['Afiliado', 'Comissão (%)', 'Situação', 'Link de divulgação', 'Ações'].forEach(h => hr.append(el('th', '', h)));
    head.append(hr); t.append(head);
    const body = el('tbody');
    for (const a of data.affiliates) {
      const tr = el('tr');
      const td1 = el('td'); td1.append(el('strong', '', a.name), el('div', 'sub muted', a.code + (a.email ? ' · ' + a.email : '')));
      const td2 = el('td'); const wrap = el('div', 'inline');
      const ci = el('input'); ci.type = 'number'; ci.min = '0'; ci.max = '100'; ci.step = '0.01';
      ci.value = a.commission === null ? '' : a.commission; ci.placeholder = 'Padrão ' + data.settings.affiliate.defaultCommission;
      ci.setAttribute('aria-label', 'Comissão de ' + a.name);
      const save = act('Salvar', '', async () => {
        const v = ci.value.trim();
        if (v !== '' && (!Number.isFinite(Number(v)) || Number(v) < 0 || Number(v) > 100)) { toast('A comissão deve ficar entre 0 e 100.', true); return; }
        try { await api('PATCH', '/api/admin/affiliates/' + encodeURIComponent(a.id), { commission: v === '' ? null : Number(v) }); await refresh(); toast('Comissão atualizada.'); } catch (e) { fail(e); }
      });
      wrap.append(ci, save); td2.append(wrap);
      const td3 = el('td'); td3.append(badge(a.status === 'active' ? 'Ativo' : a.status === 'pending' ? 'Pendente' : 'Bloqueado', a.status === 'active' ? 'ok' : a.status === 'pending' ? 'warn' : 'bad'));
      const td4 = el('td'); const w4 = el('div', 'inline');
      const li = el('input', 'link-in'); li.value = affiliateLink(a); li.readOnly = true; li.setAttribute('aria-label', 'Link de ' + a.name);
      const cp = el('button', 'mini', 'Copiar'); cp.type = 'button'; cp.addEventListener('click', () => copyText(li.value));
      w4.append(li, cp); td4.append(w4);
      const td5 = el('td'); const acts = el('div', 'acts inline');
      acts.append(act(a.status === 'active' ? 'Bloquear' : 'Ativar', '', async () => {
        try { await api('PATCH', '/api/admin/affiliates/' + encodeURIComponent(a.id), { status: a.status === 'active' ? 'blocked' : 'active' }); await refresh(); toast('Situação atualizada.'); } catch (e) { fail(e); }
      }));
      acts.append(act('Novo token', '', async () => {
        if (!(await confirmBox(`Gerar novo token para ${a.name}? O token atual deixará de funcionar.`, 'Gerar novo'))) return;
        try { const r = await api('POST', `/api/admin/affiliates/${encodeURIComponent(a.id)}/regenerate-token`, {}); showSecret(a.code, r.accessToken); } catch (e) { fail(e); }
      }));
      td5.append(acts);
      tr.append(td1, td2, td3, td4, td5); body.append(tr);
    }
    t.append(body); box.append(t);
  }

  function showSecret(code, token) {
    const pub = location.origin + '/?af=' + encodeURIComponent(code);
    const pan = panelLink(code, token);
    $('secretPublic').textContent = pub; $('secretPanel').textContent = pan; $('secretCode').textContent = code;
    $('copyPublic').onclick = () => copyText(pub);
    $('copyPanel').onclick = () => copyText(pan);
    openDialog('secretDialog');
  }

  function renderSettings() {
    const s = data.settings;
    $('storeName').value = s.name; $('whatsapp').value = maskPhone(s.whatsapp); $('instagram').value = s.instagram;
    $('defaultCommission').value = s.affiliate.defaultCommission; $('attributionDays').value = s.affiliate.attributionDays;
    $('minPayout').value = s.affiliate.minPayout; $('programStatus').value = s.affiliate.enabled ? 'active' : 'paused';
  }

  /* ---------- Configurações ---------- */
  $('whatsapp').addEventListener('input', () => { $('whatsapp').setCustomValidity(''); $('whatsapp').value = maskPhone($('whatsapp').value); });
  $('settingsForm').addEventListener('submit', e => {
    e.preventDefault();
    busy(e.submitter || e.target.querySelector('button[type=submit]'), async () => {
      const name = $('storeName').value.trim();
      if (!name) { toast('Informe o nome da loja.', true); return; }
      if (!validPhone($('whatsapp').value)) { toast('WhatsApp inválido. Informe DDI, DDD e número.', true); $('whatsapp').focus(); return; }
      const ig = $('instagram').value.trim().replace(/^@/, '');
      if (ig && !/^[A-Za-z0-9._]{1,30}$/.test(ig)) { toast('Instagram inválido. Use só letras, números, ponto e sublinhado.', true); return; }
      try { await api('PUT', '/api/admin/settings', { name, whatsapp: digits($('whatsapp').value), instagram: ig }); await refresh(); toast('Dados da loja salvos.'); } catch (err) { fail(err); }
    });
  });
  $('affSettingsForm').addEventListener('submit', e => {
    e.preventDefault();
    busy(e.submitter || e.target.querySelector('button[type=submit]'), async () => {
      const body = {
        defaultCommission: Number($('defaultCommission').value), attributionDays: Number($('attributionDays').value),
        minPayout: Number($('minPayout').value), enabled: $('programStatus').value === 'active'
      };
      if (!Number.isFinite(body.defaultCommission) || body.defaultCommission < 0 || body.defaultCommission > 100) { toast('Comissão padrão deve ficar entre 0 e 100.', true); return; }
      if (!Number.isInteger(body.attributionDays) || body.attributionDays < 1 || body.attributionDays > 365) { toast('Validade deve ser de 1 a 365 dias.', true); return; }
      if (!Number.isFinite(body.minPayout) || body.minPayout < 0) { toast('Valor mínimo inválido.', true); return; }
      try { await api('PUT', '/api/admin/settings/affiliate', body); await refresh(); toast('Regras salvas.'); } catch (err) { fail(err); }
    });
  });

  /* ---------- Joias ---------- */
  function resetProductForm() {
    photoToken++; editingProductId = null; pendingPhoto = '';
    $('productForm').reset(); $('productError').textContent = '';
    $('preview').hidden = true; $('preview').removeAttribute('src'); $('saveProduct').disabled = false;
  }
  function openProductDialog(p) {
    resetProductForm();
    if (p) {
      editingProductId = p.id; $('productName').value = p.name; $('productPrice').value = centsToInput(p.priceCents);
      $('preview').src = p.photo; $('preview').hidden = false;
      $('productDialogTitle').textContent = 'Editar joia'; $('photoHelp').textContent = 'Deixe vazio para manter a foto atual.';
    } else {
      $('productDialogTitle').textContent = 'Adicionar joia'; $('photoHelp').textContent = 'JPG, PNG ou WebP, até 10 MB. A imagem é otimizada automaticamente.';
    }
    openDialog('productDialog'); $('productName').focus();
  }
  $('newProduct').addEventListener('click', () => openProductDialog(null));
  $('productDialog').addEventListener('close', resetProductForm);

  $('productPhoto').addEventListener('change', async () => {
    const file = $('productPhoto').files[0]; const token = ++photoToken;
    $('productError').textContent = '';
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
      $('productError').textContent = 'Escolha uma imagem JPG, PNG ou WebP de até 10 MB.'; $('productPhoto').value = ''; return;
    }
    $('saveProduct').disabled = true;
    let url;
    try {
      url = URL.createObjectURL(file);
      const img = new Image(); img.src = url; await img.decode();
      if (token !== photoToken) return;
      const scale = Math.min(1, 1000 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * scale)); c.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fbf8f3'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
      const out = c.toDataURL('image/jpeg', 0.82);
      if (!out.startsWith('data:image/jpeg')) throw new Error('canvas');
      pendingPhoto = out; $('preview').src = out; $('preview').hidden = false;
    } catch (_) {
      $('productError').textContent = 'Não foi possível ler essa imagem. Escolha outro arquivo.'; $('productPhoto').value = ''; pendingPhoto = '';
    } finally {
      if (url) URL.revokeObjectURL(url);
      if (token === photoToken) $('saveProduct').disabled = false;
    }
  });

  $('productForm').addEventListener('submit', e => {
    e.preventDefault();
    busy($('saveProduct'), async () => {
      const name = $('productName').value.trim(); const priceCents = parseCents($('productPrice').value);
      if (!name) { $('productError').textContent = 'Informe o nome da joia.'; return; }
      if (!Number.isInteger(priceCents) || priceCents <= 0 || priceCents > 99999999) { $('productError').textContent = 'Informe um preço válido, como 129,90.'; return; }
      if (!editingProductId && !pendingPhoto) { $('productError').textContent = 'Selecione uma foto da joia.'; return; }
      const body = { name, priceCents };
      if (editingProductId) body.id = editingProductId;
      if (pendingPhoto) body.photo = pendingPhoto;
      try {
        await api('POST', '/api/admin/products', body, { timeout: 40000 });
        closeDialog('productDialog'); await refresh(); toast('Joia salva. Ela aparece na loja em instantes.');
      } catch (err) { if (!handleAuthError(err)) $('productError').textContent = err.message; }
    });
  });

  /* ---------- Afiliados ---------- */
  $('newAffiliate').addEventListener('click', () => { $('affiliateForm').reset(); $('affError').textContent = ''; openDialog('affiliateDialog'); $('affName').focus(); });
  $('affiliateForm').addEventListener('submit', e => {
    e.preventDefault();
    busy(e.submitter || e.target.querySelector('button[type=submit]'), async () => {
      $('affError').textContent = '';
      const name = $('affName').value.trim();
      if (!name) { $('affError').textContent = 'Informe o nome do afiliado.'; return; }
      const phone = digits($('affPhone').value);
      if (phone && !validPhone(phone)) { $('affError').textContent = 'WhatsApp do afiliado inválido.'; return; }
      const cr = $('affCommission').value.trim();
      if (cr !== '' && (!Number.isFinite(Number(cr)) || Number(cr) < 0 || Number(cr) > 100)) { $('affError').textContent = 'A comissão deve ficar entre 0 e 100.'; return; }
      try {
        const r = await api('POST', '/api/admin/affiliates', { name, email: $('affEmail').value.trim(), phone, commission: cr === '' ? null : Number(cr), pix: $('affPix').value.trim(), status: 'active' });
        closeDialog('affiliateDialog'); await refresh(); showSecret(r.affiliate.code, r.accessToken);
      } catch (err) { if (!handleAuthError(err)) $('affError').textContent = err.message; }
    });
  });

  /* ---------- Vendas ---------- */
  function openOrderDialog(lead) {
    prefillLead = lead || null;
    $('orderForm').reset(); $('orderError').textContent = '';
    const sel = $('orderAffiliate'); sel.replaceChildren();
    const none = el('option', '', 'Sem afiliado'); none.value = ''; sel.append(none);
    for (const a of data.affiliates.filter(x => x.status === 'active')) { const o = el('option', '', `${a.name} (${a.code})`); o.value = a.code; sel.append(o); }
    if (lead) {
      sel.value = lead.affiliateCode; $('orderValue').value = centsToInput(lead.valueCents || 0).replace(/^0,00$/, '');
      $('orderReference').value = lead.productName || '';
    }
    openDialog('orderDialog'); $('orderCustomer').focus();
  }
  $('newOrder').addEventListener('click', () => openOrderDialog(null));
  $('orderForm').addEventListener('submit', e => {
    e.preventDefault();
    busy(e.submitter || e.target.querySelector('button[type=submit]'), async () => {
      $('orderError').textContent = '';
      const customer = $('orderCustomer').value.trim(); const valueCents = parseCents($('orderValue').value);
      if (!customer) { $('orderError').textContent = 'Informe o nome do cliente.'; return; }
      if (!Number.isInteger(valueCents) || valueCents <= 0 || valueCents > 99999999) { $('orderError').textContent = 'Informe um valor válido, como 129,90.'; return; }
      try {
        await api('POST', '/api/admin/orders', { customer, valueCents, affiliateCode: $('orderAffiliate').value, reference: $('orderReference').value.trim(), status: $('orderStatus').value, leadId: prefillLead ? prefillLead.id : '' });
        closeDialog('orderDialog'); prefillLead = null; await refresh(); toast('Venda registrada.'); selectTab('orders');
      } catch (err) { if (!handleAuthError(err)) $('orderError').textContent = err.message; }
    });
  });

  initDialogs();
  boot();
})();

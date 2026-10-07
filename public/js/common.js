'use strict';
/* Utilidades compartilhadas entre loja, painel do dono e painel do afiliado. */
(function () {
  const $ = id => document.getElementById(id);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const money = cents => brl.format((Number(cents) || 0) / 100);

  /** "1.234,56" | "129,90" | "129.90" -> centavos inteiros (ou NaN). */
  function parseCents(raw) {
    const s = String(raw == null ? '' : raw).trim();
    let n;
    if (/^\d+(?:\.\d{1,2})?$/.test(s)) n = Number(s);
    else if (/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(s)) n = Number(s.replace(/\./g, '').replace(',', '.'));
    else return NaN;
    return Math.round(n * 100);
  }
  const centsToInput = c => (c / 100).toFixed(2).replace('.', ',');

  const digits = v => String(v == null ? '' : v).replace(/\D/g, '');
  function validPhone(v) {
    v = digits(v);
    if (v.startsWith('55')) return /^55(?:1[1-9]|2[12478]|3[1-578]|4[1-9]|5[13-5]|6[1-9]|7[134579]|8[1-9]|9[1-9])(?:[2-5]\d{7}|9\d{8})$/.test(v);
    return /^[1-9]\d{9,14}$/.test(v);
  }
  function maskPhone(v) {
    const n = digits(v).slice(0, 15);
    if (!n) return '';
    if (!n.startsWith('55')) return '+' + n;
    let out = '+55';
    if (n.length > 2) out += ' (' + n.slice(2, 4) + (n.length >= 4 ? ')' : '');
    const rest = n.slice(4);
    const split = rest.length > 8 ? 5 : 4;
    if (rest) out += ' ' + rest.slice(0, split);
    if (rest.length > split) out += '-' + rest.slice(split);
    return out;
  }

  let toastTimer;
  function toast(message, isError) {
    let t = $('toast');
    if (!t) { t = el('div'); t.id = 'toast'; t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite'); document.body.append(t); }
    t.textContent = message;
    t.className = isError ? 'err' : '';
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 7000 : 4500);
  }

  class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }

  async function api(method, path, body, opts = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeout || 20000);
    try {
      const res = await fetch(path, {
        method,
        credentials: 'same-origin',
        keepalive: !!opts.keepalive,
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'aurea' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const raw = await res.text();
      let data = null;
      try { data = JSON.parse(raw); } catch (_) { /* resposta sem JSON */ }
      if (!res.ok) {
        const detail = data && data.error ? data.error : 'Não foi possível concluir. Tente novamente. [HTTP ' + res.status + ': ' + raw.replace(/\s+/g, ' ').slice(0, 90) + ']';
        throw new ApiError(detail, res.status);
      }
      if (data === null) throw new ApiError('Resposta inesperada do servidor. [HTTP ' + res.status + ': ' + raw.replace(/\s+/g, ' ').slice(0, 90) + ']', res.status);
      return data;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (e && e.name === 'AbortError') throw new ApiError('A conexão demorou demais. Tente novamente.', 0);
      throw new ApiError('Sem conexão com o servidor. Verifique sua internet.', 0);
    } finally {
      clearTimeout(timer);
    }
  }

  function openDialog(id) {
    const d = $(id);
    if (!d.open) d.showModal();
    document.body.classList.add('modal-open');
  }
  function closeDialog(id) { const d = $(id); if (d.open) d.close(); }

  function initDialogs() {
    document.querySelectorAll('dialog').forEach(d => {
      d.addEventListener('close', () => {
        if (!document.querySelector('dialog[open]')) document.body.classList.remove('modal-open');
      });
      d.addEventListener('click', e => { if (e.target === d && d.dataset.light !== 'no') d.close(); });
    });
    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeDialog(b.dataset.close)));
  }

  /** Confirmação própria (substitui window.confirm). Retorna Promise<boolean>. */
  function confirmBox(message, okLabel) {
    return new Promise(resolve => {
      const d = el('dialog');
      d.dataset.light = 'no';
      d.style.width = 'min(92vw,420px)';
      const p = el('p', '', message);
      p.style.margin = '6px 0 20px';
      const row = el('div'); row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap';
      const no = el('button', 'btn outline small', 'Voltar'); no.type = 'button';
      const ok = el('button', 'btn danger small', okLabel || 'Confirmar'); ok.type = 'button';
      row.append(no, ok); d.append(p, row); document.body.append(d);
      let result = false;
      no.onclick = () => d.close();
      ok.onclick = () => { result = true; d.close(); };
      d.addEventListener('close', () => { d.remove(); if (!document.querySelector('dialog[open]')) document.body.classList.remove('modal-open'); resolve(result); });
      d.showModal(); document.body.classList.add('modal-open'); no.focus();
    });
  }

  async function copyText(value) {
    try { await navigator.clipboard.writeText(value); toast('Copiado!'); return true; }
    catch (_) {
      const ta = el('textarea'); ta.value = value; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0;top:0';
      document.body.append(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (_) { /* sem suporte */ }
      ta.remove(); toast(ok ? 'Copiado!' : 'Não foi possível copiar. Selecione e copie manualmente.', !ok); return ok;
    }
  }

  /** Evita duplo clique/duplo envio: roda fn enquanto o botão fica desabilitado. */
  async function busy(btn, fn) {
    if (btn.disabled) return;
    btn.disabled = true;
    try { return await fn(); } finally { btn.disabled = false; }
  }

  const WA_PATH = 'M20.5 3.5A11.8 11.8 0 0 0 12 0 12 12 0 0 0 1.6 18L0 24l6.2-1.6A12 12 0 0 0 24 12c0-3.2-1.2-6.2-3.5-8.5ZM12 22a10 10 0 0 1-5.1-1.4l-.4-.2-3.7 1 1-3.6-.3-.4A10 10 0 1 1 12 22Zm5.5-7.5c-.3-.2-1.8-.9-2-.9-.3-.1-.5-.2-.7.2l-1 1.1c-.1.2-.3.2-.6.1a8.2 8.2 0 0 1-4-3.5c-.3-.5.3-.5.9-1.6.1-.2 0-.4 0-.6L9.2 7c-.2-.5-.5-.5-.7-.5h-.6c-.2 0-.5.1-.7.3-.7.7-1 1.5-1 2.4 0 1.4 1 2.7 1.1 2.9.1.2 2 3.1 5 4.4 1.9.8 2.7.9 3.7.7.6-.1 1.8-.7 2-1.4.2-.7.2-1.3.1-1.4-.1-.2-.3-.2-.6-.4Z';
  function waIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'icon'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(ns, 'path'); p.setAttribute('d', WA_PATH); svg.append(p);
    return svg;
  }

  const ORDER_LABEL = { pending: 'Pendente', paid: 'Pago', cancelled: 'Cancelado', refunded: 'Reembolsado' };
  const COMM_LABEL = { none: '—', pending: 'Comissão pendente', approved: 'Comissão aprovada', paid: 'Comissão paga', reversed: 'Comissão revertida', clawback: 'Comissão a devolver' };

  window.Aurea = { $, el, money, parseCents, centsToInput, digits, validPhone, maskPhone, toast, api, ApiError, openDialog, closeDialog, initDialogs, confirmBox, copyText, busy, waIcon, ORDER_LABEL, COMM_LABEL };
})();

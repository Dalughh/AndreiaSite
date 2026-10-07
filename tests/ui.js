'use strict';
const { chromium } = require('playwright');
const { start } = require('./dev-server');
const fs = require('fs');
(async () => {
  const server = await start(0); const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const errors = [];
  const log = (ctx) => { ctx.on('console', m => { if (m.type() === 'error' && !/fonts\.g|ERR_(NAME|INTERNET|CONNECTION|BLOCKED)|Failed to load resource/.test(m.text())) errors.push(m.text()); }); ctx.on('pageerror', e => errors.push('PAGEERROR ' + e.message)); };
  const ok = (c, m) => { if (!c) { console.log('FALHA:', m); process.exitCode = 1; } else console.log('ok -', m); };
  fs.mkdirSync('/home/claude/shots', { recursive: true });

  // ===== Loja (desktop) com link de afiliado =====
  // cria afiliado via API para testar atribuição
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const admin = await ctx.newPage(); log(admin);
  await admin.goto(base + '/admin');
  await admin.waitForSelector('#loginForm');
  await admin.fill('#username', 'dona'); await admin.fill('#password', 'errada'); await admin.click('#loginForm button');
  await admin.waitForFunction(() => document.getElementById('loginError').textContent.length > 0);
  ok((await admin.textContent('#loginError')).includes('incorretos'), 'login errado mostra erro');
  await admin.fill('#password', 'SenhaForte#2026'); await admin.click('#loginForm button');
  await admin.waitForSelector('#appView:not([hidden])');
  ok((await admin.textContent('#pillProducts')) === '6', 'admin lista 6 joias');

  // afiliado
  await admin.click('#tab-affiliates'); await admin.click('#newAffiliate');
  await admin.fill('#affName', 'Carla Souza'); await admin.fill('#affCommission', '12'); await admin.click('#affiliateForm button[type=submit]');
  await admin.waitForSelector('#secretDialog[open]');
  const panelLink = await admin.textContent('#secretPanel');
  ok(/\/afiliado#code=CARLASOUZA&token=AT-/.test(panelLink), 'link do painel do afiliado gerado');
  await admin.screenshot({ path: '/home/claude/shots/admin-secret.png' });
  await admin.click('#secretDialog .close');

  // nova joia com foto real
  await admin.click('#tab-products'); await admin.click('#newProduct');
  await admin.fill('#productName', 'Anel UI'); await admin.fill('#productPrice', '1.234,50');
  await admin.setInputFiles('#productPhoto', '/home/claude/aurea/public/img/p4.jpg');
  await admin.waitForSelector('#preview:not([hidden])');
  await admin.click('#saveProduct');
  await admin.waitForFunction(() => document.getElementById('pillProducts').textContent === '7');
  ok(true, 'joia criada pelo painel (foto otimizada no navegador)');
  await admin.screenshot({ path: '/home/claude/shots/admin-products.png' });

  // loja
  const shop = await ctx.newPage(); log(shop);
  await shop.goto(base + '/?af=carlasouza');
  await shop.waitForSelector('.card:not(.skeleton)');
  ok((await shop.locator('.card').count()) === 7, 'loja mostra 7 joias');
  ok(await shop.locator('#affiliateBanner').isVisible(), 'banner de indicação visível');
  ok(!shop.url().includes('af='), 'parâmetro ?af removido da URL');
  await shop.waitForTimeout(900);
  await shop.screenshot({ path: '/home/claude/shots/shop-desktop.png', fullPage: true });
  // clique em comprar: abre popup do WhatsApp (interceptado) e registra lead
  const [popup] = await Promise.all([ctx.waitForEvent('page'), shop.locator('.card .btn.wa').first().click()]);
  const popUrl = popup.url();
  await popup.close().catch(() => {});
  ok(/wa\.me\/5534998005534/.test(popUrl) || popUrl === 'about:blank' || /whatsapp/.test(popUrl), 'WhatsApp abriu: ' + popUrl.slice(0, 60));
  await shop.waitForTimeout(500);
  const leads = await admin.evaluate(async () => (await (await fetch('/api/admin/data')).json()).leads);
  ok(leads.length === 1 && leads[0].affiliateCode === 'CARLASOUZA', 'lead registrado para o afiliado');
  // modal do produto
  await shop.locator('.card .photo').nth(1).click();
  await shop.waitForSelector('#productDialog[open]');
  await shop.screenshot({ path: '/home/claude/shots/shop-modal.png' });
  await shop.keyboard.press('Escape');
  // ordenar
  await shop.selectOption('#sort', 'asc');
  const prices = await shop.$$eval('.card .price', e => e.map(x => x.textContent));
  ok(prices.length === 7, 'ordenação mantém todas as peças');

  // venda a partir do lead
  await admin.click('#tab-overview'); await admin.reload(); await admin.waitForSelector('#appView:not([hidden])');
  await admin.click('#leadList .mini');
  await admin.waitForSelector('#orderDialog[open]');
  await admin.fill('#orderCustomer', 'Cliente Teste'); await admin.selectOption('#orderStatus', 'paid');
  ok((await admin.inputValue('#orderAffiliate')) === 'CARLASOUZA', 'afiliado pré-selecionado a partir do lead');
  await admin.click('#orderForm button[type=submit]');
  await admin.waitForSelector('.order');
  ok((await admin.textContent('#orderList')).includes('Comissão aprovada'), 'venda paga gera comissão aprovada');
  await admin.screenshot({ path: '/home/claude/shots/admin-orders.png' });

  // painel do afiliado
  const af = await ctx.newPage(); log(af);
  await af.goto(base + panelLink.replace(/^https?:\/\/[^/]+/, ''));
  await af.waitForSelector('#appView:not([hidden])');
  ok(!af.url().includes('token'), 'token removido da URL do afiliado');
  ok((await af.textContent('#affName')) === 'Carla Souza', 'painel do afiliado abre');
  await af.screenshot({ path: '/home/claude/shots/affiliate.png' });

  // ===== Mobile =====
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const m = await mctx.newPage(); log(m);
  await m.goto(base + '/'); await m.waitForSelector('.card:not(.skeleton)'); await m.waitForTimeout(900);
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok(overflow <= 0, 'sem rolagem horizontal no celular (' + overflow + ')');
  await m.screenshot({ path: '/home/claude/shots/shop-mobile.png', fullPage: false });
  const ma = await mctx.newPage(); log(ma); await ma.goto(base + '/admin'); await ma.waitForSelector('#loginView:not([hidden])');
  await ma.fill('#username', 'dona'); await ma.fill('#password', 'SenhaForte#2026'); await ma.click('#loginForm button');
  await ma.waitForSelector('#appView:not([hidden])'); await ma.click('#tab-orders');
  ok((await ma.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'painel sem rolagem horizontal no celular');
  await ma.screenshot({ path: '/home/claude/shots/admin-mobile.png' });

  // ===== Servidor fora do ar: vitrine segue funcionando =====
  const fctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await fctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await fctx.route('**/api/**', r => r.abort());
  const f = await fctx.newPage(); await f.goto(base + '/'); await f.waitForSelector('.card:not(.skeleton)');
  ok((await f.locator('.card').count()) === 6, 'API fora do ar: catálogo de reserva aparece (6 peças)');

  ok(errors.length === 0, 'sem erros de console/CSP' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });

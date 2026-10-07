# Andreia semijoias — loja + painel + afiliados (Vercel)

Vitrine pública, painel do dono (`/admin`) e área do afiliado (`/afiliado`), com banco **Postgres** e funções serverless da Vercel. Tudo roda num único projeto Vercel.

## Publicar na Vercel (passo a passo)

1. Suba esta pasta para um repositório no GitHub.
2. Na Vercel: **Add New → Project** → importe o repositório (sem Build Command, sem Output Directory).
3. No projeto: **Storage → Create Database → Neon (Postgres)** e conecte ao projeto. Isso cria `DATABASE_URL` sozinho.
4. Em **Settings → Environment Variables** crie:
   - `ADMIN_USERNAME` — usuário do dono (ex.: `andreia`)
   - `ADMIN_PASSWORD` — senha forte, **12+ caracteres**
   - `SESSION_SECRET` — texto aleatório longo (gere com `openssl rand -hex 32`)
5. **Deployments → Redeploy**. As tabelas e as 6 joias iniciais são criadas automaticamente no primeiro acesso.
6. Acesse `https://seu-site.vercel.app/admin`.

Opcional: `SESSION_HOURS` (padrão 12) controla por quanto tempo o login do dono dura.

## Verificar depois de publicar

```
BASE_URL=https://seu-site.vercel.app ADMIN_USERNAME=andreia ADMIN_PASSWORD='sua-senha' node tests/smoke.js
```
Cria e apaga uma joia de teste e confirma banco, login e vitrine.

## O que mudou

- **Segurança:** senha só no servidor (variável de ambiente), sessão assinada em cookie `HttpOnly`/`SameSite=Strict`/`Secure`, proteção CSRF, bloqueio de tentativas (login do dono, login do afiliado, cliques), cabeçalhos de segurança + CSP, tokens de afiliado guardados só como hash, fotos validadas pelo conteúdo real do arquivo, nenhum dado de afiliado/comissão exposto na vitrine. Removidos: a senha padrão no HTML e o "modo local".
- **Confiabilidade:** valores em centavos inteiros (sem erro de arredondamento); comissão congelada no momento da venda; máquina de estados das vendas (pendente → paga → reembolsada; pendente → cancelada); operações em transação com trava de linha (sem duplicar pagamento de comissão); botão de WhatsApp é um link real (não é barrado por bloqueador de pop-up) e o registro de lead roda em segundo plano; se o servidor cair, a vitrine continua aparecendo com o catálogo de reserva (`public/catalog.json`).
- **Visual:** novo layout, cabeçalho fixo, hero em arco, cartões com zoom, página de detalhes da joia, ordenação por preço, esqueleto de carregamento, botão flutuante de WhatsApp no celular, painel do dono em abas (Resumo, Vendas, Joias, Afiliados, Configurações) e área do afiliado em página própria.
- **Fluxo:** "Interessados" (cliques de afiliados) viram venda com um clique; token do afiliado é exibido uma única vez, com botão de gerar novo.

## Rodar localmente / testes

```
npm install
npm test                                   # 20 testes da API (banco simulado em memória)
NODE_PATH=$(npm root -g) node tests/ui.js  # teste de navegador (precisa do Playwright)
node tests/dev-server.js                   # visualizar em http://localhost:3111 (usuário dona / SenhaForte#2026)
```

## Estrutura

```
api/index.js        API única (rotas públicas, admin e afiliado)
lib/               banco, autenticação, regras de negócio
public/            site (index, admin, afiliado, css, js, img, catalog.json)
tests/             testes automáticos e teste de fumaça
vercel.json        cabeçalhos de segurança e configuração
```

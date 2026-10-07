'use strict';
/* Servidor local de desenvolvimento: arquivos estáticos de /public + API real.
   Uso: node tests/dev-server.js        (banco falso em memória — para testes/visualização)  */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handler } = require('./harness');
const CSP = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8')).headers[0].headers.find(h => h.key === 'Content-Security-Policy').value;
const PUB = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.txt': 'text/plain' };

function readBody(req) {
  return new Promise(resolve => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => resolve(Buffer.concat(c).toString())); });
}

function start(port) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      const raw = await readBody(req);
      if (raw && /json/.test(req.headers['content-type'] || '')) { try { req.body = JSON.parse(raw); } catch (_) { req.body = {}; } }
      return handler(req, res);
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    else if (!path.extname(rel)) rel += '.html';
    const file = path.join(PUB, path.normalize(rel));
    if (!file.startsWith(PUB) || !fs.existsSync(file)) { res.statusCode = 404; return res.end('404'); }
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(port, () => r(server)));
}
module.exports = { start };
if (require.main === module) start(Number(process.env.PORT || 3111)).then(() => console.log('http://localhost:' + (process.env.PORT || 3111)));

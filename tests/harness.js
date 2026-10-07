'use strict';
/* Carrega o handler REAL da API, trocando só o módulo "pg" pelo banco falso. */
const Module = require('module');
const path = require('path');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'pg') return path.join(__dirname, 'fake-pg.js');
  return origResolve.call(this, request, ...rest);
};
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake/fake';
process.env.ADMIN_USERNAME = 'dona';
process.env.ADMIN_PASSWORD = 'SenhaForte#2026';
process.env.SESSION_SECRET = 'segredo-de-teste-com-mais-de-16-caracteres';
const handler = require('../api/index.js');
const fake = require('./fake-pg.js');
module.exports = { handler, tables: fake.__tables };

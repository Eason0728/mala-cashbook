'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../config');
const { openDb } = require('../db');
const { createAuth, setStorePass, ensureAdminInit } = require('../auth');
const { createActions } = require('../actions');

const STORE = 'store-pass-1', ADMIN = 'admin-pass-1', PNL = 'pnl-key-xyz';

// 暫存 DATA_DIR（os.tmpdir 底下），絕不碰 ~/mala-cashbook-data
function tmpEnv(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cashbook-test-'));
  const cfg = loadConfig(Object.assign({ DATA_DIR: dir, ADMIN_INIT: ADMIN, PNL_KEY: PNL, PUBLIC_BASE: 'https://x.example/cashbook', HOME: dir }, extra || {}));
  return { dir, cfg, cleanup() { fs.rmSync(dir, { recursive: true, force: true }); } };
}

// 假時鐘：t.ms 可手動撥
function clock(iso) { const c = { ms: Date.parse(iso || '2026-10-04T12:00:00Z') }; c.now = () => new Date(c.ms); return c; }

function setup(opts) {
  opts = opts || {};
  const env = tmpEnv(opts.env);
  const c = clock();
  const db = openDb(env.cfg.DATA_DIR, c.now);
  ensureAdminInit(db, env.cfg);
  if (opts.storePass !== false) setStorePass(db, STORE);
  const auth = createAuth(db, c.now);
  const actions = createActions({ db, cfg: env.cfg, now: c.now, auth, writePhoto: opts.writePhoto });
  const call = (action, p, ip) => actions.dispatch(Object.assign({ action, pass: STORE }, p || {}), ip || '1.1.1.1');
  return { env, cfg: env.cfg, db, clock: c, auth, actions, call, cleanup() { try { db.close(); } catch (e) { /* */ } env.cleanup(); } };
}

const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]).toString('base64');
module.exports = { STORE, ADMIN, PNL, tmpEnv, clock, setup, JPG };

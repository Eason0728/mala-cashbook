'use strict';
// 健康燈號（spec §5）。judge() 是純函式，測試與 http 共用。
// 備份相關 meta（T6 寫）：backup_ok_at＝上次成功 ISO 時間；backup_last_result＝'ok'|'fail'
const fs = require('node:fs');
const { getMeta } = require('./db');

const RULES = { backupRedH: 26, diskRedGB: 2, photosYellow: 200 };
const H = 3600e3;

// h: { dbOk, backupOkAt(ISO|null), baselineAt(ISO，從沒備份過時拿來算逾期), lastResult, photosPending, diskFreeGB(number|null) }
function judge(h, nowMs) {
  const t = nowMs || Date.now(), red = [], yellow = [];
  if (!h.dbOk) red.push('DB_DOWN');
  const okAt = Date.parse(h.backupOkAt || '');
  let stale = false;
  if (!isNaN(okAt)) stale = t - okAt > RULES.backupRedH * H;
  else { const b = Date.parse(h.baselineAt || ''); stale = !isNaN(b) && t - b > RULES.backupRedH * H; }
  if (stale) red.push('BACKUP_STALE');
  if (h.diskFreeGB !== null && h.diskFreeGB !== undefined && h.diskFreeGB < RULES.diskRedGB) red.push('DISK_LOW');
  if (h.photosPending > RULES.photosYellow) yellow.push('PHOTOS_PENDING');
  if (h.lastResult === 'fail' && !stale) yellow.push('BACKUP_FAILED');
  const reasons = red.concat(yellow);
  return { level: red.length ? 'red' : yellow.length ? 'yellow' : 'green', reasons };
}

function collect(db, cfg, now) {
  let dbOk = true, rows = 0, photosPending = 0, backupOkAt = null, baselineAt = null, lastResult = null;
  try {
    db.prepare('SELECT 1').get();
    rows = db.prepare('SELECT COUNT(*) c FROM rows').get().c;
    photosPending = db.prepare("SELECT COUNT(*) c FROM rows WHERE photo_file <> '' AND photo_backed_at IS NULL").get().c;
    backupOkAt = getMeta(db, 'backup_ok_at'); baselineAt = getMeta(db, 'created_at'); lastResult = getMeta(db, 'backup_last_result');
  } catch (e) { dbOk = false; }
  let diskFreeGB = null;
  try { const s = fs.statfsSync(cfg.DATA_DIR); diskFreeGB = Math.round((s.bavail * s.bsize) / 1073741824 * 10) / 10; } catch (e) { /* 讀不到就不判 */ }
  const j = judge({ dbOk, backupOkAt, baselineAt, lastResult, photosPending, diskFreeGB }, now().getTime());
  return { level: j.level, reasons: j.reasons, backupAt: backupOkAt, rows, diskFreeGB };   // 不含任何帳目內容
}

module.exports = { judge, collect, RULES };

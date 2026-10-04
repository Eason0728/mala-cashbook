'use strict';
// `node --test server/test/`（目錄參數）在 Node 22+ 不會遞迴找檔，而是 require 這個目錄 → 由這支載入全部 *.test.js。
// 單檔照樣可跑：node --test server/test/actions.test.js
const fs = require('node:fs');
fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort().forEach((f) => require('./' + f));

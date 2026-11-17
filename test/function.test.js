'use strict';
// Проверка подписи Telegram initData на сервере
process.env.TG_BOT_TOKEN = '123:TEST';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// функция при выкладке получает core.js рядом с собой
fs.copyFileSync(path.join(__dirname, '../shared/core.js'), path.join(__dirname, '../function/core.js'));
const { _test } = require('../function/index.js');

function sign(fields) {
  const check = Object.keys(fields).sort().map((k) => k + '=' + fields[k]).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update('123:TEST').digest();
  const hash = crypto.createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams(Object.assign({}, fields, { hash })).toString();
}

test('initData: правильная подпись принимается, подделка — нет', () => {
  const now = Math.floor(Date.now() / 1000);
  const good = sign({ auth_date: String(now), user: JSON.stringify({ id: 42, first_name: 'Заир' }) });
  assert.deepEqual(_test.verifyInitData(good), { id: '42', name: 'Заир', username: null });
  const bad = good.replace('42', '43');
  assert.equal(_test.verifyInitData(bad), null);
  const old = sign({ auth_date: String(now - 8 * 86400), user: JSON.stringify({ id: 42 }) });
  assert.equal(_test.verifyInitData(old), null);
  assert.equal(_test.verifyInitData(''), null);
});

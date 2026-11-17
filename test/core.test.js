'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Core, MemoryStore } = require('../shared/core.js');

function setup() {
  const sent = [];
  const tg = {
    async call(method, p) {
      sent.push({ method, p });
      if (method === 'createForumTopic') return { message_thread_id: 77 };
      return { message_id: sent.length };
    }
  };
  let t = Date.UTC(2026, 10, 17, 6, 0);
  const core = new Core(MemoryStore(), tg, () => (t += 1000), { appUrl: 'https://app.example' });
  return { core, sent };
}

async function people(core) {
  const vova = await core.session({ id: '1', name: 'Володя' });
  const zair = await core.session({ id: '2', name: 'Заир' });
  const tolya = await core.session({ id: '3', name: 'Толя' });
  await core.setRole('1', '2', 'courier');
  await core.setRole('1', '3', 'courier');
  return { vova, zair: await core.user('2'), tolya: await core.user('3') };
}

test('первый пользователь — владелец, остальные ждут подтверждения', async () => {
  const { core, sent } = setup();
  const a = await core.session({ id: '1', name: 'Володя' });
  assert.equal(a.role, 'admin');
  assert.ok(a.owner);
  const b = await core.session({ id: '2', name: 'Заир' });
  assert.equal(b.role, 'pending');
  assert.ok(sent.some((s) => s.p.chat_id === '1' && /Запрос доступа/.test(s.p.text)));
  await assert.rejects(core.setRole('2', '2', 'admin'), /Только для склада/);
  const c = await core.setRole('1', '2', 'courier');
  assert.equal(c.role, 'courier');
  assert.ok(c.color);
});

test('полный рейс: заявки → рейс → отчёты → закрытие', async () => {
  const { core, sent } = setup();
  const { vova, zair } = await people(core);
  // группа отчётов
  await core.onUpdate({ message: { from: { id: 1 }, chat: { id: -100, type: 'supergroup', is_forum: true }, text: '/reports' } });
  assert.equal((await core.cfg()).reportsChatId, -100);

  const o1 = await core.createOrder(vova, { title: 'ЖК «Левобережный»', address: 'Химки, Молодёжная 70', items: 'Ламинат — 28 уп.' });
  const o2 = await core.createOrder(vova, { title: 'Ремонт, Раменки', address: 'Мичуринский 9', items: ['Гипсокартон — 30 л.'] });
  assert.equal(o1.status, 'new');
  assert.equal(o2.num, '2');

  await core.assign(vova, o1.id, zair.id);
  await core.assign(vova, o2.id, zair.id);
  // курьер закрепился за объектом
  assert.equal((await core.s.get('project:' + o1.projectId)).courierId, zair.id);
  // порядок можно поменять до отправки
  let trip = await core.move(vova, o2.id, -1);
  assert.deepEqual(trip.orderIds, [o2.id, o1.id]);

  trip = await core.sendTrip(vova, zair.id);
  assert.equal(trip.status, 'sent');
  const msg = sent.find((s) => s.p.chat_id === '2' && /Новый рейс/.test(s.p.text || ''));
  assert.ok(msg, 'курьер получил рейс');
  // порядок погрузки обратный
  assert.ok(msg.p.text.indexOf('Левобережный: Ламинат') < msg.p.text.indexOf('Раменки: Гипсокартон'));

  // второй рейс не отправить, пока первый не закрыт
  const o3 = await core.createOrder(vova, { title: 'Офис, Сколково', address: 'Сколково', items: 'Краска' });
  await core.assign(vova, o3.id, zair.id);
  await assert.rejects(core.sendTrip(vova, zair.id), /ещё в рейсе/);

  // нельзя отчитаться по закрытой следующей точке
  await assert.rejects(core.reportStart(zair, o1.id), /не открыта/);
  await core.reportStart(zair, o2.id);
  // только фото — точка ещё открыта
  await core.onUpdate({ message: { message_id: 10, from: { id: 2 }, chat: { id: 2, type: 'private' }, photo: [{ file_id: 'p' }] } });
  assert.equal((await core.getOrder(o2.id)).status, 'active');
  // видео — закрыта
  await core.onUpdate({ message: { message_id: 11, from: { id: 2 }, chat: { id: 2, type: 'private' }, video: { file_id: 'v' } } });
  assert.equal((await core.getOrder(o2.id)).status, 'delivered');
  // отчёт скопирован в тему объекта
  const copies = sent.filter((s) => s.method === 'copyMessage');
  assert.equal(copies.length, 2);
  assert.equal(copies[0].p.message_thread_id, 77);
  assert.match(copies[0].p.caption, /Раменки/);

  // проблема на последней точке — рейс закрывается, склад предупреждён
  await core.problem(zair, o1.id, 'no_client', 'не берёт трубку');
  assert.equal((await core.getOrder(o1.id)).status, 'problem');
  assert.equal((await core.s.get('trip:' + trip.id)).status, 'done');
  assert.ok(sent.some((s) => s.p.chat_id === '1' && /Проблема на точке/.test(s.p.text || '')));
  assert.ok(sent.some((s) => s.p.chat_id === '1' && /закрыл рейс: доставлено 1 из 2/.test(s.p.text || '')));

  // теперь можно отправить следующий рейс
  const t2 = await core.sendTrip(vova, zair.id);
  assert.deepEqual(t2.orderIds, [o3.id]);
});

test('курьер видит только свои рейсы', async () => {
  const { core } = setup();
  const { vova, zair, tolya } = await people(core);
  const o = await core.createOrder(vova, { title: 'А', address: 'Б', items: 'В' });
  await core.assign(vova, o.id, zair.id);
  const st = await core.state(tolya);
  assert.equal(st.orders.length, 0);
  const st2 = await core.state(zair);
  assert.equal(st2.orders.length, 1);
  await assert.rejects(core.op(zair, { op: 'createOrder', order: { title: 'x', address: 'y', items: 'z' } }), /Только для склада/);
});

test('медиа без нажатия «Отчёт» не засчитывается', async () => {
  const { core, sent } = setup();
  const { vova, zair } = await people(core);
  const o = await core.createOrder(vova, { title: 'А', address: 'Б', items: 'В' });
  await core.assign(vova, o.id, zair.id);
  await core.sendTrip(vova, zair.id);
  await core.onUpdate({ message: { message_id: 5, from: { id: 2 }, chat: { id: 2, type: 'private' }, photo: [{}] } });
  assert.equal((await core.getOrder(o.id)).status, 'active');
  assert.ok(sent.some((s) => /сначала нажми «Отчёт по точке»/.test(s.p.text || '')));
});

test('убрать из рейса и отменить заявку', async () => {
  const { core } = setup();
  const { vova, zair } = await people(core);
  const o = await core.createOrder(vova, { title: 'А', address: 'Б', items: 'В' });
  const { trip } = await core.assign(vova, o.id, zair.id);
  await core.unqueue(vova, o.id);
  assert.equal(await core.s.get('trip:' + trip.id), null);
  const c = await core.cancelOrder(vova, o.id);
  assert.equal(c.status, 'cancelled');
});

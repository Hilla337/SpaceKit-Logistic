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

  const o1 = await core.createOrder(vova, { num: '101', title: 'ЖК «Левобережный»', address: 'Химки, Молодёжная 70', items: 'Ламинат — 28 уп.' });
  const o2 = await core.createOrder(vova, { num: '102', title: 'Ремонт, Раменки', address: 'Мичуринский 9', items: ['Гипсокартон — 30 л.'] });
  assert.equal(o1.status, 'new');
  assert.equal(o2.num, '102');

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
  const o3 = await core.createOrder(vova, { num: '103', title: 'Офис, Сколково', address: 'Сколково', items: 'Краска' });
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
  const o = await core.createOrder(vova, { num: '104', title: 'А', address: 'Б', items: 'В' });
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
  const o = await core.createOrder(vova, { num: '105', title: 'А', address: 'Б', items: 'В' });
  await core.assign(vova, o.id, zair.id);
  await core.sendTrip(vova, zair.id);
  await core.onUpdate({ message: { message_id: 5, from: { id: 2 }, chat: { id: 2, type: 'private' }, photo: [{}] } });
  assert.equal((await core.getOrder(o.id)).status, 'active');
  assert.ok(sent.some((s) => /сначала нажми «Отчёт по точке»/.test(s.p.text || '')));
});

test('убрать из рейса и отменить заявку', async () => {
  const { core } = setup();
  const { vova, zair } = await people(core);
  const o = await core.createOrder(vova, { num: '106', title: 'А', address: 'Б', items: 'В' });
  const { trip } = await core.assign(vova, o.id, zair.id);
  await core.unqueue(vova, o.id);
  assert.equal(await core.s.get('trip:' + trip.id), null);
  const c = await core.cancelOrder(vova, o.id);
  assert.equal(c.status, 'cancelled');
});

test('№ заявки обязателен и не повторяется', async () => {
  const { core } = setup();
  const { vova } = await people(core);
  await assert.rejects(core.createOrder(vova, { title: 'А', address: 'Б', items: 'В' }), /№ заявки/);
  await core.createOrder(vova, { num: '№ 7', title: 'А', address: 'Б', items: 'В' });
  await assert.rejects(core.createOrder(vova, { num: '7', title: 'Г', address: 'Д', items: 'Е' }), /уже есть/);
});

test('пропуск: заказчик сам получает машину и госномер, отчёты и архив', async () => {
  const { core, sent } = setup();
  const archived = [];
  core.opts.archive = async (fileId, base) => { archived.push(base); return base + '.jpg'; };
  const { vova, zair, tolya } = await people(core);
  await core.updateCourier(vova, zair.id, { vehicle: 'Isuzu 3 т', plate: 'а123вс777', phone: '+79160000002' });
  const o = await core.createOrder(vova, { num: '1048', title: 'ЖК «Левобережный»', address: 'Химки', items: 'Ламинат — 28 уп.' });
  const p = await core.s.get('project:' + o.projectId);
  assert.ok(p.token);
  // заказчик открыл ссылку
  await core.onUpdate({ message: { message_id: 1, from: { id: 900, first_name: 'Игорь' }, chat: { id: 900, type: 'private' }, text: '/start c_' + p.token } });
  assert.equal((await core.s.get('project:' + o.projectId)).clients.length, 1);
  assert.equal(await core.user('900'), null, 'заказчик не становится сотрудником');
  // постановка в рейс → данные для пропуска
  await core.assign(vova, o.id, zair.id);
  const pass = sent.filter((x) => x.p.chat_id === 900 && /Доставка запланирована/.test(x.p.text || ''));
  assert.equal(pass.length, 1);
  assert.match(pass[0].p.text, /А123ВС777/);
  assert.match(pass[0].p.text, /№1048/);
  // повторно то же самое не шлём; смена машины — шлём обновление
  await core.updateCourier(vova, zair.id, { plate: 'А123ВС777' });
  assert.equal(sent.filter((x) => x.p.chat_id === 900 && /Доставка запланирована/.test(x.p.text || '')).length, 1);
  await core.myCar(zair, { plate: 'В777ОР99' });
  const upd = sent.filter((x) => x.p.chat_id === 900 && /Машина изменилась/.test(x.p.text || ''));
  assert.equal(upd.length, 1);
  assert.match(upd[0].p.text, /В777ОР99/);
  // переназначили на другого курьера — тоже обновление
  await core.updateCourier(vova, tolya.id, { plate: 'М456КР750' });
  await core.assign(vova, o.id, tolya.id);
  assert.ok(sent.some((x) => x.p.chat_id === 900 && /М456КР750/.test(x.p.text || '')));
  // выезд
  await core.sendTrip(vova, tolya.id);
  assert.ok(sent.some((x) => x.p.chat_id === 900 && /выехала/.test(x.p.text || '')));
  const t = sent.find((x) => x.p.chat_id === tolya.id && /Новый рейс/.test(x.p.text || ''));
  assert.match(t.p.text, /№1048/);
  // отчёт: копия заказчику + архив
  await core.reportStart(await core.user(tolya.id), o.id);
  await core.onUpdate({ message: { message_id: 20, from: { id: 3 }, chat: { id: 3, type: 'private' }, photo: [{ file_id: 'small' }, { file_id: 'big' }] } });
  await core.onUpdate({ message: { message_id: 21, from: { id: 3 }, chat: { id: 3, type: 'private' }, video: { file_id: 'vid' } } });
  const toClient = sent.filter((x) => x.method === 'copyMessage' && x.p.chat_id === 900);
  assert.equal(toClient.length, 2);
  assert.match(toClient[0].p.caption, /№1048/);
  assert.ok(sent.some((x) => x.p.chat_id === 900 && /Доставлено/.test(x.p.text || '')));
  assert.equal(archived.length, 2);
  assert.match(archived[0], /^жк-левобережный\/\d{4}-\d{2}-\d{2}\/N1048_\d\d-\d\d_foto1$/);
  assert.match(archived[1], /video1$/);
  const done = await core.getOrder(o.id);
  assert.equal(done.status, 'delivered');
  assert.equal(done.report.files.length, 2);
  // отписка
  await core.onUpdate({ message: { message_id: 30, from: { id: 900 }, chat: { id: 900, type: 'private' }, text: '/stop' } });
  assert.equal((await core.s.get('project:' + o.projectId)).clients.length, 0);
});

test('сбой архива не мешает закрыть точку', async () => {
  const { core } = setup();
  core.opts.archive = async () => { throw new Error('бакет недоступен'); };
  const { vova, zair } = await people(core);
  const o = await core.createOrder(vova, { num: '5', title: 'А', address: 'Б', items: 'В' });
  await core.assign(vova, o.id, zair.id);
  await core.sendTrip(vova, zair.id);
  await core.reportStart(zair, o.id);
  await core.onUpdate({ message: { message_id: 1, from: { id: 2 }, chat: { id: 2, type: 'private' }, photo: [{ file_id: 'x' }] } });
  await core.onUpdate({ message: { message_id: 2, from: { id: 2 }, chat: { id: 2, type: 'private' }, video: { file_id: 'y' } } });
  const d = await core.getOrder(o.id);
  assert.equal(d.status, 'delivered');
  assert.equal(d.report.archiveErrors, 2);
});

/*
 * SpaceKit Logistic — общая логика.
 * Один и тот же файл работает на сервере (Yandex Cloud Function) и в браузере (демо-режим).
 *
 * Зависимости передаются снаружи:
 *   store: { get(k), put(k, v), del(k), list(prefix) }  — асинхронное хранилище ключ → объект
 *   tg:    { call(method, params) }                       — Telegram Bot API
 *   now:   () => миллисекунды
 */
(function (root) {
  'use strict';

  var TZ = 'Europe/Moscow';
  var COLORS = ['#22c55e', '#06b6d4', '#a855f7', '#f59e0b', '#ef4444', '#3b82f6', '#ec4899', '#14b8a6'];
  var PROBLEMS = {
    no_client: 'Нет клиента / не отвечает',
    closed: 'Объект закрыт, не пускают',
    wrong_goods: 'Не тот груз или не хватает',
    no_access: 'Не проехать / нет подъезда',
    other: 'Другое'
  };

  function hhmm(ts) {
    return new Date(ts).toLocaleTimeString('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  }
  function dmhm(ts) {
    return new Date(ts).toLocaleString('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', '');
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; });
  }
  function clean(s, max) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max || 200);
  }
  function projectKey(name) {
    return clean(name, 120).toLowerCase().replace(/[«»"'`]/g, '').replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, '-').replace(/^-|-$/g, '') || 'bez-nazvaniya';
  }
  function fail(msg, code) {
    var e = new Error(msg);
    e.userError = true;
    e.code = code || 400;
    throw e;
  }

  function Core(store, tg, now, opts) {
    this.s = store;
    this.tg = tg;
    this.now = now || Date.now;
    this.opts = opts || {};
  }

  var P = Core.prototype;

  P.newId = function () {
    return this.now().toString(36) + Math.random().toString(36).slice(2, 6);
  };

  P.cfg = async function () {
    return (await this.s.get('cfg')) || { reportsChatId: null, nextNum: 1 };
  };

  P.users = async function () { return this.s.list('user:'); };
  P.user = async function (id) { return this.s.get('user:' + id); };
  P.admins = async function () { return (await this.users()).filter(function (u) { return u.role === 'admin'; }); };
  P.couriers = async function () { return (await this.users()).filter(function (u) { return u.role === 'courier'; }); };

  P.send = async function (chatId, text, extra) {
    if (!chatId) return null;
    try {
      return await this.tg.call('sendMessage', Object.assign({ chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true }, extra || {}));
    } catch (e) {
      console.error('tg send failed', chatId, String(e && e.message || e));
      return null;
    }
  };

  P.appButton = function (text) {
    if (!this.opts.appUrl) return undefined;
    return { reply_markup: { inline_keyboard: [[{ text: text || 'Открыть приложение', web_app: { url: this.opts.appUrl } }]] } };
  };

  P.notifyAdmins = async function (text, extra) {
    var list = await this.admins();
    for (var i = 0; i < list.length; i++) await this.send(list[i].id, text, extra);
  };

  // ---------- доступ ----------

  /** Кто пришёл из мини-приложения. ident = { id, name, username } из проверенного initData */
  P.session = async function (ident) {
    var u = await this.user(ident.id);
    if (!u) {
      var anyone = (await this.users()).some(function (x) { return x.role === 'admin'; });
      if (!anyone) {
        // самый первый пользователь становится владельцем
        u = { id: ident.id, name: ident.name, username: ident.username, role: 'admin', owner: true, addedAt: this.now() };
        await this.s.put('user:' + u.id, u);
      } else {
        u = { id: ident.id, name: ident.name, username: ident.username, role: 'pending', addedAt: this.now() };
        await this.s.put('user:' + u.id, u);
        await this.notifyAdmins('🙋 Запрос доступа: <b>' + esc(u.name) + '</b>' + (u.username ? ' @' + esc(u.username) : ''), this.accessKeyboard(u.id));
      }
    }
    return u;
  };

  P.accessKeyboard = function (id) {
    return { reply_markup: { inline_keyboard: [[
      { text: '🚚 Курьер', callback_data: 'acc:' + id + ':courier' },
      { text: '🏬 Склад', callback_data: 'acc:' + id + ':admin' },
      { text: '✖️ Отклонить', callback_data: 'acc:' + id + ':deny' }
    ]] } };
  };

  P.setRole = async function (adminId, id, role) {
    var a = await this.user(adminId);
    if (!a || a.role !== 'admin') fail('Только для склада', 403);
    var u = await this.user(id);
    if (!u) fail('Пользователь не найден', 404);
    if (u.owner && role !== 'admin') fail('Владельца понизить нельзя');
    if (role === 'deny' || role === 'remove') {
      u.role = 'removed';
    } else if (role === 'courier' || role === 'admin') {
      u.role = role;
      if (role === 'courier' && !u.color) {
        var used = (await this.couriers()).map(function (c) { return c.color; });
        u.color = COLORS.filter(function (c) { return used.indexOf(c) < 0; })[0] || COLORS[0];
        u.vehicle = u.vehicle || '';
      }
    } else fail('Неизвестная роль');
    await this.s.put('user:' + u.id, u);
    if (u.role === 'courier') await this.send(u.id, '✅ Доступ открыт. Ты курьер SpaceKit.\nКогда Володя отправит рейс, он придёт сюда.', this.appButton());
    if (u.role === 'admin') await this.send(u.id, '✅ Доступ открыт: склад.', this.appButton());
    if (u.role === 'removed') await this.send(u.id, 'Доступ не выдан. Если это ошибка — напиши Володе.');
    return u;
  };

  // ---------- данные для экранов ----------

  P.state = async function (u) {
    var all = await Promise.all([this.s.list('order:'), this.s.list('trip:'), this.s.list('project:'), this.users()]);
    var orders = all[0], trips = all[1], projects = all[2], users = all[3];
    var weekAgo = this.now() - 7 * 86400000;
    await this.archive(orders, trips, this.now() - 21 * 86400000);
    trips = trips.filter(function (t) { return t.status !== 'done' || (t.doneAt || 0) > weekAgo; });
    orders = orders.filter(function (o) { return o.status !== 'delivered' && o.status !== 'cancelled' || (o.closedAt || 0) > weekAgo; });
    var couriers = users.filter(function (x) { return x.role === 'courier'; }).map(function (c) {
      return { id: c.id, name: c.name, vehicle: c.vehicle || '', plate: c.plate || '', phone: c.phone || '', color: c.color };
    });
    projects = projects.map(function (p) {
      return { id: p.id, name: p.name, address: p.address, courierId: p.courierId, token: p.token, clients: (p.clients || []).length, createdAt: p.createdAt };
    });
    var cfg = await this.cfg();
    if (u.role === 'admin') {
      return {
        me: { id: u.id, name: u.name, role: u.role, owner: !!u.owner },
        orders: orders, trips: trips, projects: projects, couriers: couriers,
        pending: users.filter(function (x) { return x.role === 'pending'; }).map(function (x) { return { id: x.id, name: x.name, username: x.username }; }),
        reportsChat: !!cfg.reportsChatId,
        bot: this.opts.botUsername || '',
        problems: PROBLEMS
      };
    }
    if (u.role === 'courier') {
      var mine = trips.filter(function (t) { return t.courierId === u.id; });
      var ids = {};
      mine.forEach(function (t) { t.orderIds.forEach(function (id) { ids[id] = 1; }); });
      return {
        me: { id: u.id, name: u.name, role: u.role, vehicle: u.vehicle || '', plate: u.plate || '', phone: u.phone || '', color: u.color },
        trips: mine,
        orders: orders.filter(function (o) { return ids[o.id]; }),
        problems: PROBLEMS
      };
    }
    return { me: { id: u.id, name: u.name, role: u.role } };
  };

  /** Закрытое старше 3 недель уезжает в архив (arch:*), чтобы рабочие списки оставались короткими */
  P.archive = async function (orders, trips, before) {
    var n = 0;
    for (var i = 0; i < orders.length && n < 50; i++) {
      var o = orders[i];
      if (o.closedAt && o.closedAt < before && /^(delivered|problem|cancelled)$/.test(o.status) && (!o.tripId || !trips.some(function (t) { return t.id === o.tripId && t.status !== 'done'; }))) {
        await this.s.put('arch:order:' + o.id, o); await this.s.del('order:' + o.id); n++;
      }
    }
    for (var j = 0; j < trips.length && n < 50; j++) {
      var t = trips[j];
      if (t.status === 'done' && t.doneAt < before) { await this.s.put('arch:trip:' + t.id, t); await this.s.del('trip:' + t.id); n++; }
    }
  };

  // ---------- заявки ----------

  P.ensureProject = async function (name, address) {
    var key = projectKey(name);
    var p = await this.s.get('project:' + key);
    if (!p) {
      p = { id: key, name: clean(name, 120), address: clean(address, 200), courierId: null, topicId: null, token: this.newToken(), clients: [], createdAt: this.now() };
      await this.s.put('project:' + key, p);
    } else if ((address && !p.address) || !p.token) {
      if (address && !p.address) p.address = clean(address, 200);
      if (!p.token) p.token = this.newToken();
      await this.s.put('project:' + key, p);
    }
    return p;
  };

  P.newToken = function () {
    var s = '';
    for (var i = 0; i < 3; i++) s += Math.random().toString(36).slice(2, 7);
    return s;
  };

  // ---------- заказчики: пропуска и отчёты ----------

  P.carLine = function (c) {
    return [c.vehicle, c.plate ? 'госномер <b>' + esc(c.plate) + '</b>' : 'госномер не указан'].filter(Boolean).join(', ');
  };

  /** Сообщение всем подписанным заказчикам объекта */
  P.toClients = async function (o, text, extra) {
    var p = await this.s.get('project:' + o.projectId);
    var list = (p && p.clients) || [];
    for (var i = 0; i < list.length; i++) await this.send(list[i].id, text, extra);
    return list.length;
  };

  /** Данные для пропуска: при постановке в рейс и при смене машины */
  P.passInfo = async function (o, c, why) {
    var stamp = c.id + '|' + (c.plate || '') + '|' + (c.vehicle || '');
    if (o.passFor === stamp) return 0;
    var head = why === 'changed' ? '🔄 <b>Машина изменилась</b>' : '🚚 <b>Доставка запланирована</b>';
    var n = await this.toClients(o, head + '\nОбъект: ' + esc(o.title) + ' · заявка №' + esc(o.num) +
      '\nГруз: ' + esc(o.items.join(', ')) +
      '\n\nМашина: ' + this.carLine(c) +
      '\nВодитель: ' + esc(c.name) + (c.phone ? ', ' + esc(c.phone) : '') +
      (o.window ? '\nОкно: ' + esc(o.window) : '') +
      '\n\nПожалуйста, закажите пропуск на въезд по этому госномеру. Когда машина выедет со склада — напишу.');
    o.passFor = stamp;
    await this.s.put('order:' + o.id, o);
    return n;
  };

  /** Курьер сам меняет машину/госномер — заказчики его заявок получают обновление */
  P.myCar = async function (u, d) {
    if (!u || u.role !== 'courier') fail('Только для курьера', 403);
    var c = await this.user(u.id);
    if (d.vehicle != null) c.vehicle = clean(d.vehicle, 60);
    if (d.plate != null) c.plate = clean(d.plate, 20).toUpperCase();
    if (d.phone != null) c.phone = clean(d.phone, 30);
    await this.s.put('user:' + c.id, c);
    await this.refreshPasses(c);
    return c;
  };

  P.refreshPasses = async function (c) {
    var orders = await this.s.list('order:');
    for (var i = 0; i < orders.length; i++) {
      var o = orders[i];
      if (o.courierId === c.id && (o.status === 'queued' || o.status === 'active') && o.passFor) await this.passInfo(o, c, 'changed');
    }
  };

  /** /start c_<token> — заказчик подписывается на объект (в личке или в группе) */
  P.subscribe = async function (chat, token, who) {
    var projects = await this.s.list('project:');
    var p = projects.filter(function (x) { return x.token && x.token === token; })[0];
    if (!p) return this.send(chat.id, 'Ссылка устарела или неверная. Попросите менеджера SpaceKit прислать новую.');
    p.clients = p.clients || [];
    if (!p.clients.some(function (x) { return String(x.id) === String(chat.id); })) {
      p.clients.push({ id: chat.id, name: chat.title || who, at: this.now() });
      await this.s.put('project:' + p.id, p);
      await this.notifyAdmins('🤝 Заказчик подключился к объекту <b>' + esc(p.name) + '</b>: ' + esc(chat.title || who));
    }
    return this.send(chat.id, '✅ Вы подключены к доставкам SpaceKit по объекту <b>' + esc(p.name) + '</b>.\n\nСюда будут приходить:\n• машина и госномер — чтобы заказать пропуск;\n• когда машина выехала;\n• фото и видео выгрузки.\n\nОтключиться: /stop');
  };

  P.unsubscribe = async function (chat) {
    var projects = await this.s.list('project:');
    var n = 0;
    for (var i = 0; i < projects.length; i++) {
      var p = projects[i], before = (p.clients || []).length;
      p.clients = (p.clients || []).filter(function (x) { return String(x.id) !== String(chat.id); });
      if (p.clients.length !== before) { n++; await this.s.put('project:' + p.id, p); }
    }
    return this.send(chat.id, n ? 'Отключено. Уведомления о доставках больше не придут.' : 'Подписок нет.');
  };

  P.createOrder = async function (u, d) {
    this.mustAdmin(u);
    var title = clean(d.title, 120);
    var address = clean(d.address, 200);
    var items = (Array.isArray(d.items) ? d.items : String(d.items || '').split(/\n/)).map(function (x) { return clean(x, 160); }).filter(Boolean).slice(0, 40);
    var num = clean(d.num, 20).replace(/^№\s*/, '');
    if (!num) fail('Укажи № заявки');
    if (!title) fail('Укажи объект');
    if (!address) fail('Укажи адрес');
    if (!items.length) fail('Укажи груз');
    var dup = (await this.s.list('order:')).filter(function (x) { return x.num === num && x.status !== 'cancelled'; })[0];
    if (dup) fail('Заявка №' + num + ' уже есть: ' + dup.title);
    var p = await this.ensureProject(title, address);
    var o = {
      id: this.newId(), num: num, projectId: p.id, title: title, address: address, items: items,
      window: clean(d.window, 60), note: clean(d.note, 300), unload: !!d.unload,
      status: 'new', courierId: null, tripId: null, createdAt: this.now(), source: d.source || 'manual'
    };
    await this.s.put('order:' + o.id, o);
    return o;
  };

  P.mustAdmin = function (u) { if (!u || u.role !== 'admin') fail('Только для склада', 403); };

  P.getOrder = async function (id) {
    var o = await this.s.get('order:' + id);
    if (!o) fail('Заявка не найдена', 404);
    return o;
  };

  P.formingTrip = async function (courierId) {
    var trips = await this.s.list('trip:');
    var t = trips.filter(function (x) { return x.courierId === courierId && x.status === 'forming'; })[0];
    if (!t) {
      t = { id: this.newId(), courierId: courierId, status: 'forming', orderIds: [], createdAt: this.now() };
      await this.s.put('trip:' + t.id, t);
    }
    return t;
  };

  /** Поставить заявку в следующий рейс курьера. Если объект новый — закрепить курьера за ним. */
  P.assign = async function (u, orderId, courierId) {
    this.mustAdmin(u);
    var c = await this.user(courierId);
    if (!c || c.role !== 'courier') fail('Курьер не найден', 404);
    var o = await this.getOrder(orderId);
    if (o.status !== 'new' && o.status !== 'queued') fail('Заявка уже в пути');
    if (o.tripId) await this.unqueue(u, o.id);
    o = await this.getOrder(orderId);
    var t = await this.formingTrip(courierId);
    t.orderIds.push(o.id);
    await this.s.put('trip:' + t.id, t);
    o.status = 'queued'; o.courierId = courierId; o.tripId = t.id;
    await this.s.put('order:' + o.id, o);
    var p = await this.s.get('project:' + o.projectId);
    if (p && p.courierId !== courierId) { p.courierId = courierId; await this.s.put('project:' + p.id, p); }
    await this.passInfo(o, c, o.passFor ? 'changed' : 'planned');
    return { order: o, trip: t };
  };

  P.unqueue = async function (u, orderId) {
    this.mustAdmin(u);
    var o = await this.getOrder(orderId);
    if (o.status !== 'queued') fail('Убрать можно только из рейса, который ещё не отправлен');
    var t = await this.s.get('trip:' + o.tripId);
    if (t) {
      t.orderIds = t.orderIds.filter(function (x) { return x !== o.id; });
      if (t.orderIds.length) await this.s.put('trip:' + t.id, t); else await this.s.del('trip:' + t.id);
    }
    o.status = 'new'; o.tripId = null; o.courierId = null;
    await this.s.put('order:' + o.id, o);
    return o;
  };

  P.move = async function (u, orderId, dir) {
    this.mustAdmin(u);
    var o = await this.getOrder(orderId);
    var t = await this.s.get('trip:' + o.tripId);
    if (!t || t.status !== 'forming') fail('Порядок меняется до отправки рейса');
    var i = t.orderIds.indexOf(o.id), j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= t.orderIds.length) return t;
    var tmp = t.orderIds[i]; t.orderIds[i] = t.orderIds[j]; t.orderIds[j] = tmp;
    await this.s.put('trip:' + t.id, t);
    return t;
  };

  P.cancelOrder = async function (u, orderId) {
    this.mustAdmin(u);
    var o = await this.getOrder(orderId);
    if (o.status === 'queued') o = await this.unqueue(u, orderId);
    if (o.status !== 'new') fail('Отменить можно только заявку, которая ещё не в пути');
    o.status = 'cancelled'; o.closedAt = this.now();
    await this.s.put('order:' + o.id, o);
    if (o.passFor) await this.toClients(o, '❌ Доставка по заявке №' + esc(o.num) + ' (' + esc(o.title) + ') отменена. Пропуск на эту машину больше не нужен — менеджер SpaceKit свяжется с вами.');
    return o;
  };

  P.activeTrip = async function (courierId) {
    var trips = await this.s.list('trip:');
    return trips.filter(function (x) { return x.courierId === courierId && x.status === 'sent'; })[0] || null;
  };

  P.tripOrders = async function (t) {
    var res = [];
    for (var i = 0; i < t.orderIds.length; i++) {
      var o = await this.s.get('order:' + t.orderIds[i]);
      if (o) res.push(o);
    }
    return res;
  };

  P.sendTrip = async function (u, courierId) {
    this.mustAdmin(u);
    var c = await this.user(courierId);
    if (!c || c.role !== 'courier') fail('Курьер не найден', 404);
    if (await this.activeTrip(courierId)) fail(c.name + ' ещё в рейсе. Следующий можно отправить, когда закроет текущий.');
    var trips = await this.s.list('trip:');
    var t = trips.filter(function (x) { return x.courierId === courierId && x.status === 'forming'; })[0];
    if (!t || !t.orderIds.length) fail('В рейсе нет заявок');
    var orders = await this.tripOrders(t);
    t.status = 'sent'; t.sentAt = this.now(); t.sentBy = u.name;
    await this.s.put('trip:' + t.id, t);
    for (var i = 0; i < orders.length; i++) {
      orders[i].status = 'active'; orders[i].seq = i + 1;
      await this.s.put('order:' + orders[i].id, orders[i]);
    }
    var lines = orders.map(function (o, i) { return (i + 1) + '. <b>' + esc(o.title) + '</b> · №' + esc(o.num) + '\n    ' + esc(o.address); });
    var load = orders.slice().reverse().map(function (o) { return '• №' + esc(o.num) + ' ' + esc(o.title) + ': ' + esc(o.items.join(', ')); });
    for (var k = 0; k < orders.length; k++) {
      await this.toClients(orders[k], '🛣 <b>Машина выехала со склада</b>\nЗаявка №' + esc(orders[k].num) + ' · ' + esc(orders[k].title) +
        '\nМашина: ' + this.carLine(c) + '\nВодитель: ' + esc(c.name) + (c.phone ? ', ' + esc(c.phone) : '') +
        '\nВы — точка ' + (k + 1) + ' из ' + orders.length + ' в рейсе.');
    }
    await this.send(courierId,
      '🚚 <b>Новый рейс · ' + orders.length + ' ' + plural(orders.length, 'точка', 'точки', 'точек') + '</b>\n\n' + lines.join('\n') +
      '\n\n📦 <b>Грузить в таком порядке</b> (первым — то, что выгружать последним):\n' + load.join('\n') +
      '\n\nОткрывай приложение: там текущая точка и отчёт.', this.appButton('Открыть рейс'));
    return t;
  };

  // ---------- курьер на точке ----------

  P.currentOrder = async function (courierId) {
    var t = await this.activeTrip(courierId);
    if (!t) return null;
    var orders = await this.tripOrders(t);
    return orders.filter(function (o) { return o.status === 'active'; })[0] || null;
  };

  P.mustCurrent = async function (u, orderId) {
    if (!u || u.role !== 'courier') fail('Только для курьера', 403);
    var cur = await this.currentOrder(u.id);
    if (!cur || cur.id !== orderId) fail('Эта точка сейчас не открыта. Сначала закрой текущую.');
    return cur;
  };

  /** Курьер нажал «Отчёт по точке»: бот ждёт фото и видео в чате */
  P.reportStart = async function (u, orderId) {
    var o = await this.mustCurrent(u, orderId);
    o.report = o.report || { photos: 0, videos: 0 };
    await this.s.put('order:' + o.id, o);
    await this.s.put('pending:' + u.id, { orderId: o.id, at: this.now() });
    await this.send(u.id,
      '📸 <b>Отчёт: точка ' + o.seq + ' · ' + esc(o.title) + '</b>\n' + esc(o.address) +
      '\n\nПришли сюда <b>фото</b> груза на месте и <b>видео</b> выгрузки (10–20 сек). Можно несколько.' +
      '\nКак только будет хотя бы одно фото и одно видео — точка закроется сама.' +
      progress(o.report));
    return o;
  };

  P.problem = async function (u, orderId, reason, comment) {
    var o = await this.mustCurrent(u, orderId);
    if (!PROBLEMS[reason]) fail('Выбери причину');
    o.status = 'problem';
    o.problem = { reason: reason, text: PROBLEMS[reason], comment: clean(comment, 300), at: this.now() };
    o.closedAt = this.now();
    await this.s.put('order:' + o.id, o);
    await this.s.del('pending:' + u.id);
    var msg = '⚠️ <b>Проблема на точке</b>\n' + esc(o.title) + ' · №' + esc(o.num) + '\n' + esc(o.address) +
      '\n\nПричина: <b>' + esc(o.problem.text) + '</b>' + (o.problem.comment ? '\n«' + esc(o.problem.comment) + '»' : '') +
      '\nКурьер: ' + esc(u.name) + ' · ' + hhmm(o.closedAt) + '\nГруз остался в машине.';
    await this.notifyAdmins(msg);
    await this.postToProject(o, msg);
    await this.afterClose(u, o);
    return o;
  };

  P.afterClose = async function (u, o) {
    var t = await this.s.get('trip:' + o.tripId);
    var orders = await this.tripOrders(t);
    var next = orders.filter(function (x) { return x.status === 'active'; })[0];
    if (next) {
      await this.send(u.id, '➡️ Следующая точка ' + next.seq + ': <b>' + esc(next.title) + '</b>\n' + esc(next.address), this.appButton('Открыть точку'));
      return;
    }
    t.status = 'done'; t.doneAt = this.now();
    await this.s.put('trip:' + t.id, t);
    var ok = orders.filter(function (x) { return x.status === 'delivered'; }).length;
    var bad = orders.length - ok;
    await this.send(u.id, '🏁 Рейс закрыт. Возвращайся на склад.' + (bad ? '\nНе доставлено: ' + bad + ' — груз вези обратно.' : ''));
    await this.notifyAdmins('🏁 <b>' + esc(u.name) + '</b> закрыл рейс: доставлено ' + ok + ' из ' + orders.length + (bad ? ', проблем: ' + bad : '') + '. Едет на склад.');
  };

  // ---------- отчёты в группу ----------

  P.topicFor = async function (o) {
    var cfg = await this.cfg();
    if (!cfg.reportsChatId) return null;
    var p = await this.s.get('project:' + o.projectId);
    if (!p) return { chat: cfg.reportsChatId };
    if (!p.topicId && !p.topicFailed) {
      try {
        var r = await this.tg.call('createForumTopic', { chat_id: cfg.reportsChatId, name: p.name.slice(0, 120) });
        p.topicId = r && r.message_thread_id;
      } catch (e) {
        p.topicFailed = true; // группа без тем — пишем в общий чат
      }
      await this.s.put('project:' + p.id, p);
    }
    return { chat: cfg.reportsChatId, thread: p.topicId || undefined };
  };

  P.postToProject = async function (o, text) {
    var dst = await this.topicFor(o);
    if (!dst) return;
    await this.send(dst.chat, text, dst.thread ? { message_thread_id: dst.thread } : {});
  };

  /** Сообщение в личке бота с фото или видео */
  P.onMedia = async function (msg) {
    var from = String(msg.from.id);
    var u = await this.user(from);
    if (!u || u.role !== 'courier') return;
    var pend = await this.s.get('pending:' + from);
    if (!pend) {
      await this.send(from, 'Чтобы отчёт попал куда надо, сначала нажми «Отчёт по точке» в приложении.', this.appButton('Открыть рейс'));
      return;
    }
    var o = await this.s.get('order:' + pend.orderId);
    if (!o || o.status !== 'active') { await this.s.del('pending:' + from); return; }
    var kind = msg.photo ? 'photos' : (msg.video || msg.video_note || (msg.document && /^video\//.test(msg.document.mime_type || ''))) ? 'videos'
      : (msg.document && /^image\//.test(msg.document.mime_type || '')) ? 'photos' : null;
    if (!kind) return;
    o.report = o.report || { photos: 0, videos: 0 };
    var first = !o.report.photos && !o.report.videos;
    o.report[kind]++;
    var when = dmhm(this.now());
    var caption = first
      ? '📦 ' + o.title + ' · заявка №' + o.num + '\n' + o.items.join(', ') + '\n🚚 ' + u.name + ' · ' + when
      : '📦 ' + o.title + ' · №' + o.num + ' · ' + when;
    var copy = async function (chat, thread) {
      try {
        await this.tg.call('copyMessage', Object.assign({ chat_id: chat, from_chat_id: msg.chat.id, message_id: msg.message_id, caption: caption.slice(0, 1000) },
          thread ? { message_thread_id: thread } : {}));
      } catch (e) { console.error('copy failed', chat, String(e && e.message || e)); }
    }.bind(this);
    var dst = await this.topicFor(o);
    if (dst) await copy(dst.chat, dst.thread);
    // заказчику
    var p = await this.s.get('project:' + o.projectId);
    var clients = (p && p.clients) || [];
    for (var ci = 0; ci < clients.length; ci++) await copy(clients[ci].id);
    // в архив (облако)
    if (this.opts.archive) {
      var file = msg.photo ? msg.photo[msg.photo.length - 1] : (msg.video || msg.video_note || msg.document);
      var d = new Date(this.now());
      var day = d.toLocaleDateString('sv-SE', { timeZone: TZ });
      var hm = hhmm(this.now()).replace(':', '-');
      var base = (p ? p.id : o.projectId) + '/' + day + '/N' + String(o.num).replace(/[^\w-]/g, '_') + '_' + hm + '_' + (kind === 'photos' ? 'foto' : 'video') + o.report[kind];
      try {
        var key = await this.opts.archive(file && file.file_id, base);
        if (key) { o.report.files = (o.report.files || []).concat(key).slice(-50); }
      } catch (e) {
        console.error('archive failed', String(e && e.message || e));
        o.report.archiveErrors = (o.report.archiveErrors || 0) + 1;
      }
    }
    if (o.report.photos >= 1 && o.report.videos >= 1) {
      o.status = 'delivered'; o.deliveredAt = this.now(); o.closedAt = o.deliveredAt;
      await this.s.put('order:' + o.id, o);
      await this.s.del('pending:' + from);
      await this.send(from, '✅ Точка ' + o.seq + ' закрыта: ' + esc(o.title) + ' · №' + esc(o.num));
      await this.toClients(o, '✅ <b>Доставлено</b>: заявка №' + esc(o.num) + ' · ' + esc(o.title) + ' · ' + hhmm(o.deliveredAt) + '. Фото и видео выгрузки — выше.');
      await this.afterClose(u, o);
    } else {
      await this.s.put('order:' + o.id, o);
      if (o.report[kind] === 1) await this.send(from, 'Принято.' + progress(o.report));
    }
  };

  // ---------- вход из Telegram (webhook) ----------

  P.onUpdate = async function (up) {
    if (up.callback_query) return this.onCallback(up.callback_query);
    var msg = up.message;
    if (!msg || !msg.from) return;
    var text = (msg.text || '').trim();
    var isPrivate = msg.chat.type === 'private';
    var who = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || msg.from.username || String(msg.from.id);
    var sub = /^\/start(?:@\w+)?\s+c_([a-z0-9]+)$/.exec(text);
    if (sub) return this.subscribe(msg.chat, sub[1], who);
    if (/^\/stop(@\w+)?$/.test(text)) {
      var me = isPrivate ? await this.user(String(msg.from.id)) : null;
      if (!me || (me.role !== 'admin' && me.role !== 'courier')) return this.unsubscribe(msg.chat);
    }
    if (!isPrivate) {
      if (/^\/reports(@\w+)?$/.test(text)) {
        var a = await this.user(String(msg.from.id));
        if (!a || a.role !== 'admin') return;
        var cfg = await this.cfg();
        cfg.reportsChatId = msg.chat.id;
        await this.s.put('cfg', cfg);
        await this.send(msg.chat.id, '✅ Сюда будут приходить отчёты курьеров.' + (msg.chat.is_forum ? ' По каждому объекту — своя тема.' : '\nСовет: включи в группе «Темы», тогда у каждого объекта будет своя тема.'));
      }
      return;
    }
    if (msg.photo || msg.video || msg.video_note || msg.document) return this.onMedia(msg);
    if (/^\/start/.test(text)) {
      var ident = { id: String(msg.from.id), name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || msg.from.username || String(msg.from.id), username: msg.from.username || null };
      var u = await this.session(ident);
      if (u.role === 'admin') return this.send(u.id, 'Привет, ' + esc(u.name) + '! Ты на складе' + (u.owner ? ' (владелец)' : '') + '.\n\nЧтобы отчёты шли в группу: добавь меня в группу админом и напиши там /reports.', this.appButton());
      if (u.role === 'courier') return this.send(u.id, 'Привет, ' + esc(u.name) + '! Рейсы и точки — в приложении.', this.appButton());
      if (u.role === 'pending') return this.send(u.id, 'Запрос отправлен Володе. Как только подтвердит — напишу.');
      return this.send(u.id, 'Доступа нет.');
    }
  };

  P.onCallback = async function (q) {
    var m = /^acc:(\d+):(courier|admin|deny)$/.exec(q.data || '');
    var answer = '';
    if (m) {
      try {
        var u = await this.setRole(String(q.from.id), m[1], m[2]);
        answer = u.role === 'removed' ? 'Отклонено' : 'Готово: ' + (u.role === 'courier' ? 'курьер' : 'склад');
        if (q.message) {
          try {
            await this.tg.call('editMessageText', { chat_id: q.message.chat.id, message_id: q.message.message_id, parse_mode: 'HTML',
              text: esc(u.name) + ' → ' + (u.role === 'removed' ? 'отклонён' : u.role === 'courier' ? 'курьер' : 'склад') });
          } catch (e) { /* сообщение уже изменено */ }
        }
      } catch (e) { answer = e.userError ? e.message : 'Ошибка'; }
    }
    try { await this.tg.call('answerCallbackQuery', { callback_query_id: q.id, text: answer }); } catch (e) { /* ignore */ }
  };

  P.updateCourier = async function (u, id, d) {
    this.mustAdmin(u);
    var c = await this.user(id);
    if (!c || c.role !== 'courier') fail('Курьер не найден', 404);
    if (d.name != null && clean(d.name, 60)) c.name = clean(d.name, 60);
    if (d.vehicle != null) c.vehicle = clean(d.vehicle, 60);
    if (d.plate != null) c.plate = clean(d.plate, 20).toUpperCase();
    if (d.phone != null) c.phone = clean(d.phone, 30);
    await this.s.put('user:' + c.id, c);
    await this.refreshPasses(c);
    return c;
  };

  /** Единая точка входа для запросов мини-приложения */
  P.op = async function (u, body) {
    var op = String(body.op || '');
    if (op === 'state') return this.state(u);
    if (u.role !== 'admin' && u.role !== 'courier') fail('Нет доступа', 403);
    switch (op) {
      case 'createOrder': return this.createOrder(u, body.order || {});
      case 'assign': return this.assign(u, body.orderId, body.courierId);
      case 'unqueue': return this.unqueue(u, body.orderId);
      case 'move': return this.move(u, body.orderId, body.dir);
      case 'cancelOrder': return this.cancelOrder(u, body.orderId);
      case 'sendTrip': return this.sendTrip(u, body.courierId);
      case 'reportStart': return this.reportStart(u, body.orderId);
      case 'problem': return this.problem(u, body.orderId, body.reason, body.comment);
      case 'setRole': return this.setRole(u.id, body.id, body.role);
      case 'updateCourier': return this.updateCourier(u, body.id, body);
      case 'myCar': return this.myCar(u, body);
    }
    fail('Неизвестное действие');
  };

  function plural(n, a, b, c) {
    var m10 = n % 10, m100 = n % 100;
    return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c;
  }
  function progress(r) {
    return '\n\nФото: ' + (r.photos ? '✅ ' + r.photos : '— нет') + '\nВидео: ' + (r.videos ? '✅ ' + r.videos : '— нет');
  }

  /** Хранилище в памяти — для демо и тестов */
  function MemoryStore(seed) {
    var m = new Map();
    if (seed) Object.keys(seed).forEach(function (k) { m.set(k, JSON.stringify(seed[k])); });
    return {
      get: async function (k) { return m.has(k) ? JSON.parse(m.get(k)) : null; },
      put: async function (k, v) { m.set(k, JSON.stringify(v)); },
      del: async function (k) { m.delete(k); },
      list: async function (prefix) {
        var out = [];
        m.forEach(function (v, k) { if (k.indexOf(prefix) === 0) out.push(JSON.parse(v)); });
        return out;
      },
      dump: function () { var o = {}; m.forEach(function (v, k) { o[k] = JSON.parse(v); }); return o; }
    };
  }

  var api = { Core: Core, MemoryStore: MemoryStore, PROBLEMS: PROBLEMS, hhmm: hhmm, dmhm: dmhm, plural: plural, projectKey: projectKey };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SKCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

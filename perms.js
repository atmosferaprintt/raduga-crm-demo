'use strict';
/* Права доступа СРМ: набор прав (галочки) и шаблоны должностей.
   Одному человеку можно дать несколько должностей и отдельные права сверху: всё складывается.
   Производственные права (цех, ОТК, выполнение заданий) действуют на участках сотрудника;
   если участки не отмечены, то на всех участках.
   Файл общий: в браузере это window.Perms, на сервере require('./public/perms.js'). */
(function (root, factory) {
  const P = factory();
  if (typeof module === 'object' && module.exports) module.exports = P;
  else root.Perms = P;
})(typeof self !== 'undefined' ? self : this, function () {
  const GROUPS = [
    { id: 'sales', name: 'Заказы и клиенты' },
    { id: 'money', name: 'Деньги' },
    { id: 'floor', name: 'Производство' },
    { id: 'stock', name: 'Склад и закупки' },
    { id: 'admin', name: 'Управление' },
  ];

  // area: право действует только на участках сотрудника
  const PERMS = [
    { key: 'orders.view', group: 'sales', label: 'Видеть заказы и клиентов', hint: 'карточки, статусы, сроки, контакты' },
    { key: 'orders.edit', group: 'sales', label: 'Вести заказы', hint: 'расчёт, КП, новые заказы, статусы, задачи' },
    { key: 'orders.all', group: 'sales', label: 'Все клиенты и заказы', hint: 'без этой галочки только свои: где он менеджер' },
    { key: 'orders.assign', group: 'sales', label: 'Распределять заказы между менеджерами' },
    { key: 'orders.delete', group: 'sales', label: 'Удалять заказы' },
    { key: 'money.price', group: 'money', label: 'Цены продажи и суммы заказов' },
    { key: 'money.cost', group: 'money', label: 'Себестоимость и маржа' },
    { key: 'price.approved', group: 'money', label: 'Менять утверждённую цену', hint: 'снимать фиксацию цены' },
    { key: 'analytics', group: 'money', label: 'Аналитика', hint: 'выручка, маржа, отчёты по менеджерам' },
    { key: 'floor.view', group: 'floor', label: 'Смотреть цех', hint: 'очереди, загрузка, журнал, план и факт' },
    { key: 'floor.manage', group: 'floor', label: 'Распределять работу в цеху', hint: 'очередь, исполнители, машины, задания', area: true },
    { key: 'floor.fix', group: 'floor', label: 'Исправлять отметки цеха', hint: 'только с причиной, исходная запись остаётся', area: true },
    { key: 'floor.work', group: 'floor', label: 'Выполнять задания', hint: 'экран «Мои задания»: начать, пауза, готово', area: true },
    { key: 'floor.qc', group: 'floor', label: 'ОТК: принимать работу', hint: 'принять или вернуть на доработку, свою работу нельзя', area: true },
    { key: 'prod.setup', group: 'floor', label: 'Справочник производства', hint: 'участки, машины, нормы, техкарты' },
    { key: 'stock.view', group: 'stock', label: 'Видеть остатки склада' },
    { key: 'stock.edit', group: 'stock', label: 'Работать со складом', hint: 'приход, выдача, списание, материалы' },
    { key: 'purchases', group: 'stock', label: 'Закупки и поставщики', hint: 'заказы поставщикам, закупочные цены' },
    { key: 'pricing.setup', group: 'admin', label: 'Прайс и калькуляторы', hint: 'настройки расчёта, доп. операции, конструктор' },
    { key: 'users', group: 'admin', label: 'Пользователи, должности и права' },
    { key: 'audit', group: 'admin', label: 'Журнал действий', hint: 'кто что менял в системе' },
    { key: 'integrations', group: 'admin', label: 'Интеграции', hint: 'Битрикс24' },
  ];
  const KEYS = PERMS.map((p) => p.key);
  const AREA_KEYS = new Set(PERMS.filter((p) => p.area).map((p) => p.key));

  /* Шаблоны должностей по документу «Роли и права ERP типографии Радуга».
     module: для этой должности в СРМ пока нет раздела, она появится вместе с ним.
     areas: участки, которые отмечаются сами при выборе должности (их можно поправить). */
  const POS_GROUPS = [
    { id: 'office', name: 'Руководство и работа с клиентами' },
    { id: 'prep', name: 'Подготовка и управление производством' },
    { id: 'shop', name: 'Производственные роли' },
    { id: 'supply', name: 'Снабжение, склад, доставка и учёт' },
  ];
  const POSITIONS = [
    { id: 'ceo', group: 'office', name: 'Генеральный директор', perms: KEYS.slice() },
    { id: 'sales_head', group: 'office', name: 'Руководитель отдела продаж',
      perms: ['orders.view', 'orders.edit', 'orders.all', 'orders.assign', 'money.price', 'money.cost', 'price.approved', 'analytics', 'floor.view', 'stock.view'] },
    { id: 'manager', group: 'office', name: 'Менеджер-технолог',
      perms: ['orders.view', 'orders.edit', 'money.price', 'money.cost', 'floor.view', 'stock.view'] },
    { id: 'service', group: 'office', name: 'Специалист по клиентскому сервису',
      perms: ['orders.view', 'floor.view'], note: 'обращения и претензии появятся с разделом «Претензии»' },
    { id: 'marketer', group: 'office', name: 'Маркетолог', perms: [], module: 'Маркетинг: сегменты клиентов и кампании' },

    { id: 'prod_director', group: 'prep', name: 'Директор по производству',
      perms: ['orders.view', 'orders.all', 'floor.view', 'floor.manage', 'floor.fix', 'floor.qc', 'prod.setup', 'stock.view'] },
    { id: 'dispatcher', group: 'prep', name: 'Планировщик-диспетчер',
      perms: ['orders.view', 'orders.all', 'floor.view', 'floor.manage', 'floor.fix', 'stock.view'] },
    { id: 'technologist', group: 'prep', name: 'Технолог производства', perms: ['floor.view', 'prod.setup'] },
    { id: 'designer', group: 'prep', name: 'Дизайнер', perms: [], module: 'Макеты: версии и согласование с клиентом' },
    { id: 'prepress', group: 'prep', name: 'Специалист допечатной подготовки', perms: ['floor.work'], areas: ['prepress'],
      note: 'проверка макетов и история версий появятся с разделом «Макеты»' },

    { id: 'digital_printer', group: 'shop', name: 'Печатник цифровой печати', perms: ['floor.work'], areas: ['digital'] },
    { id: 'offset_printer', group: 'shop', name: 'Печатник офсетной печати', perms: ['floor.work'], areas: ['offset'] },
    { id: 'cutter', group: 'shop', name: 'Резчик', perms: ['floor.work'], areas: ['cutting'] },
    { id: 'laminator', group: 'shop', name: 'Оператор ламинации', perms: ['floor.work'], areas: ['lamination'] },
    { id: 'folder', group: 'shop', name: 'Оператор фальцовки, биговки и перфорации', perms: ['floor.work'], areas: ['finishing'] },
    { id: 'binder', group: 'shop', name: 'Оператор брошюровки и переплёта', perms: ['floor.work'], areas: ['brochure', 'bindery'] },
    { id: 'stamper', group: 'shop', name: 'Оператор тиснения', perms: ['floor.work'], areas: ['stamping'] },
    { id: 'die_cutter', group: 'shop', name: 'Оператор высечки и плоттерной резки', perms: [],
      module: 'нужен участок высечки и плоттера в справочнике производства' },
    { id: 'assembler', group: 'shop', name: 'Сборщик ручных операций', perms: ['floor.work'], areas: ['manual'] },
    { id: 'packer', group: 'shop', name: 'Упаковщик', perms: ['floor.work'], areas: ['manual'] },
    { id: 'qc', group: 'shop', name: 'Контролёр ОТК', perms: ['floor.view', 'floor.qc'] },
    { id: 'loader', group: 'shop', name: 'Грузчик', perms: [], module: 'Отгрузка и места хранения' },
    { id: 'mechanic', group: 'shop', name: 'Наладчик и механик оборудования', perms: [], module: 'Обслуживание оборудования и поломки' },

    { id: 'supply_head', group: 'supply', name: 'Руководитель снабжения', perms: ['stock.view', 'stock.edit', 'purchases', 'floor.view'] },
    { id: 'stock_head', group: 'supply', name: 'Заведующий складом', perms: ['stock.view', 'stock.edit', 'purchases'] },
    { id: 'storekeeper', group: 'supply', name: 'Кладовщик', perms: ['stock.view', 'stock.edit'] },
    { id: 'logist', group: 'supply', name: 'Логист', perms: [], module: 'Доставка: адреса, перевозчики, отгрузки' },
    { id: 'driver', group: 'supply', name: 'Водитель или курьер', perms: [], module: 'Доставка: адреса, перевозчики, отгрузки' },
    { id: 'cfo', group: 'supply', name: 'Финансовый директор', perms: ['orders.view', 'orders.all', 'money.price', 'money.cost', 'analytics'],
      note: 'платежи, долги и бюджеты появятся с разделом «Счета и оплаты»' },
    { id: 'accountant', group: 'supply', name: 'Бухгалтер', perms: [], module: 'Счета и оплаты (или выгрузка в 1С)' },
  ];

  /* Пользователи, заведённые до должностей (только роль): права как раньше */
  const LEGACY = {
    admin: { positions: ['ceo'], extra: [] },
    manager: { positions: ['manager'], extra: ['orders.all', 'stock.edit', 'purchases'] },
    master: { positions: ['prod_director'], extra: [] },
    worker: { positions: [], extra: ['floor.work'] },
  };

  const parseList = (v) => {
    if (Array.isArray(v)) return v.map(String);
    if (typeof v === 'string' && v) { try { const a = JSON.parse(v); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } }
    return [];
  };

  /* Справочник должностей с правками руководителя: сохранённые шаблоны поверх встроенных */
  function catalog(saved) {
    const own = Array.isArray(saved) ? saved : [];
    const byId = new Map(own.map((p) => [p.id, p]));
    const out = POSITIONS.map((p) => {
      const s = byId.get(p.id);
      return s ? { ...p, perms: (s.perms || []).filter((k) => KEYS.includes(k)), areas: Array.isArray(s.areas) ? s.areas : p.areas, edited: true } : { ...p };
    });
    for (const s of own) {
      if (!POSITIONS.some((p) => p.id === s.id) && s.name) {
        out.push({ id: s.id, group: s.group || 'shop', name: String(s.name), perms: (s.perms || []).filter((k) => KEYS.includes(k)),
          areas: Array.isArray(s.areas) ? s.areas : [], custom: true });
      }
    }
    return out;
  }

  /* Должности и отдельные права пользователя (с учётом старых ролей) */
  function assignment(user) {
    const hasNew = user && user.positions != null && user.positions !== '';
    if (hasNew) return { positions: parseList(user.positions), extra: parseList(user.extra_perms) };
    const l = LEGACY[(user && user.role) || 'manager'] || LEGACY.manager;
    return { positions: l.positions.slice(), extra: l.extra.slice(), legacy: true };
  }

  /* Итоговые права: { perms: [...], areas: [...] | null (все участки), titles: [...] } */
  function effective(user, saved) {
    const cat = catalog(saved);
    const a = assignment(user);
    const set = new Set();
    const titles = [];
    for (const id of a.positions) {
      const p = cat.find((x) => x.id === id);
      if (!p) continue;
      titles.push(p.name);
      for (const k of p.perms || []) set.add(k);
    }
    for (const k of a.extra) if (KEYS.includes(k)) set.add(k);
    const areas = parseList(user && user.areas);
    return { perms: KEYS.filter((k) => set.has(k)), areas: areas.length ? areas : null, titles, positions: a.positions, extra: a.extra };
  }

  /* Есть ли право; для производственных прав с areaId: на этом участке */
  function can(eff, key, areaId) {
    if (!eff || !eff.perms) return false;
    if (Array.isArray(key)) return key.some((k) => can(eff, k, areaId));
    if (!eff.perms.includes(key)) return false;
    if (areaId == null || !AREA_KEYS.has(key) || !eff.areas) return true;
    return eff.areas.includes(String(areaId));
  }

  /* Участки, на которых действует право: null = все */
  const areasFor = (eff, key) => (can(eff, key) ? eff.areas : []);

  /* Название должности для подписи под именем */
  function title(eff) {
    if (!eff) return '';
    if (eff.titles && eff.titles.length) return eff.titles.join(', ');
    if (eff.perms && eff.perms.includes('floor.work')) return 'Сотрудник цеха';
    return '';
  }

  return { GROUPS, PERMS, KEYS, AREA_KEYS, POS_GROUPS, POSITIONS, LEGACY, catalog, assignment, effective, can, areasFor, title, parseList };
});

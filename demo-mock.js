/* ДЕМО-РЕЖИМ: сервера нет, все данные — условные заглушки в браузере.
   Цены справочников рандомизированы и НЕ являются реальными ценами типографии. */
(function () {
  'use strict';

  /* ---------- условная конфигурация цен ---------- */
  let seed = 20260715;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const scale = () => 0.82 + rnd() * 0.5; // ×0.82…1.32

  let cfg = JSON.parse(JSON.stringify(window.DEMO_PRICING.defaults));
  cfg.currency = { materials: 95, works: 75 };
  const moneySubtrees = ['blockPapers', 'coverPapers', 'bindingMaterials', 'binderBoard',
    'print', 'postpress', 'binding', 'uv', 'plotter', 'sheetPapers'];
  const skipKeys = new Set(['thickness', 'unit', 'size', 'machines', 'press', 'formats',
    'hooksPerSide', 'springs', 'colorFactors', 'minBatch', 'area', 'kDigital', 'kLam',
    'printedArea', 'blankArea', 'knifeLife', 'wireSpoolUseFactor']);
  function scaleTree(node, key) {
    if (skipKeys.has(key)) return node;
    if (typeof node === 'number') return Math.round(node * scale() * 1e6) / 1e6;
    if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) node[k] = scaleTree(node[k], k);
    }
    return node;
  }
  for (const k of moneySubtrees) if (cfg[k]) cfg[k] = scaleTree(cfg[k], k);

  /* ---------- реальный прайс по паролю ----------
     В pricing-real.enc.js лежит справочник, зашифрованный AES-256-GCM.
     Правильный пароль при входе расшифровывает его прямо в браузере;
     без пароля работают условные (искажённые) цены. */
  const isReal = () => sessionStorage.getItem('demo_real_cfg') != null;
  if (isReal()) {
    try { cfg = JSON.parse(sessionStorage.getItem('demo_real_cfg')); } catch (e) {}
  }

  async function tryUnlockReal(password) {
    try {
      const B = window.PRICING_REAL_ENC;
      if (!B || !password || !window.crypto || !crypto.subtle) return null;
      const un64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      const keyMat = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
      const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: un64(B.salt), iterations: B.iter, hash: 'SHA-256' },
        keyMat, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: un64(B.iv) }, key, un64(B.data));
      return JSON.parse(new TextDecoder().decode(plain));
    } catch (e) { return null; }
  }

  const engines = window.DEMO_PRICING.engines;
  const pcommon = window.DEMO_PRICING.common;
  const pcustom = window.DEMO_PRICING.custom;

  /* ---------- доп. операции (конструктор, демо) ---------- */
  let EXTRA_OPS = [
    { id: 'op1', name: 'Упаковка в термоплёнку', calcs: null, kind: 'work', tariff: 'perItem', price: 0.1, unit: '' },
    { id: 'op2', name: 'Доставка по городу', calcs: null, kind: 'work', tariff: 'fixed', price: 12, unit: '' },
  ];

  /* ---------- кастомные калькуляторы (демо-примеры) ---------- */
  let CUSTOM_CALCS = [
    {
      key: 'c_vizitki', label: 'Визитки', mode: 'simple', discount: true,
      fields: [{ key: 'p1', label: 'Резов на тираж', type: 'number', unit: 'резов', default: 10 }],
      ops: [
        { name: 'Цифровая печать', kind: 'work', tariff: 'perItem', price: 0.05 },
        { name: 'Макет (дизайн)', kind: 'work', tariff: 'fixed', price: 10 },
        { name: 'Резка', kind: 'work', tariff: 'field', qtyField: 'p1', price: 0.5 },
        { name: 'Бумага дизайнерская', kind: 'material', tariff: 'perItem', price: 0.02 },
      ],
    },
    {
      key: 'c_listovki', label: 'Листовки (формулы)', mode: 'formula', discount: true,
      fields: [{ key: 'naliste', label: 'Изделий на листе', type: 'number', default: 8 }],
      vars: [
        { key: 'listy', label: 'Листов печати', expr: 'ОКРВВЕРХ(tiraj / naliste)' },
        { key: 'pechat', label: 'Печать, у.е.', expr: '10 + listy * 0,45' },
      ],
      outMaterials: 'listy * 0,028', outWorks: 'pechat',
    },
  ];

  function customDef(type) { return CUSTOM_CALCS.find((c) => c.key === type); }

  function applyDemoExtraOps(result, picked, type) {
    if (!result || !result.ok || !Array.isArray(picked) || !picked.length) return result;
    const resolved = [];
    for (const p of picked) {
      const op = EXTRA_OPS.find((o) => String(o.id) === String(p && p.id));
      if (!op) continue;
      if (Array.isArray(op.calcs) && op.calcs.length && !op.calcs.includes(type)) continue;
      const qty = op.tariff === 'perItem' ? (Number(result.quantity) || 0)
        : op.tariff === 'fixed' ? 1
        : Math.max(0, Number(p.qty) || 0);
      const unit = op.tariff === 'perItem' ? 'экз.' : op.tariff === 'fixed' ? 'услуга' : (op.unit || 'шт.');
      resolved.push({ name: op.name, kind: op.kind, price: op.price, unit, qty });
    }
    return pcommon.applyExtraOps(result, resolved, cfg);
  }


  /* ---------- вымышленные данные ---------- */
  const USERS = [
    { id: 1, login: 'demo', name: 'Демо-руководитель', role: 'admin', active: 1 },
    { id: 2, login: 'ivanova', name: 'Иванова А.', role: 'manager', active: 1 },
    { id: 3, login: 'petrov', name: 'Петров С.', role: 'manager', active: 1 },
    { id: 4, login: 'sidorova', name: 'Сидорова М.', role: 'manager', active: 1 },
    { id: 5, login: 'kuznecov', name: 'Кузнецов Д.', role: 'manager', active: 1 },
  ];
  const CLIENTS = [
    { id: 1, name: 'Издательство «Парус»', contact_person: 'Мария', phone: '+7 (900) 000-11-22', email: 'order@parus-demo.ru', company: 'ООО «Парус»', notes: '' },
    { id: 2, name: 'ИД «Меридиан»', contact_person: 'Олег', phone: '+7 (900) 000-33-44', email: 'print@meridian-demo.ru', company: 'ООО «Меридиан»', notes: 'Постоянный клиент' },
    { id: 3, name: '«Умные книги»', contact_person: 'Анна', phone: '+7 (900) 000-55-66', email: 'hello@smartbooks-demo.ru', company: 'ООО «Умные книги»', notes: '' },
    { id: 4, name: 'Музей «Наследие»', contact_person: 'Ирина', phone: '+7 (900) 000-77-88', email: 'shop@heritage-demo.ru', company: 'АНО «Наследие»', notes: 'Каталоги выставок' },
    { id: 5, name: 'Кофейня «Зерно»', contact_person: 'Павел', phone: '+7 (900) 000-99-00', email: 'zerno@demo.ru', company: 'ИП Демидов', notes: 'Блокноты с логотипом' },
    { id: 6, name: 'Фонд «Открытие»', contact_person: 'Светлана', phone: '+7 (900) 111-22-33', email: 'fund@demo.ru', company: 'БФ «Открытие»', notes: '' },
  ];

  const now = new Date();
  const day = 86400000;
  const iso = (d) => new Date(d).toISOString().slice(0, 10);
  const dt = (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ');

  function demoCalc(type, params) {
    try { return engines[type].calculate(params, cfg); } catch (e) { return null; }
  }
  const bookParams = (tiraj, pages) => ({
    printType: 'цифра', tiraj, format: 'A4', blockPages: pages, blockColors: 'четыре', blockPaper: 'Офсет 80',
    insertPages: 0, insertColors: 'нет', insertPaper: 'нет', endpaperColors: 'нет',
    coverPaper: 'Мелов 150', coverColors: 'четыре', lamination: '30 М 1 ст.', caseMaterial: 'нет',
    coverStamping: 'нет', coverDie: 'нет', endpaperStamping: 'нет', endpaperDie: 'нет',
    spine: 'прямой', pantones: 0, discount: 'k=0',
  });
  const brochParams = (tiraj) => ({
    printType: 'цифра', tiraj, format: 'A5', blockPages: 24, blockColors: 'четыре', blockPaper: 'Мелов 115',
    insertPages: 0, insertColors: 'нет', insertPaper: 'нет',
    coverColorsFace: 'четыре', coverColorsBack: 'нет', coverPaper: 'Мелов 250', lamination: 'Нет',
    binding: '2 скобы', sewing: 'Нет', stamping: 'нет', die: 'нет', pantones: 0, discount: 'k=0',
  });
  const nbParams = (tiraj) => ({
    tiraj, format: 'A5', blockSheets: 50, blockColorsFace: 'один', blockColorsBack: 'нет', blockPaper: 'Офсет 80',
    coverColorsFace: 'четыре', coverColorsBack: 'нет', coverPaper: 'Мелов 300 мат', coverPrintType: 'цифра',
    lamination: '30 М 1 ст.', binding: 'мет пр кор', stamping: 'нет', die: 'нет', pantones: 0, discount: 'k=0',
  });

  const ORDER_DEFS = [
    { title: 'Сборник стихов «Тихий свет», 7БЦ', type: 'books7', params: bookParams(300, 160), client: 1, mgr: 2, status: 'production', stage: 'print', due: 12 },
    { title: 'Каталог выставки, брошюра А5', type: 'brochures', params: brochParams(1000), client: 4, mgr: 3, status: 'production', stage: 'postpress', due: 6 },
    { title: 'Роман «Дальние берега», 7БЦ', type: 'books7', params: bookParams(500, 320), client: 2, mgr: 2, status: 'production', stage: 'binding', due: 9 },
    { title: 'Блокноты с логотипом, А5', type: 'notebooks', params: nbParams(200), client: 5, mgr: 4, status: 'production', stage: 'done', due: 3 },
    { title: 'Монография «История края»', type: 'books7', params: bookParams(200, 400), client: 6, mgr: 3, status: 'approval', due: 20 },
    { title: 'Детская книга «Кот и звёзды»', type: 'books7', params: bookParams(1000, 48), client: 3, mgr: 4, status: 'calc', due: 30 },
    { title: 'Методичка, брошюра на скобе', type: 'brochures', params: brochParams(300), client: 6, mgr: 5, status: 'calc', due: 14 },
    { title: 'Фотоальбом юбилейный, 7БЦ', type: 'books7', params: bookParams(150, 120), client: 4, mgr: 2, status: 'ready', due: 2 },
    { title: 'Ежедневники фирменные', type: 'notebooks', params: nbParams(500), client: 2, mgr: 5, status: 'shipped', due: -6 },
    { title: 'Сборник рассказов, переиздание', type: 'books7', params: bookParams(800, 240), client: 1, mgr: 3, status: 'shipped', due: -15 },
    { title: 'Путеводитель «Город N»', type: 'brochures', params: brochParams(2000), client: 3, mgr: 4, status: 'shipped', due: -30 },
  ];

  const ORDERS = ORDER_DEFS.map((d, i) => {
    const calc = demoCalc(d.type, d.params) || {};
    const created = now.getTime() - (40 - i * 3) * day;
    return {
      id: i + 1,
      number: `2026-${String(i + 101).padStart(4, '0')}`,
      client_id: d.client, client_name: CLIENTS.find((c) => c.id === d.client).name,
      manager_id: d.mgr, manager_name: USERS.find((u) => u.id === d.mgr).name,
      title: d.title, status: d.status, prod_stage: d.stage || '',
      product_type: d.type,
      params_json: JSON.stringify(d.params), calc_json: JSON.stringify(calc),
      price: calc.priceTotal || 0, cost: calc.cost || 0, quantity: calc.quantity || d.params.tiraj,
      due_date: iso(now.getTime() + d.due * day),
      notes: i % 3 === 0 ? 'Демо-заказ: данные условные' : '',
      created_at: dt(created), updated_at: dt(created + 2 * day),
      log: [
        { event: `Заказ создан (2026-${String(i + 101).padStart(4, '0')})`, user_name: USERS.find((u) => u.id === d.mgr).name, created_at: dt(created) },
        ...(d.status !== 'calc' ? [{ event: 'Статус: calc → ' + d.status, user_name: USERS.find((u) => u.id === d.mgr).name, created_at: dt(created + day) }] : []),
      ],
    };
  });

  let TASKS = [
    { id: 1, order_id: 1, user_id: 2, text: 'Согласовать макет обложки', due_date: iso(now.getTime() + 2 * day), done: 0 },
    { id: 2, order_id: 2, user_id: 3, text: 'Уточнить тираж у клиента', due_date: iso(now.getTime() - day), done: 0 },
    { id: 3, order_id: 5, user_id: 3, text: 'Отправить КП повторно', due_date: iso(now.getTime() + day), done: 0 },
    { id: 4, order_id: 8, user_id: 2, text: 'Позвонить: заказ готов к выдаче', due_date: iso(now.getTime()), done: 1 },
  ];
  let nextTaskId = 5, nextOrderId = ORDERS.length + 1, nextClientId = CLIENTS.length + 1;

  /* ---------- склад (остатки условные) ---------- */
  const MATERIALS = [
    ['Офсет 70', 'лист А3', 400, 500], ['Офсет 80', 'лист А3', 12500, 5000],
    ['Офсет 100', 'лист А3', 2100, 1000], ['Офсет 120', 'лист А3', 0, 0],
    ['Офсет 160', 'лист А3', 5400, 2000], ['Мелов 90', 'лист А3', 800, 0],
    ['Мелов 115', 'лист А3', 4600, 1500], ['Мелов 135', 'лист А3', 0, 0],
    ['Мелов 150', 'лист А3', 3800, 1000], ['Мелов 170', 'лист А3', 950, 500],
    ['Мелов 200', 'лист А3', 1200, 0], ['Мелов 250', 'лист А3', 700, 800],
    ['Мелов 300', 'лист А3', 500, 0], ['Картон переплётный', 'лист 100×70', 900, 200],
    ['Эфалин', 'лист А1', 120, 50], ['Балакрон', 'пог. м', 45, 20],
    ['Иск. кожа', 'пог. м', 12, 10],
  ].map(([name, unit, qty, min_qty], i) => ({
    id: i + 1, name, unit, qty, min_qty, notes: '',
    category: /^(Офсет|Мелов)/.test(name) ? 'block'
      : ['Картон переплётный', 'Эфалин', 'Балакрон', 'Иск. кожа'].includes(name) ? 'binding' : '',
    created_at: dt(now.getTime() - 60 * day),
  }));
  // Демо нового материала со склада: заготовка «новое — настроить» в справочнике
  MATERIALS.push({
    id: MATERIALS.length + 1, name: 'Крафт 90', unit: 'лист А3', qty: 500, min_qty: 100,
    notes: 'Новый материал: цены в настройках ещё не заполнены', category: 'block',
    created_at: dt(now.getTime() - day),
  });
  cfg.blockPapers['Крафт 90'] = { a2: 0, a3: 0, thickness: 0 };

  const DEMO_MAT_BLANKS = {
    block: [() => cfg.blockPapers, { a2: 0, a3: 0, thickness: 0 }],
    cover: [() => cfg.coverPapers, { a3: 0, thickness: 0 }],
    binding: [() => cfg.bindingMaterials, { price: 0, unit: '' }],
    plotter: [() => cfg.plotter.materials, { price: 0, size: '' }],
    sheet: [() => cfg.sheetPapers.fixed, 0],
    notebook: [() => cfg.notebooks.papers, { thickness: 0, a3: 0 }],
  };
  function demoEnsurePlaceholder(name, category) {
    const spec = DEMO_MAT_BLANKS[category];
    if (!spec || !name) return false;
    const dict = spec[0]();
    if (name in dict) return false;
    dict[name] = typeof spec[1] === 'object' ? { ...spec[1] } : spec[1];
    return true;
  }
  let MOVES = [
    { id: 1, material_id: 2, order_id: null, qty: 15000, reason: 'Поставка (демо)', user_name: 'Демо-руководитель', created_at: dt(now.getTime() - 20 * day) },
    { id: 2, material_id: 2, order_id: 1, qty: -2500, reason: 'Заказ № 2026-0101', user_name: 'Иванова А.', created_at: dt(now.getTime() - 5 * day) },
    { id: 3, material_id: 9, order_id: 1, qty: -420, reason: 'Заказ № 2026-0101', user_name: 'Иванова А.', created_at: dt(now.getTime() - 5 * day) },
    { id: 4, material_id: 14, order_id: 3, qty: -180, reason: 'Заказ № 2026-0103', user_name: 'Иванова А.', created_at: dt(now.getTime() - 2 * day) },
  ];
  let nextMoveId = 5, nextMaterialId = MATERIALS.length + 1;

  /* ---------- поставщики и закупки (демо) ---------- */
  let SUPPLIERS = [
    { id: 1, name: 'Бумснаб (демо)', contact_person: 'Виктор', phone: '+7 (900) 222-33-44', email: 'sale@bumsnab-demo.ru', inn: '7700000001', terms: 'Оплата по счёту, доставка 3 дня', notes: '', active: 1 },
    { id: 2, name: 'ПереплётМатериалы (демо)', contact_person: 'Ольга', phone: '+7 (900) 555-66-77', email: 'opt@pm-demo.ru', inn: '7700000002', terms: 'Предоплата 50%', notes: 'Эфалин, балакрон', active: 1 },
  ];
  let PURCHASES = [
    {
      id: 1, number: 'ЗК-2026-0011', supplier_id: 1, user_id: 1, status: 'received',
      expected_date: iso(now.getTime() - 6 * day), notes: 'Демо-закупка',
      created_at: dt(now.getTime() - 12 * day), updated_at: dt(now.getTime() - 5 * day),
      items: [
        { id: 1, purchase_id: 1, material_id: 2, qty: 15000, received_qty: 15000, price: 3.1, notes: '', material_name: 'Офсет 80', material_unit: 'лист А3' },
        { id: 2, purchase_id: 1, material_id: 9, qty: 4000, received_qty: 4000, price: 5.4, notes: '', material_name: 'Мелов 150', material_unit: 'лист А3' },
      ],
      log: [
        { event: 'Закупка создана (ЗК-2026-0011)', user_name: 'Демо-руководитель', created_at: dt(now.getTime() - 12 * day) },
        { event: 'Статус: Черновик → Заказано', user_name: 'Демо-руководитель', created_at: dt(now.getTime() - 11 * day) },
        { event: 'Приёмка: всё получено, оприходовано на склад', user_name: 'Иванова А.', created_at: dt(now.getTime() - 5 * day) },
      ],
    },
    {
      id: 2, number: 'ЗК-2026-0012', supplier_id: 2, user_id: 1, status: 'ordered',
      expected_date: iso(now.getTime() + 4 * day), notes: '',
      created_at: dt(now.getTime() - 3 * day), updated_at: dt(now.getTime() - 3 * day),
      items: [
        { id: 3, purchase_id: 2, material_id: 15, qty: 80, received_qty: 0, price: 96, notes: '', material_name: 'Эфалин', material_unit: 'лист А1' },
        { id: 4, purchase_id: 2, material_id: 16, qty: 30, received_qty: 0, price: 410, notes: '', material_name: 'Балакрон', material_unit: 'пог. м' },
      ],
      log: [
        { event: 'Закупка создана (ЗК-2026-0012)', user_name: 'Демо-руководитель', created_at: dt(now.getTime() - 3 * day) },
        { event: 'Статус: Черновик → Заказано', user_name: 'Демо-руководитель', created_at: dt(now.getTime() - 3 * day) },
      ],
    },
  ];
  let BATCHES = [
    { id: 1, material_id: 2, qty: 15000, qty_left: 12500, unit_price: 3.1, batch_no: 'П-0911', supplier_id: 1, purchase_id: 1, received_at: dt(now.getTime() - 5 * day), notes: '', supplier_name: 'Бумснаб (демо)', purchase_number: 'ЗК-2026-0011', p_id: 1 },
    { id: 2, material_id: 9, qty: 4000, qty_left: 3800, unit_price: 5.4, batch_no: 'П-0912', supplier_id: 1, purchase_id: 1, received_at: dt(now.getTime() - 5 * day), notes: '', supplier_name: 'Бумснаб (демо)', purchase_number: 'ЗК-2026-0011', p_id: 1 },
    { id: 3, material_id: 15, qty: 120, qty_left: 120, unit_price: 92, batch_no: '', supplier_id: 2, purchase_id: null, received_at: dt(now.getTime() - 40 * day), notes: 'Начальный остаток', supplier_name: 'ПереплётМатериалы (демо)', purchase_number: '', p_id: null },
  ];
  let nextSupplierId = 3;

  /* ---------- интеграции (демо) ---------- */
  const BITRIX = { webhookUrl: 'https://raduga-demo.bitrix24.ru/rest/1/demo00000000/', inKey: 'demo1234567890ключ' };
  let nextDealId = 421;

  const taskView = (t) => ({
    ...t,
    order_number: (ORDERS.find((o) => o.id === t.order_id) || {}).number || '',
    order_title: (ORDERS.find((o) => o.id === t.order_id) || {}).title || '',
    user_name: (USERS.find((u) => u.id === t.user_id) || {}).name || '',
  });

  /* ---------- сессия ---------- */
  const me = () => JSON.parse(sessionStorage.getItem('demo_user') || 'null');

  /* ---------- перехват fetch ---------- */
  const realFetch = window.fetch.bind(window);
  const J = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' },
  }));

  window.fetch = function (url, opts = {}) {
    const u = typeof url === 'string' ? url : url.url;
    if (!u.includes('/api/')) return realFetch(url, opts);
    const method = (opts.method || 'GET').toUpperCase();
    const path = u.slice(u.indexOf('/api/')).split('?')[0];
    const qs = new URLSearchParams(u.includes('?') ? u.slice(u.indexOf('?') + 1) : '');
    let body = {};
    try { body = opts.body ? JSON.parse(opts.body) : {}; } catch (e) {}

    // авторизация: любой логин/пароль; правильный пароль открывает реальные цены
    if (path === '/api/login') {
      return (async () => {
        const real = await tryUnlockReal(String(body.password || ''));
        const user = USERS.find((x) => x.login === String(body.login || '').toLowerCase()) || USERS[0];
        sessionStorage.setItem('demo_user', JSON.stringify(user));
        if (real) {
          sessionStorage.setItem('demo_real_cfg', JSON.stringify(real));
          // перезагрузка: заказы и витрины пересобираются уже на реальных ценах
          setTimeout(() => location.reload(), 150);
        }
        return await J({ user });
      })();
    }
    if (path === '/api/logout') {
      sessionStorage.removeItem('demo_user');
      const wasReal = isReal();
      sessionStorage.removeItem('demo_real_cfg');
      if (wasReal) setTimeout(() => location.reload(), 150);
      return J({});
    }
    if (path === '/api/me') return me() ? J({ user: me() }) : J({ error: 'Требуется вход' }, 401);
    if (path === '/api/me/password') return J({ ok: true });
    if (!me()) return J({ error: 'Требуется вход' }, 401);

    if (path === '/api/users' && method === 'GET') return J(USERS);
    if (path === '/api/users' && method === 'POST') return J({ error: 'В демо-версии пользователи не добавляются' }, 400);
    if (path.startsWith('/api/users/')) return J({ ok: true });

    if (path === '/api/clients' && method === 'GET') {
      const q = (qs.get('q') || '').toLowerCase();
      return J(CLIENTS.filter((c) => !q || c.name.toLowerCase().includes(q)).map((c) => ({
        ...c,
        orders_count: ORDERS.filter((o) => o.client_id === c.id && o.status !== 'cancelled').length,
        orders_total: ORDERS.filter((o) => o.client_id === c.id && o.status !== 'cancelled').reduce((s, o) => s + o.price, 0),
        created_at: dt(now.getTime() - 90 * day),
      })));
    }
    if (path === '/api/clients' && method === 'POST') {
      const c = { id: nextClientId++, name: body.name, contact_person: body.contact_person || '', phone: body.phone || '', email: body.email || '', company: body.company || '', notes: body.notes || '' };
      CLIENTS.push(c); return J({ id: c.id });
    }
    if (path.startsWith('/api/clients/')) {
      const id = Number(path.split('/')[3]);
      const c = CLIENTS.find((x) => x.id === id);
      if (method === 'PUT' && c) Object.assign(c, body);
      if (method === 'DELETE') return J({ error: 'В демо-версии удаление отключено' }, 400);
      return J({ ok: true });
    }

    // склад
    if (path === '/api/stock' && method === 'GET') {
      return J(MATERIALS.map((m) => {
        const bs = BATCHES.filter((b) => b.material_id === m.id);
        return {
          ...m,
          last_move: (MOVES.find((mv) => mv.material_id === m.id) || {}).created_at || null,
          batches_active: bs.filter((b) => b.qty_left > 0).length,
          stock_value: bs.reduce((s, b) => s + b.qty_left * b.unit_price, 0),
          last_price: (bs.find((b) => b.unit_price > 0) || {}).unit_price || null,
        };
      }));
    }
    if (path === '/api/stock' && method === 'POST') {
      if (MATERIALS.some((m) => m.name === body.name)) return J({ error: 'Материал с таким названием уже есть' }, 400);
      const m = { id: nextMaterialId++, name: body.name, unit: body.unit || 'шт.', qty: +body.qty || 0, min_qty: +body.min_qty || 0, notes: body.notes || '', category: body.category || '', created_at: dt(now) };
      MATERIALS.push(m); MATERIALS.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      const placeholder = demoEnsurePlaceholder(m.name, m.category);
      return J({ id: m.id, pricingPlaceholder: placeholder });
    }
    if (/^\/api\/stock\/\d+\/move$/.test(path) && method === 'POST') {
      const id = Number(path.split('/')[3]);
      const m = MATERIALS.find((x) => x.id === id);
      if (!m) return J({ error: 'Материал не найден' }, 404);
      const qty = +body.qty;
      if (!isFinite(qty) || qty === 0) return J({ error: 'Укажите количество (не ноль)' }, 400);
      m.qty = Math.round((m.qty + qty) * 100) / 100;
      MOVES.unshift({ id: nextMoveId++, material_id: id, order_id: body.order_id || null, qty, reason: body.reason || '', user_name: me().name, created_at: dt(now) });
      if (body.order_id) {
        const o = ORDERS.find((x) => x.id === body.order_id);
        if (o) o.log.push({ event: `Склад: ${qty > 0 ? 'возврат' : 'списание'} «${m.name}» ${Math.abs(qty)} ${m.unit}`, user_name: me().name, created_at: dt(now) });
      }
      return J({ ok: true, qty: m.qty });
    }
    if (/^\/api\/stock\/\d+\/moves$/.test(path)) {
      const id = Number(path.split('/')[3]);
      return J(MOVES.filter((mv) => mv.material_id === id).map((mv) => ({
        ...mv, order_number: (ORDERS.find((o) => o.id === mv.order_id) || {}).number || '',
      })));
    }
    if (/^\/api\/stock\/\d+$/.test(path)) {
      const id = Number(path.split('/')[3]);
      const m = MATERIALS.find((x) => x.id === id);
      if (method === 'PUT' && m) {
        for (const k of ['name', 'unit', 'min_qty', 'notes', 'category']) if (body[k] != null) m[k] = k === 'min_qty' ? +body[k] : body[k];
        demoEnsurePlaceholder(m.name, m.category);
        return J({ ok: true });
      }
      if (method === 'DELETE') return J({ error: 'В демо-версии удаление отключено' }, 400);
      return J({ ok: true });
    }

    // поставщики и закупки (демо: просмотр + добавление поставщика)
    if (path === '/api/suppliers' && method === 'GET') {
      return J(SUPPLIERS.map((s) => ({
        ...s,
        purchases_count: PURCHASES.filter((p) => p.supplier_id === s.id && !['draft', 'cancelled'].includes(p.status)).length,
        purchases_total: PURCHASES.filter((p) => p.supplier_id === s.id && !['draft', 'cancelled'].includes(p.status))
          .reduce((sum, p) => sum + p.items.reduce((x, i) => x + (p.status === 'ordered' ? i.qty : i.received_qty) * i.price, 0), 0),
      })));
    }
    if (path === '/api/suppliers' && method === 'POST') {
      const s = { id: nextSupplierId++, name: body.name || 'Поставщик', contact_person: body.contact_person || '', phone: body.phone || '', email: body.email || '', inn: body.inn || '', terms: body.terms || '', notes: body.notes || '', active: 1 };
      SUPPLIERS.push(s); return J({ id: s.id });
    }
    if (path.startsWith('/api/suppliers/')) {
      const id = Number(path.split('/')[3]);
      const s = SUPPLIERS.find((x) => x.id === id);
      if (method === 'PUT' && s) { Object.assign(s, body, { active: body.active != null ? (body.active ? 1 : 0) : s.active }); return J({ ok: true }); }
      if (method === 'DELETE') return J({ error: 'В демо-версии удаление отключено' }, 400);
      return J({ ok: true });
    }
    if (path === '/api/purchases' && method === 'GET') {
      let list = PURCHASES.slice();
      if (qs.get('status')) list = list.filter((p) => p.status === qs.get('status'));
      if (qs.get('supplier_id')) list = list.filter((p) => String(p.supplier_id) === qs.get('supplier_id'));
      return J(list.map((p) => ({
        ...p,
        supplier_name: (SUPPLIERS.find((s) => s.id === p.supplier_id) || {}).name || '',
        user_name: 'Демо-руководитель',
        items_count: p.items.length,
        total: p.items.reduce((s, i) => s + i.qty * i.price, 0),
      })));
    }
    if (path === '/api/purchases' && method === 'POST') return J({ error: 'В демо-версии закупки только для просмотра' }, 400);
    if (/^\/api\/purchases\/\d+\/receive$/.test(path)) return J({ error: 'В демо-версии приёмка отключена' }, 400);
    if (path.startsWith('/api/purchases/')) {
      const id = Number(path.split('/')[3]);
      const p = PURCHASES.find((x) => x.id === id);
      if (!p) return J({ error: 'Закупка не найдена' }, 404);
      if (method === 'GET') {
        const s = SUPPLIERS.find((x) => x.id === p.supplier_id) || {};
        return J({
          ...p, supplier_name: s.name || '', supplier_contact: s.contact_person || '', supplier_phone: s.phone || '',
          supplier_email: s.email || '', supplier_inn: s.inn || '', supplier_terms: s.terms || '', user_name: 'Демо-руководитель',
        });
      }
      return J({ error: 'В демо-версии закупки только для просмотра' }, 400);
    }
    if (/^\/api\/stock\/\d+\/batches$/.test(path)) {
      const id = Number(path.split('/')[3]);
      return J(BATCHES.filter((b) => b.material_id === id));
    }

    // интеграции (демо: Битрикс24 «подключён», сделки создаются понарошку)
    if (path === '/api/integrations' && method === 'GET') return J({ bitrix24: { ...BITRIX, configured: true } });
    if (path === '/api/integrations' && method === 'PUT') {
      if (body.bitrix24 && body.bitrix24.webhookUrl != null) BITRIX.webhookUrl = body.bitrix24.webhookUrl;
      return J({ bitrix24: BITRIX });
    }
    if (/^\/api\/orders\/\d+\/bitrix$/.test(path) && method === 'POST') {
      const id = Number(path.split('/')[3]);
      const o = ORDERS.find((x) => x.id === id);
      if (!o) return J({ error: 'Заказ не найден' }, 404);
      const dealId = nextDealId++;
      o.log.push({ event: `Отправлен в Битрикс24 (сделка #${dealId}, демо)`, user_name: me().name, created_at: dt(now) });
      return J({ ok: true, dealId });
    }

    if (path === '/api/orders' && method === 'GET') {
      let list = ORDERS.slice();
      if (qs.get('status')) list = list.filter((o) => o.status === qs.get('status'));
      if (qs.get('manager_id')) list = list.filter((o) => String(o.manager_id) === qs.get('manager_id'));
      if (qs.get('client_id')) list = list.filter((o) => String(o.client_id) === qs.get('client_id'));
      if (qs.get('q')) {
        const q = qs.get('q').toLowerCase();
        list = list.filter((o) => (o.number + o.title + o.client_name).toLowerCase().includes(q));
      }
      return J(list.slice().sort((a, b) => b.created_at < a.created_at ? -1 : 1));
    }
    if (path === '/api/orders' && method === 'POST') {
      const id = nextOrderId++;
      const o = {
        id, number: `2026-${String(id + 100).padStart(4, '0')}`,
        client_id: body.client_id || null,
        client_name: (CLIENTS.find((c) => c.id === body.client_id) || {}).name || '',
        manager_id: body.manager_id || me().id,
        manager_name: (USERS.find((x) => x.id === (body.manager_id || me().id)) || {}).name || '',
        title: body.title || '', status: body.status || 'calc', prod_stage: '',
        product_type: body.product_type || '',
        params_json: JSON.stringify(body.params || {}), calc_json: JSON.stringify(body.calc || {}),
        price: body.price || 0, cost: body.cost || 0, quantity: body.quantity || 0,
        due_date: body.due_date || '', notes: body.notes || '',
        created_at: dt(now), updated_at: dt(now),
        log: [{ event: 'Заказ создан (демо)', user_name: me().name, created_at: dt(now) }],
      };
      ORDERS.unshift(o);
      return J({ id, number: o.number });
    }
    if (path.startsWith('/api/orders/')) {
      const id = Number(path.split('/')[3]);
      const o = ORDERS.find((x) => x.id === id);
      if (!o) return J({ error: 'Заказ не найден' }, 404);
      if (method === 'GET') return J({ ...o, tasks: TASKS.filter((t) => t.order_id === id).map(taskView) });
      if (method === 'PUT') {
        if (body.status && body.status !== o.status) {
          o.log.push({ event: `Статус: ${o.status} → ${body.status}`, user_name: me().name, created_at: dt(now) });
          if (body.status === 'production' && !o.prod_stage) o.prod_stage = 'print';
        }
        if (body.prod_stage != null && body.prod_stage !== o.prod_stage) {
          o.log.push({ event: `Производство: этап → ${body.prod_stage || '—'}`, user_name: me().name, created_at: dt(now) });
        }
        for (const k of ['client_id', 'manager_id', 'title', 'status', 'product_type', 'price', 'cost', 'quantity', 'due_date', 'notes', 'prod_stage']) {
          if (body[k] != null) o[k] = body[k];
        }
        if (body.params) o.params_json = JSON.stringify(body.params);
        if (body.calc) o.calc_json = JSON.stringify(body.calc);
        o.client_name = (CLIENTS.find((c) => c.id === o.client_id) || {}).name || '';
        o.manager_name = (USERS.find((x) => x.id === o.manager_id) || {}).name || '';
        o.updated_at = dt(now);
        return J({ ok: true });
      }
      if (method === 'DELETE') return J({ error: 'В демо-версии удаление отключено' }, 400);
    }

    if (path === '/api/tasks' && method === 'GET') {
      let list = TASKS.slice();
      if (qs.get('mine') === '1') list = list.filter((t) => t.user_id === me().id);
      if (qs.get('open') === '1') list = list.filter((t) => !t.done);
      return J(list.map(taskView));
    }
    if (path === '/api/tasks' && method === 'POST') {
      const t = { id: nextTaskId++, order_id: body.order_id || null, user_id: body.user_id || me().id, text: body.text, due_date: body.due_date || '', done: 0 };
      TASKS.push(t); return J({ id: t.id });
    }
    if (path.startsWith('/api/tasks/')) {
      const id = Number(path.split('/')[3]);
      const t = TASKS.find((x) => x.id === id);
      if (method === 'PUT' && t) { for (const k of ['text', 'due_date', 'done', 'user_id']) if (body[k] != null) t[k] = body[k]; }
      if (method === 'DELETE') TASKS = TASKS.filter((x) => x.id !== id);
      return J({ ok: true });
    }

    if (path === '/api/pricing/schema') {
      return J({ types: [
        ...Object.entries(engines).map(([key, e]) => ({ key, label: e.label, fields: e.schema(cfg) })),
        ...CUSTOM_CALCS.map((def) => ({ key: def.key, label: def.label, fields: pcustom.fieldsSchema(def, cfg), custom: true })),
      ] });
    }
    if (path === '/api/pricing/config' && method === 'GET') return J(cfg);
    if (path === '/api/pricing/config' && method === 'PUT') return J({ ok: true });
    if (path === '/api/pricing/config/reset') return J({ ok: true });

    // доп. операции (конструктор)
    if (path === '/api/extra-ops' && method === 'GET') return J(EXTRA_OPS);
    if (path === '/api/extra-ops' && method === 'PUT') {
      if (!Array.isArray(body)) return J({ error: 'Ожидается массив операций' }, 400);
      EXTRA_OPS = body.map((o, i) => ({ ...o, id: String(o.id || 'op' + (100 + i)) }));
      return J({ ok: true });
    }

    // конструктор калькуляторов
    if (path === '/api/custom-calcs' && method === 'GET') return J(CUSTOM_CALCS);
    if (path === '/api/custom-calcs' && method === 'PUT') {
      if (!Array.isArray(body)) return J({ error: 'Ожидается массив калькуляторов' }, 400);
      for (const def of body) {
        def.key = String(def.key || 'c' + Math.random().toString(36).slice(2, 8));
        const err = pcustom.validateDef(def);
        if (err) return J({ error: `«${def.label || def.key}»: ${err}` }, 400);
      }
      CUSTOM_CALCS = body;
      return J({ ok: true });
    }
    if (path === '/api/custom-calcs/test' && method === 'POST') {
      try {
        const err = pcustom.validateDef(body.def || {});
        if (err) return J({ error: err }, 400);
        return J(pcustom.calculate(body.def, body.params || {}, cfg));
      } catch (e) { return J({ error: e.message }, 400); }
    }

    if (path.startsWith('/api/calc/')) {
      const type = path.split('/')[3];
      try {
        const def = customDef(type);
        const result = def ? pcustom.calculate(def, body, cfg) : engines[type].calculate(body, cfg);
        return J(applyDemoExtraOps(result, body.extraOps, type));
      } catch (e) { return J({ error: e.message }, 400); }
    }

    if (path === '/api/analytics') {
      const from = qs.get('from') || '2000-01-01', to = (qs.get('to') || '2100-01-01') + ' 23:59:59';
      const list = ORDERS.filter((o) => o.status !== 'cancelled' && o.created_at >= from && o.created_at <= to);
      const group = (keyFn, labelFn) => {
        const m = new Map();
        for (const o of list) {
          const k = keyFn(o);
          if (!m.has(k)) m.set(k, { n: 0, revenue: 0, margin: 0 });
          const g = m.get(k); g.n++; g.revenue += o.price; g.margin += o.price - o.cost;
        }
        return [...m.entries()].map(([k, v]) => ({ ...labelFn(k), ...v }));
      };
      return J({
        totals: { orders: list.length, revenue: list.reduce((s, o) => s + o.price, 0), cost: list.reduce((s, o) => s + o.cost, 0) },
        byStatus: group((o) => o.status, (k) => ({ status: k })),
        byManager: group((o) => o.manager_name, (k) => ({ name: k })).sort((a, b) => b.revenue - a.revenue),
        byType: group((o) => o.product_type, (k) => ({ product_type: k })).sort((a, b) => b.revenue - a.revenue),
        byMonth: group((o) => o.created_at.slice(0, 7), (k) => ({ month: k })).sort((a, b) => a.month < b.month ? -1 : 1),
      });
    }

    return J({ error: 'Демо: не реализовано' }, 404);
  };

  /* ---------- плашка демо-режима (сверху) ---------- */
  document.addEventListener('DOMContentLoaded', () => {
    const b = document.createElement('div');
    b.id = 'demo-banner';
    if (isReal()) {
      b.innerHTML = '🔒 <b>ДЕМО С РЕАЛЬНЫМИ ЦЕНАМИ</b> (открыто по паролю). Заказы, клиенты и склад — вымышленные, ' +
        'а справочники цен настоящие. Не передавайте ссылку вместе с паролем третьим лицам.';
      b.style.cssText = 'background:#E31C79;color:#fff;text-align:center;' +
        'font:600 12.5px -apple-system,Segoe UI,Roboto,sans-serif;padding:7px 12px;letter-spacing:.02em;' +
        'border-bottom:1px solid #C4156A';
    } else {
      b.innerHTML = '⚠️ <b>ДЕМОНСТРАЦИОННАЯ ВЕРСИЯ.</b> Все данные, клиенты и цены — условные, ' +
        'заполнены по умолчанию для примера и не являются реальным прайсом типографии «Радуга». ' +
        'Вход — любой логин и пароль.';
      b.style.cssText = 'background:#DFE690;color:#111;text-align:center;' +
        'font:500 12.5px -apple-system,Segoe UI,Roboto,sans-serif;padding:7px 12px;letter-spacing:.02em;' +
        'border-bottom:1px solid #c9d167';
    }
    document.body.prepend(b);
    const style = document.createElement('style');
    style.textContent = '#sidebar { height: auto !important; min-height: 100vh; } ' +
      '@media print { #demo-banner { display: none !important; } }';
    document.head.appendChild(style);
  });
})();

/* ДЕМО: производство по операциям, должности и права прямо в браузере (сервера нет).
   Надстройка над demo-mock.js: техкарты в расчёте, задания участкам, очереди, регламент цеха
   (исполнитель, «взять в работу», причины паузы, поля результата, приёмка ОТК и доработка,
   исправления отметок с причиной), должности и права по документу типографии, «только свои» заказы,
   скрытые цены, журнал действий, план и факт, фиксация цены, перепечатки.
   Логика повторяет серверные crm/server.js и crm/floor.js; права считает общий crm/public/perms.js. */
(function () {
  'use strict';
  const PR = window.DEMO_PRICING;
  const P = window.Perms;
  const baseFetch = window.fetch;
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const r2 = (x) => Math.round(x * 100) / 100;
  const parse = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };
  const nowIso = () => new Date().toISOString();
  const dt = (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ');
  const J = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
  const base = async (method, path, body) => {
    const r = await baseFetch(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    return r.json();
  };
  const me = () => JSON.parse(sessionStorage.getItem('demo_user') || 'null');

  /* ---------- люди и должности (вымышленные) ---------- */
  const SHOP = ['prepress', 'cutting', 'lamination', 'stamping', 'brochure', 'bindery', 'finishing', 'manual'];
  const U = (id, login, name, positions, areas = [], extra = []) => ({ id, login, name, active: 1, positions, extra_perms: extra, areas });
  const DUSERS = [
    U(1, 'demo', 'Демо-руководитель', ['ceo']),
    U(2, 'ivanova', 'Иванова А.', ['manager']),
    U(3, 'petrov', 'Петров С.', ['sales_head']),
    U(4, 'sidorova', 'Сидорова М.', ['manager']),
    U(5, 'kuznecov', 'Кузнецов Д.', ['manager']),
    U(6, 'master', 'Сидоров В.', ['prod_director']),
    U(7, 'pechatnik', 'Иванов П.', ['offset_printer', 'digital_printer'], ['offset', 'digital']),
    U(8, 'pereplet', 'Петрова А.', ['binder', 'cutter', 'folder', 'laminator', 'stamper', 'assembler', 'packer', 'prepress'], SHOP),
    U(9, 'otk', 'Орлова Н.', ['qc']),
    U(10, 'sklad', 'Ким Д.', ['storekeeper']),
  ];
  let POS_SAVED = [];
  let seqUser = 20;
  const effOf = (u) => P.effective(u, POS_SAVED);
  const can = (u, key, areaId) => !!u && P.can(effOf(u), key, areaId);
  const userById = (id) => DUSERS.find((u) => u.id === id);
  const uname = (id) => (userById(id) || {}).name || '';
  const cur = () => { const s = me(); return s ? userById(s.id) || null : null; };
  function roleFromPerms(perms) {
    if (perms.includes('users')) return 'admin';
    if (perms.includes('floor.manage')) return 'master';
    if (perms.length && perms.every((k) => ['floor.work', 'floor.qc', 'floor.view'].includes(k))) return 'worker';
    return 'manager';
  }
  function pub(u) {
    const e = effOf(u);
    return { id: u.id, login: u.login, name: u.name, role: roleFromPerms(e.perms), active: u.active, areas: [...u.areas],
      positions: e.positions, extra: e.extra, perms: e.perms, title: P.title(e), legacy: false };
  }

  /* ---------- журнал действий ---------- */
  const AUDIT = [];
  let seqAudit = 1;
  function audit(by, action, details = '', at) {
    AUDIT.push({ id: seqAudit++, user_id: by, action, details: String(details).slice(0, 2000), created_at: dt(at ? Date.parse(at) : Date.now()) });
  }

  /* ---------- справочник производства: галочки ОТК у операций, причины паузы ---------- */
  const DEF = PR.productionDefaults;
  function withRegl(p) {
    p.ops = p.ops.map((o) => ({ ...o, qc: typeof o.qc === 'boolean' ? o.qc : (DEF.qcOps || []).includes(o.code) }));
    p.pauseReasons = p.pauseReasons || clone(DEF.pauseReasons || []);
    delete p.qcOps; delete p.resultFields;
    return p;
  }
  let PROD = withRegl(clone(DEF));
  const regl = () => ({ reasons: PROD.pauseReasons || [], fields: clone(DEF.resultFields || {}), qcOps: PROD.ops.filter((o) => o.qc).map((o) => o.code) });

  /* ---------- состояние цеха (в памяти вкладки) ---------- */
  let OPS = [], LOGS = [], FIXES = [], seqOp = 1, seqLog = 1, seqFix = 1;
  const META = {};        // id заказа → { price_locked, reprint_of, number }
  const EXTRA_LOG = {};   // id заказа → события производства для истории заказа
  const CLIENT_OWNER = {}; // id клиента → кто завёл
  const meta = (id) => (META[id] = META[id] || {});
  function logEvent(orderId, text, by, at) {
    (EXTRA_LOG[orderId] = EXTRA_LOG[orderId] || []).push({ event: text, user_name: uname(by || (me() || {}).id) || (me() || {}).name || '',
      created_at: dt(at ? Date.parse(at) : Date.now()) });
  }
  const opsOf = (orderId) => OPS.filter((o) => o.order_id === orderId).sort((a, b) => a.seq - b.seq);
  const hasProgress = (orderId) => OPS.some((o) => o.order_id === orderId && (o.status !== 'todo' || o.done_qty > 0))
    || LOGS.some((l) => l.order_id === orderId);
  const getOrder = (id) => base('GET', '/api/orders/' + id);
  const allOrders = () => base('GET', '/api/orders');

  function techcardOf(order) {
    const calc = parse(order.calc_json, {});
    if (calc && calc.techcard && calc.techcard.ok !== false && Array.isArray(calc.techcard.ops)) return calc.techcard;
    if (calc && calc.tech && PR.techcard.supports(order.product_type)) {
      try { return PR.techcard.build(order.product_type, calc, PROD); } catch { return null; }
    }
    return null;
  }

  async function generate(orderId, { force = false, by } = {}) {
    const order = await getOrder(orderId);
    if (!order || order.error) return { ok: false, reason: 'Заказ не найден' };
    const existing = opsOf(orderId);
    if (existing.length && !force) return { ok: true, created: 0, existing: existing.length };
    if (existing.length && hasProgress(orderId)) return { ok: false, reason: 'По заказу уже есть отметки цеха — задания не пересоздаются' };
    const tc = techcardOf(order);
    if (!tc) return { ok: false, reason: 'Для этого вида продукции техкарты пока нет' };
    const qcCodes = new Set(PROD.ops.filter((o) => o.qc).map((o) => o.code));
    OPS = OPS.filter((o) => o.order_id !== orderId);
    const basePos = Date.now() / 1000;
    tc.ops.forEach((o, i) => OPS.push({
      id: seqOp++, order_id: orderId, op_key: o.id, code: o.code || '', name: o.name, part: o.part || '', lane: o.lane || '', seq: i,
      area_id: o.areaId || '', area_name: o.areaName || '', machine_id: o.machineId || '', machine_name: o.machineName || '',
      qty: Number(o.qty) || 0, unit: o.unit || '', qty_note: o.qtyNote || '', setups: Number(o.setups) || 0,
      plan_min: o.timeMin == null ? null : o.timeMin, plan_cost: o.planCost == null ? null : o.planCost, approx: o.approx ? 1 : 0,
      after_json: JSON.stringify(o.after || []), materials_json: JSON.stringify(o.materials || []),
      note: [o.note, o.warn && '⚠ ' + o.warn].filter(Boolean).join(' · '), status: 'todo', queue_pos: basePos + i / 1000,
      done_qty: 0, started_at: null, finished_at: null,
      assignee_id: null, qc: qcCodes.has(o.code) ? 1 : 0, qc_status: '', qc_by: null, qc_at: null, qc_qty: null, qc_note: '', rework_of: null,
    }));
    logEvent(orderId, existing.length ? `Производство: задания пересозданы по техкарте (${tc.ops.length})`
      : `Производство: созданы задания участкам по техкарте (${tc.ops.length})`, by);
    return { ok: true, created: tc.ops.length };
  }

  function factMin(logs) {
    const now = Date.now();
    let ms = 0;
    for (const l of logs) ms += Math.max(0, (l.finished_at ? Date.parse(l.finished_at) : now) - Date.parse(l.started_at));
    return r2(ms / 60000);
  }
  function decorate(rows) {
    return rows.map((r) => {
      const all = opsOf(r.order_id);
      const after = parse(r.after_json, []);
      const blockedBy = after.map((k) => all.find((x) => x.op_key === k)).filter((x) => x && x.status !== 'done').map((x) => x.name);
      const logs = LOGS.filter((l) => l.op_id === r.id)
        .map((l) => ({ ...l, user_name: uname(l.user_id), extra: l.extra || {}, fixes: FIXES.filter((f) => f.log_id === l.id).length }));
      return { ...r, after, materials: parse(r.materials_json, []), approx: !!r.approx, blockedBy, logs,
        workers: [...new Set(logs.filter((l) => !l.finished_at).map((l) => l.user_name).filter(Boolean))], factMin: factMin(logs),
        assignee_name: r.assignee_id ? uname(r.assignee_id) : '', qc_by_name: r.qc_by ? uname(r.qc_by) : '',
        doers: [...new Set(logs.map((l) => l.user_id).filter(Boolean))] };
    });
  }

  async function queue({ areas = null, includeClient = true } = {}) {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const orders = new Map((await allOrders()).map((o) => [o.id, o]));
    let rows = OPS.filter((op) => { const o = orders.get(op.order_id); return o && o.status === 'production' && (op.status !== 'done' || op.finished_at >= since); });
    if (areas) rows = rows.filter((op) => areas.includes(op.area_id));
    const auto = new Set((PROD.areas || []).filter((a) => a.queue === 'auto').map((a) => a.id));
    const list = decorate(rows).map((op) => {
      const o = orders.get(op.order_id);
      const x = { ...op, order_number: (META[o.id] && META[o.id].number) || o.number, order_title: o.title, due_date: o.due_date,
        order_qty: o.quantity, product_type: o.product_type, order_created: o.created_at, order_notes: o.notes };
      if (includeClient) x.client_name = o.client_name;
      return x;
    });
    const due = (x) => x.due_date || '9999-99-99';
    list.sort((a, b) => {
      if (a.area_id !== b.area_id) return a.area_id < b.area_id ? -1 : 1;
      if (auto.has(a.area_id)) return due(a) < due(b) ? -1 : due(a) > due(b) ? 1 : a.order_created < b.order_created ? -1 : a.seq - b.seq;
      return a.queue_pos - b.queue_pos || a.seq - b.seq;
    });
    return list;
  }

  const getOp = (id) => OPS.find((o) => o.id === id);
  const activeOf = (uid) => LOGS.find((l) => l.user_id === uid && !l.finished_at);

  async function start(opId, workerId, { force = false, at = null, by, reassign = false } = {}) {
    const op = getOp(opId);
    if (!op) return { error: 'Задание не найдено' };
    const order = await getOrder(op.order_id);
    if (!order || order.status !== 'production') return { error: 'Заказ не в производстве' };
    if (op.status === 'done') return { error: 'Задание уже выполнено' };
    if (op.status === 'check') return { error: 'Задание выполнено и ждёт приёмки ОТК' };
    if (op.assignee_id && op.assignee_id !== workerId && !reassign) return { error: `Задание назначено другому сотруднику: ${uname(op.assignee_id)}` };
    const act = activeOf(workerId);
    if (act && act.op_id === op.id) return { error: 'Это задание уже в работе' };
    if (act) { const a = getOp(act.op_id); return { error: `Сначала завершите или поставьте на паузу текущее задание: ${a ? a.name : ''}` }; }
    const [d] = decorate([op]);
    if (d.blockedBy.length && !force) return { needConfirm: true, error: 'Ещё не закончены предыдущие операции: ' + d.blockedBy.join(', ') };
    const t = at || nowIso();
    const first = !OPS.some((o) => o.order_id === op.order_id && o.started_at);
    LOGS.push({ id: seqLog++, op_id: op.id, order_id: op.order_id, user_id: workerId, by_user_id: by || workerId,
      area_id: op.area_id, machine_id: op.machine_id, started_at: t, finished_at: null, qty: 0, scrap: 0, note: '', reason: '', extra: {} });
    op.status = 'work';
    op.started_at = op.started_at || t;
    if (!op.assignee_id || reassign) op.assignee_id = workerId; // общее задание берёт тот, кто начал
    if (first) logEvent(op.order_id, `Производство: начато (${op.name})`, workerId, t);
    return { ok: true };
  }

  function take(opId, workerId) {
    const op = getOp(opId);
    if (!op) return { error: 'Задание не найдено' };
    if (op.status === 'done' || op.status === 'check') return { error: 'Задание уже выполнено' };
    if (op.assignee_id && op.assignee_id !== workerId) return { error: `Задание уже взял: ${uname(op.assignee_id)}` };
    op.assignee_id = workerId;
    return { ok: true };
  }

  function assign(opId, assigneeId, by) {
    const op = getOp(opId);
    if (!op) return { error: 'Задание не найдено' };
    if (op.status === 'done') return { error: 'Задание уже выполнено' };
    op.assignee_id = assigneeId ? Number(assigneeId) : null;
    logEvent(op.order_id, `Производство: «${op.name}» (${op.part}) ${op.assignee_id ? '→ исполнитель ' + uname(op.assignee_id) : '→ общее задание участка'}`, by);
    return { ok: true };
  }

  async function stop(opId, workerId, { qty = 0, scrap = 0, note = '', finish = false, reason = '', extra = {}, at = null, by } = {}) {
    const op = getOp(opId);
    if (!op) return { error: 'Задание не найдено' };
    if (op.status === 'done' || op.status === 'check') return { error: 'Задание уже выполнено' };
    qty = Math.max(0, Number(qty) || 0); scrap = Math.max(0, Number(scrap) || 0);
    reason = String(reason || '').trim().slice(0, 80);
    if (!finish && !reason) return { error: 'Выберите причину паузы' };
    const ext = {};
    for (const [k, v] of Object.entries(extra && typeof extra === 'object' ? extra : {})) {
      const n = Number(String(v).replace(',', '.'));
      if (/^[a-z_]{1,20}$/.test(k) && isFinite(n) && n >= 0 && String(v).trim() !== '') ext[k] = n;
    }
    const t = at || nowIso();
    let open = LOGS.find((l) => l.op_id === op.id && l.user_id === workerId && !l.finished_at);
    if (!open && !finish) return { error: 'Это задание сейчас не в работе у этого сотрудника' };
    if (!open) {
      open = { id: seqLog++, op_id: op.id, order_id: op.order_id, user_id: workerId, by_user_id: by || workerId,
        area_id: op.area_id, machine_id: op.machine_id, started_at: t, finished_at: null, qty: 0, scrap: 0, note: '', reason: '', extra: {} };
      LOGS.push(open);
    }
    Object.assign(open, { finished_at: t, qty, scrap, note: String(note || '').slice(0, 500), reason: finish ? '' : reason, extra: ext });
    op.done_qty = r2(op.done_qty + qty);
    if (finish) {
      LOGS.filter((l) => l.op_id === op.id && !l.finished_at).forEach((l) => { l.finished_at = t; });
      Object.assign(op, { status: op.qc ? 'check' : 'done', finished_at: t, started_at: op.started_at || t });
    } else {
      op.status = LOGS.some((l) => l.op_id === op.id && !l.finished_at) ? 'work' : 'paused';
    }
    const ready = finish && !op.qc ? await syncOrder(op.order_id, by) : false;
    return { ok: true, orderReady: ready, toQc: !!(finish && op.qc) };
  }

  async function syncOrder(orderId, by) {
    const all = opsOf(orderId);
    if (!all.length || all.some((o) => o.status !== 'done')) return false;
    const order = await getOrder(orderId);
    if (!order || order.status !== 'production') return false;
    await base('PUT', '/api/orders/' + orderId, { status: 'ready', prod_stage: 'done' });
    logEvent(orderId, 'Производство завершено: все задания выполнены, статус → «Готов»', by);
    return true;
  }

  /* --- ОТК --- */
  async function qcList(areas) {
    const orders = new Map((await allOrders()).map((o) => [o.id, o]));
    let rows = OPS.filter((op) => op.status === 'check' && (orders.get(op.order_id) || {}).status === 'production');
    if (areas) rows = rows.filter((op) => areas.includes(op.area_id));
    return decorate(rows).sort((a, b) => (a.finished_at < b.finished_at ? -1 : 1)).map((op) => {
      const o = orders.get(op.order_id);
      return { ...op, order_number: (META[o.id] && META[o.id].number) || o.number, order_title: o.title, due_date: o.due_date, order_notes: o.notes };
    });
  }
  const doneBy = (opId, uid) => LOGS.some((l) => l.op_id === opId && l.user_id === uid);
  async function accept(opId, by, { qty, note = '', at } = {}) {
    const op = getOp(opId);
    if (!op) return { error: 'Задание не найдено' };
    if (op.status !== 'check') return { error: 'Задание не ждёт приёмки' };
    if (doneBy(op.id, by)) return { error: 'Свою работу принять нельзя: примет другой контролёр или мастер' };
    const accepted = qty == null || qty === '' ? op.done_qty : Math.max(0, Number(qty) || 0);
    Object.assign(op, { status: 'done', qc_status: 'ok', qc_by: by, qc_at: at || nowIso(), qc_qty: accepted, qc_note: String(note || '') });
    logEvent(op.order_id, `ОТК: принято «${op.name}» (${op.part}), ${r2(accepted)} ${op.unit}${note ? ': ' + note : ''}`, by, at);
    audit(by, 'ОТК: работа принята', `«${op.name}» (${op.part})${note ? ': ' + note : ''}`, at);
    return { ok: true, orderReady: await syncOrder(op.order_id, by) };
  }
  function rework(opId, by, { qty, note = '', at } = {}) {
    const op = getOp(opId);
    if (!op) return { error: 'Задание не найдено' };
    if (op.status !== 'check') return { error: 'Задание не ждёт приёмки' };
    if (doneBy(op.id, by)) return { error: 'Свою работу принять нельзя: примет другой контролёр или мастер' };
    note = String(note || '').trim();
    if (!note) return { error: 'Напишите, что не так: это увидит сотрудник' };
    const reQty = qty == null || qty === '' ? op.qty : Math.max(0, Number(qty) || 0);
    const n = OPS.filter((o) => o.rework_of === op.id).length + 1;
    const key = `${op.op_key}-r${n}`;
    const last = LOGS.filter((l) => l.op_id === op.id).slice(-1)[0];
    Object.assign(op, { status: 'done', qc_status: 'rework', qc_by: by, qc_at: at || nowIso(), qc_qty: Math.max(0, op.done_qty - reQty), qc_note: note });
    OPS.push({ ...op, id: seqOp++, op_key: key, name: 'Доработка: ' + op.name.replace(/^Доработка: /, ''), seq: op.seq + 0.5, qty: reQty,
      qty_note: '', plan_min: op.plan_min != null && op.qty > 0 ? r2(op.plan_min * reQty / op.qty) : null, plan_cost: null,
      after_json: '[]', materials_json: '[]', note: 'ОТК: ' + note, status: 'todo', queue_pos: 0, done_qty: 0, started_at: null, finished_at: null,
      assignee_id: last ? last.user_id : null, qc: 1, qc_status: '', qc_by: null, qc_at: null, qc_qty: null, qc_note: '', rework_of: op.id });
    for (const o of opsOf(op.order_id)) {
      const a = parse(o.after_json, []);
      if (a.includes(op.op_key) && !a.includes(key)) o.after_json = JSON.stringify([...a, key]);
    }
    logEvent(op.order_id, `ОТК: «${op.name}» (${op.part}) на доработку, ${r2(reQty)} ${op.unit}: ${note}`, by, at);
    audit(by, 'ОТК: возврат на доработку', `«${op.name}» (${op.part}): ${note}`, at);
    return { ok: true };
  }

  /* --- исправление отметок: только с причиной, исходное значение остаётся --- */
  function fixLog(logId, by, b = {}, at) {
    const l = LOGS.find((x) => x.id === logId);
    if (!l) return { error: 'Отметка не найдена' };
    const reason = String(b.reason || '').trim();
    if (!reason) return { error: 'Укажите причину исправления' };
    const ch = {};
    for (const f of ['started_at', 'finished_at']) {
      if (b[f] === undefined || b[f] === null || b[f] === '') continue;
      const d = new Date(b[f]);
      if (isNaN(d)) return { error: 'Неверное время' };
      if (d.toISOString() !== l[f]) ch[f] = d.toISOString();
    }
    for (const f of ['qty', 'scrap']) {
      if (b[f] === undefined || b[f] === null || b[f] === '') continue;
      const v = Math.max(0, Number(String(b[f]).replace(',', '.')) || 0);
      if (v !== l[f]) ch[f] = v;
    }
    const st = ch.started_at || l.started_at, fin = ch.finished_at || l.finished_at;
    if (fin && st > fin) return { error: 'Окончание раньше начала' };
    if (!Object.keys(ch).length) return { error: 'Ничего не изменено' };
    const t = at || nowIso();
    for (const [f, v] of Object.entries(ch)) {
      FIXES.push({ id: seqFix++, log_id: l.id, op_id: l.op_id, field: f, old_value: l[f] == null ? null : String(l[f]), new_value: String(v),
        reason: reason.slice(0, 300), by_user_id: by, created_at: dt(Date.parse(t)) });
      l[f] = v;
    }
    const op = getOp(l.op_id);
    if (op) op.done_qty = r2(LOGS.filter((x) => x.op_id === op.id).reduce((s, x) => s + (x.qty || 0), 0));
    const LBL = { started_at: 'начало', finished_at: 'окончание', qty: 'сделано', scrap: 'брак' };
    logEvent(l.order_id, `Исправлена отметка «${(op || {}).name || ''}» (${uname(l.user_id)}): ${Object.keys(ch).map((k) => LBL[k]).join(', ')}. Причина: ${reason}`, by, t);
    audit(by, 'Исправлена отметка цеха', `«${(op || {}).name || ''}», ${uname(l.user_id)}: ${Object.keys(ch).map((k) => LBL[k]).join(', ')}. Причина: ${reason}`, t);
    return { ok: true, changed: Object.keys(ch) };
  }

  async function reopen(opId, by) {
    const op = getOp(opId);
    if (!op) return { error: 'Задание не найдено' };
    if (op.status !== 'done' && op.status !== 'check') return { error: 'Задание не выполнено' };
    Object.assign(op, { status: 'paused', finished_at: null, qc_status: '', qc_by: null, qc_at: null });
    logEvent(op.order_id, `Производство: задание «${op.name}» (${op.part}) возвращено в работу`, by);
    const order = await getOrder(op.order_id);
    if (order && order.status === 'ready') await base('PUT', '/api/orders/' + op.order_id, { status: 'production' });
    return { ok: true };
  }

  function update(opId, b, by) {
    const op = getOp(opId);
    if (!op) return { error: 'Задание не найдено' };
    if (b.machine_id !== undefined && b.machine_id !== op.machine_id) {
      const m = b.machine_id ? PROD.machines.find((x) => x.id === b.machine_id) : null;
      if (b.machine_id && !m) return { error: 'Нет такой машины' };
      if (m && m.areaId !== op.area_id) return { error: 'Машина с другого участка' };
      const p = PR.techcard.replan(PROD, op.code, b.machine_id, op.qty, op.setups);
      Object.assign(op, { machine_id: p.machineId, machine_name: p.machineName, plan_min: p.timeMin, plan_cost: p.planCost, approx: p.approx ? 1 : 0 });
      logEvent(op.order_id, `Производство: «${op.name}» (${op.part}) → ${p.machineName || 'вручную'}`, by);
    }
    if (b.note !== undefined) op.note = String(b.note).slice(0, 500);
    return { ok: true };
  }

  function sessionCost(l) {
    const min = factMin([l]);
    const m = l.machine_id ? PROD.machines.find((x) => x.id === l.machine_id) : null;
    if (m && Number(m.hourRate) > 0) return r2(min / 60 * Number(m.hourRate));
    const a = PROD.areas.find((x) => x.id === l.area_id);
    if (!m && a && a.kind !== 'outsource' && Number(a.manHour) > 0) return r2(min / 60 * Number(a.manHour));
    return null;
  }

  async function journal({ from, to, userId, areaId } = {}) {
    const orders = new Map((await allOrders()).map((o) => [o.id, o]));
    return LOGS.filter((l) => (!from || l.started_at >= from) && (!to || l.started_at <= to)
      && (!userId || l.user_id === userId) && (!areaId || l.area_id === areaId))
      .sort((a, b) => (a.started_at < b.started_at ? 1 : -1))
      .map((l) => {
        const op = getOp(l.op_id) || {};
        const o = orders.get(l.order_id) || {};
        return { ...l, user_name: uname(l.user_id), by_name: uname(l.by_user_id), op_name: op.name, part: op.part, unit: op.unit, code: op.code,
          area_name: op.area_name, machine_name: op.machine_name, plan_min: op.plan_min, op_qty: op.qty,
          order_number: (META[o.id] && META[o.id].number) || o.number, order_title: o.title, minutes: factMin([l]),
          fixes: FIXES.filter((f) => f.log_id === l.id).map((f) => ({ ...f, by_name: uname(f.by_user_id) })) };
      });
  }

  async function report({ from, to } = {}) {
    const orders = new Map((await allOrders()).map((o) => [o.id, o]));
    const sessions = LOGS.filter((l) => (!from || l.started_at >= from) && (!to || l.started_at <= to));
    const done = OPS.filter((op) => op.status === 'done' && (!from || op.finished_at >= from) && (!to || op.finished_at <= to));
    const add = (m, k, init) => { if (!m.has(k)) m.set(k, init()); return m.get(k); };
    const W = new Map(), M = new Map(), O = new Map(), R = new Map();
    let factT = 0, factC = 0, planT = 0, planF = 0, planC = 0;
    for (const l of sessions) {
      const op = getOp(l.op_id) || {};
      const min = factMin([l]), c = sessionCost(l);
      factT += min; if (c) factC += c;
      const w = add(W, l.user_id, () => ({ name: uname(l.user_id) || '—', sessions: 0, factMin: 0, scrap: 0, ops: new Set() }));
      w.sessions++; w.factMin += min; w.scrap += l.scrap || 0; w.ops.add(l.op_id);
      const m = add(M, l.area_id + '|' + l.machine_id, () => ({ area: op.area_name || '', machine: op.machine_name || 'вручную', factMin: 0, factCost: 0, planMin: 0, opsDone: 0 }));
      m.factMin += min; if (c) m.factCost += c;
      if (l.reason && l.finished_at) {
        const nx = LOGS.filter((x) => x.op_id === l.op_id && x.started_at >= l.finished_at).map((x) => x.started_at).sort()[0];
        const idle = Math.max(0, ((nx ? Date.parse(nx) : Date.now()) - Date.parse(l.finished_at)) / 60000);
        const x = add(R, l.reason, () => ({ reason: l.reason, n: 0, idleMin: 0 }));
        x.n++; x.idleMin += idle;
      }
    }
    const rows = [];
    for (const op of done) {
      const logs = LOGS.filter((l) => l.op_id === op.id);
      const f = factMin(logs), fc = logs.reduce((s, l) => s + (sessionCost(l) || 0), 0);
      planT += op.plan_min || 0; planF += f; planC += op.plan_cost || 0;
      const m = add(M, op.area_id + '|' + op.machine_id, () => ({ area: op.area_name || '', machine: op.machine_name || 'вручную', factMin: 0, factCost: 0, planMin: 0, opsDone: 0 }));
      m.planMin += op.plan_min || 0; m.opsDone++;
      const o = orders.get(op.order_id) || {};
      const ok = add(O, op.order_id, () => ({ id: op.order_id, number: (META[o.id] && META[o.id].number) || o.number, title: o.title, opsDone: 0, planMin: 0, factMin: 0, planCost: 0, factCost: 0 }));
      ok.opsDone++; ok.planMin += op.plan_min || 0; ok.factMin += f; ok.planCost += op.plan_cost || 0; ok.factCost += fc;
      rows.push({ id: op.id, order_number: ok.number, name: op.name, part: op.part, area: op.area_name, machine: op.machine_name,
        planMin: op.plan_min, factMin: f, devPct: op.plan_min > 0 ? r2((f / op.plan_min - 1) * 100) : null });
    }
    const fix = (x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, typeof v === 'number' ? r2(v) : v]));
    return {
      byReason: [...R.values()].map(fix).sort((a, b) => b.idleMin - a.idleMin),
      totals: { factMin: r2(factT), factCost: r2(factC), sessions: sessions.length, opsDone: done.length, planMin: r2(planT), planFactMin: r2(planF), planCost: r2(planC) },
      byWorker: [...W.values()].map((x) => fix({ ...x, ops: x.ops.size })).sort((a, b) => b.factMin - a.factMin),
      byMachine: [...M.values()].map(fix).sort((a, b) => b.factMin - a.factMin),
      byOrder: [...O.values()].map(fix),
      deviations: rows.filter((x) => x.devPct != null).sort((a, b) => Math.abs(b.devPct) - Math.abs(a.devPct)).slice(0, 15),
    };
  }

  async function addOp(orderId, b, by) {
    const order = await getOrder(orderId);
    if (!order || order.error) return { error: 'Заказ не найден' };
    const name = String(b.name || '').trim();
    if (!name) return { error: 'Укажите операцию' };
    const area = PROD.areas.find((a) => a.id === b.area_id);
    if (!area) return { error: 'Выберите участок' };
    const machine = b.machine_id ? PROD.machines.find((m) => m.id === b.machine_id && m.areaId === area.id) : null;
    const qty = Math.max(0, Number(b.qty) || 0);
    let planMin = b.plan_min === '' || b.plan_min == null ? null : Math.max(0, Number(b.plan_min) || 0), approx = 0;
    const cat = b.code ? PROD.ops.find((o) => o.code === b.code) : null;
    if (planMin === null && cat) { const p = PR.techcard.replan(PROD, cat.code, machine ? machine.id : '', qty, 1); planMin = p.timeMin; approx = p.approx ? 1 : 0; }
    const all = opsOf(orderId);
    OPS.push({ id: seqOp++, order_id: orderId, op_key: 'x' + Date.now().toString(36), code: cat ? cat.code : '', name, part: String(b.part || 'Заказ'),
      lane: 'manual', seq: all.length ? Math.max(...all.map((o) => o.seq)) + 1 : 0, area_id: area.id, area_name: area.name,
      machine_id: machine ? machine.id : '', machine_name: machine ? machine.name : '', qty, unit: String(b.unit || 'шт.'), qty_note: '', setups: 1,
      plan_min: planMin, plan_cost: b.plan_cost === '' || b.plan_cost == null ? null : Math.max(0, Number(b.plan_cost) || 0), approx,
      after_json: JSON.stringify(b.after_key && all.some((o) => o.op_key === b.after_key) ? [b.after_key] : []), materials_json: '[]',
      note: String(b.note || ''), status: 'todo', queue_pos: Date.now() / 1000, done_qty: 0, started_at: null, finished_at: null,
      assignee_id: null, qc: 0, qc_status: '', qc_by: null, qc_at: null, qc_qty: null, qc_note: '', rework_of: null });
    if (order.status === 'ready') await base('PUT', '/api/orders/' + orderId, { status: 'production' });
    logEvent(orderId, `Производство: добавлено задание «${name}» (${area.name}${area.kind === 'outsource' ? ', подряд' : ''})`, by);
    return { ok: true };
  }

  async function removeOp(opId, by) {
    const op = getOp(opId);
    if (!op) return { error: 'Задание не найдено' };
    if (op.status !== 'todo' || LOGS.some((l) => l.op_id === op.id)) return { error: 'По заданию уже есть отметки — удалить нельзя' };
    const own = parse(op.after_json, []);
    for (const o of opsOf(op.order_id)) {
      const a = parse(o.after_json, []);
      if (a.includes(op.op_key)) o.after_json = JSON.stringify([...new Set([...a.filter((k) => k !== op.op_key), ...own])]);
    }
    OPS = OPS.filter((o) => o.id !== op.id);
    logEvent(op.order_id, `Производство: удалено задание «${op.name}» (${op.part})`, by);
    await syncOrder(op.order_id, by);
    return { ok: true };
  }

  async function launchCheck(order) {
    const out = [];
    if (!order.client_id) out.push('Не выбран клиент');
    if (!order.due_date) out.push('Не указан срок сдачи: очередь по сроку поставит заказ в конец');
    const calc = parse(order.calc_json, {});
    for (const w of (calc && calc.warnings) || []) out.push('Расчёт: ' + w);
    const tc = techcardOf(order);
    const need = new Map();
    for (const o of (tc && tc.ops) || []) {
      if (o.warn) out.push(`${o.part}: ${o.warn}`);
      for (const m of o.materials || []) {
        const k = m.name + '|' + m.unit;
        need.set(k, { name: m.name, unit: m.unit, qty: ((need.get(k) || {}).qty || 0) + m.qty });
      }
    }
    const stock = await base('GET', '/api/stock');
    for (const n of need.values()) {
      const s = stock.find((x) => x.name === n.name);
      if (!s) out.push(`Материала «${n.name}» нет в справочнике склада`);
      else if (s.qty < n.qty) out.push(`Не хватает на складе: ${n.name} — нужно ${r2(n.qty)} ${n.unit}, есть ${r2(s.qty)}`);
    }
    return out;
  }

  // Справочник производства: проверка при сохранении (как на сервере, упрощённо)
  function cleanProd(input) {
    const num = (v, label, allowNull) => {
      if (allowNull && (v === null || v === undefined || v === '')) return null;
      const n = Number(String(v ?? 0).replace(',', '.'));
      if (!isFinite(n) || n < 0) throw new Error('Некорректное число: ' + label);
      return n;
    };
    const areas = (input.areas || []).map((a) => {
      if (!String(a.name || '').trim()) throw new Error('У участка нет названия');
      return { id: a.id || 'a_' + Math.random().toString(36).slice(2, 8), name: String(a.name).trim(), kind: a.kind === 'outsource' ? 'outsource' : 'own',
        queue: a.queue === 'auto' ? 'auto' : 'manual', manHour: num(a.manHour, a.name), note: String(a.note || '') };
    });
    if (!areas.length) throw new Error('Нужен хотя бы один участок');
    const ids = new Set(areas.map((a) => a.id));
    const dm = new Map(DEF.machines.map((m) => [m.id, m]));
    const machines = (input.machines || []).map((m) => {
      if (!String(m.name || '').trim()) throw new Error('У машины нет названия');
      if (!ids.has(m.areaId)) throw new Error(`Машина «${m.name}»: выберите участок`);
      const row = { ...m, id: m.id || 'm_' + Math.random().toString(36).slice(2, 8), a3PerSheet: Math.max(1, num(m.a3PerSheet, m.name) || 1),
        setupMin: num(m.setupMin, m.name), perHour: num(m.perHour, m.name), hourRate: num(m.hourRate, m.name) };
      const d = dm.get(row.id);
      row.approx = !!(d && d.approx && d.setupMin === row.setupMin && d.perHour === row.perHour);
      return row;
    });
    const dop = new Map(DEF.ops.map((o) => [o.code, o]));
    const ops = (input.ops || []).filter((o) => dop.has(o.code)).map((o) => {
      const d = dop.get(o.code);
      const row = { ...o, setupMin: num(o.setupMin, o.name, true), perHour: num(o.perHour, o.name, true), people: Math.max(1, Math.round(num(o.people, o.name) || 1)),
        qc: typeof o.qc === 'boolean' ? o.qc : (DEF.qcOps || []).includes(o.code) };
      row.approx = !!(d.approx && d.setupMin === row.setupMin && d.perHour === row.perHour && (d.machineId || '') === (row.machineId || ''));
      return row;
    });
    for (const d of DEF.ops) if (!ops.some((o) => o.code === d.code)) ops.push({ ...clone(d), qc: (DEF.qcOps || []).includes(d.code) });
    const pct = num((input.waste || {}).digitalPct ?? DEF.waste.digitalPct, 'техотход');
    const reasons = (input.pauseReasons || []).map((r) => String(r || '').trim()).filter(Boolean);
    return { waste: { digitalPct: pct, approx: pct === DEF.waste.digitalPct }, areas, machines, ops,
      pauseReasons: reasons.length ? [...new Set(reasons)] : clone(DEF.pauseReasons || []) };
  }

  /* ---------- деньги и «только свои» ---------- */
  function stripTechcard(tc, price, cost) {
    if (!tc || (price && cost)) return tc;
    const x = clone(tc);
    for (const o of x.ops || []) { if (!price) { delete o.priceRub; delete o.priceNote; } if (!cost) delete o.planCost; }
    for (const a of x.areas || []) if (!cost) delete a.planCost;
    if (x.totals) {
      if (!price) for (const k of ['priceOps', 'priceMaterials', 'priceTotal', 'diff']) delete x.totals[k];
      if (!cost) { delete x.totals.planCost; delete x.totals.planCostComplete; }
    }
    return x;
  }
  function orderOut(o, u) {
    const price = can(u, 'money.price'), cost = can(u, 'money.cost');
    if (price && cost) return o;
    const x = { ...o };
    if (!price) { delete x.price; x.money_hidden = 1; }
    if (!cost) delete x.cost;
    if (x.calc_json) {
      const calc = parse(x.calc_json, {});
      x.calc_json = JSON.stringify(!price
        ? (calc.techcard ? { techcard: stripTechcard(calc.techcard, price, cost), hidden: true } : { hidden: true })
        : { ...calc, cost: undefined, techcard: stripTechcard(calc.techcard, price, cost) });
    }
    if (Array.isArray(x.ops) && !cost) x.ops = x.ops.map(({ plan_cost, ...r }) => r);
    return x;
  }
  const orderAllowed = (u, o) => can(u, 'orders.all') || (o && o.manager_id === u.id);
  const stripOp = (u) => (o) => {
    const x = { ...o };
    if (!can(u, 'money.cost')) delete x.plan_cost;
    if (!can(u, 'orders.view')) delete x.client_name;
    return x;
  };

  // Какие права нужны на запрос (как на сервере); первое совпадение решает
  const RULES = [
    ['GET', /^\/api\/users$/, ['users', 'orders.view', 'floor.view', 'floor.manage', 'floor.qc', 'stock.view', 'purchases']],
    ['*', /^\/api\/users/, 'users'], ['*', /^\/api\/positions$/, 'users'], ['GET', /^\/api\/audit$/, 'audit'],
    ['GET', /^\/api\/clients/, 'orders.view'], ['*', /^\/api\/clients/, 'orders.edit'],
    ['GET', /^\/api\/orders(\/\d+)?$/, 'orders.view'], ['POST', /^\/api\/orders$/, 'orders.edit'],
    ['PUT', /^\/api\/orders\/\d+$/, ['orders.edit', 'floor.manage']], ['DELETE', /^\/api\/orders\/\d+$/, 'orders.delete'],
    ['POST', /^\/api\/orders\/\d+\/ops(\/generate)?$/, 'floor.manage'], ['POST', /^\/api\/orders\/\d+\//, 'orders.edit'],
    ['*', /^\/api\/tasks/, 'orders.view'],
    ['GET', /^\/api\/stock$/, ['stock.view', 'orders.edit']], ['GET', /^\/api\/stock\//, 'stock.view'], ['*', /^\/api\/stock/, 'stock.edit'],
    ['POST', /^\/api\/purchases\/\d+\/receive$/, ['purchases', 'stock.edit']], ['*', /^\/api\/(purchases|suppliers)/, 'purchases'],
    ['PUT', /^\/api\/integrations$/, 'integrations'],
    ['GET', /^\/api\/pricing\/config$/, ['orders.edit', 'pricing.setup']], ['*', /^\/api\/pricing\/config/, 'pricing.setup'],
    ['POST', /^\/api\/calc\//, ['orders.edit', 'pricing.setup']],
    ['GET', /^\/api\/(extra-ops|custom-calcs)$/, ['orders.edit', 'pricing.setup']], ['*', /^\/api\/(extra-ops|custom-calcs)/, 'pricing.setup'],
    ['*', /^\/api\/production/, 'prod.setup'],
    ['GET', /^\/api\/floor\/workers$/, ['floor.view', 'floor.manage', 'floor.qc', 'floor.fix']],
    ['GET', /^\/api\/floor\/queue$/, ['floor.view', 'floor.manage']], ['GET', /^\/api\/floor\/work$/, ['floor.work', 'floor.manage']],
    ['POST', /^\/api\/floor\/ops\/\d+\/(start|pause|finish)$/, ['floor.work', 'floor.manage']],
    ['POST', /^\/api\/floor\/ops\/\d+\/take$/, 'floor.work'], ['POST', /^\/api\/floor\/ops\/\d+\/(accept|rework)$/, 'floor.qc'],
    ['POST', /^\/api\/floor\/ops\/\d+\/(assign|reopen)$/, 'floor.manage'], ['*', /^\/api\/floor\/ops\/\d+$/, 'floor.manage'],
    ['POST', /^\/api\/floor\/reorder$/, 'floor.manage'], ['GET', /^\/api\/floor\/report$/, 'floor.view'],
    ['GET', /^\/api\/floor\/catalog$/, 'floor.manage'], ['GET', /^\/api\/floor\/journal$/, ['floor.view', 'floor.fix']],
    ['POST', /^\/api\/floor\/log\/\d+\/fix$/, 'floor.fix'], ['GET', /^\/api\/floor\/qc$/, 'floor.qc'],
    ['GET', /^\/api\/analytics/, 'analytics'],
  ];
  const needPerm = (method, path) => { const r = RULES.find(([m, re]) => (m === '*' || m === method) && re.test(path)); return r ? r[2] : null; };

  /* ---------- пользователи: должности, отдельные права, участки ---------- */
  function cleanAssignment(b, prev) {
    const cat = P.catalog(POS_SAVED);
    const positions = b.positions !== undefined ? P.parseList(b.positions).filter((id) => cat.some((p) => p.id === id && !p.module)) : prev.positions;
    const extra = b.extra !== undefined ? P.parseList(b.extra).filter((k) => P.KEYS.includes(k)) : prev.extra;
    const areas = b.areas !== undefined ? P.parseList(b.areas) : prev.areas;
    return { positions, extra, areas, eff: P.effective({ positions, extra_perms: extra, areas }, POS_SAVED) };
  }
  function describe(a) {
    const area = (id) => ((PROD.areas || []).find((x) => x.id === id) || {}).name || id;
    const lbl = (k) => (P.PERMS.find((p) => p.key === k) || {}).label || k;
    return [a.eff.titles.join(', ') || 'без должности', a.extra.length ? 'отдельно: ' + a.extra.map(lbl).join(', ') : '',
      a.areas.length ? 'участки: ' + a.areas.map(area).join(', ') : ''].filter(Boolean).join('; ');
  }

  /* ---------- стартовые данные: заказы в цеху уже с заданиями, отметками, приёмкой ОТК ---------- */
  // создаются при первом запросе после входа: до входа демо-сервер отвечает «требуется вход»
  let readyP = null;
  const ensureReady = () => readyP || (readyP = (async () => {
    const orders = await allOrders();
    if (!Array.isArray(orders)) { readyP = null; return; }
    const H = 3600 * 1000, ago = (h) => new Date(Date.now() - h * H).toISOString();
    const MASTER = 6, QC = 9, PRINT = 7, BIND = 8;
    audit(1, 'Изменены должности', 'Должности по документу «Роли и права ERP типографии Радуга» заведены в СРМ', ago(50));
    for (const u of DUSERS.filter((x) => x.id > 1)) {
      audit(1, 'Пользователь создан', `${u.name} (${u.login}): ${describe(cleanAssignment({}, { positions: u.positions, extra: u.extra_perms, areas: u.areas }))}`, ago(49));
    }
    const prodOrders = orders.filter((o) => o.status === 'production' && PR.techcard.supports(o.product_type));
    // один заказ печатаем офсетом, чтобы в очередях были RMGT 794 и RYOBI 784
    const big = prodOrders.find((o) => o.product_type === 'books7' && o.quantity >= 500);
    if (big) {
      const params = { ...parse(big.params_json, {}), printType: 'офсет' };
      const calc = await base('POST', '/api/calc/books7', params);
      if (calc && calc.ok) await base('PUT', '/api/orders/' + big.id, { params, calc, price: calc.priceTotal, cost: calc.cost });
    }
    for (const o of prodOrders) await generate(o.id, { by: MASTER });
    if (big) {
      const bops = opsOf(big.id);
      const ryobi = bops.find((x) => x.code === 'print_offset' && x.part === 'Обложка');
      if (ryobi) update(ryobi.id, { machine_id: 'ryobi784' }, MASTER);
      // мастер распределил офсет на печатника
      for (const op of bops.filter((x) => x.area_id === 'offset')) assign(op.id, PRINT, MASTER);
    }
    // история работы: вчера и сегодня, с реальной длительностью смен
    let shift = 30;
    const workerFor = (op) => (DUSERS[6].areas.includes(op.area_id) ? PRINT : BIND);
    async function doneOp(op, hours, { qc = true } = {}) {
      hours = Math.min(5, Math.max(0.25, hours));
      if (shift - hours < 1) shift = hours + 1.5;
      const s = ago(shift), f = ago(shift - hours);
      const w = workerFor(op);
      await start(op.id, w, { force: true, at: s, by: w });
      const extra = op.code === 'print_digital' ? { clicks: Math.round(op.qty * 1.01), paper: Math.ceil(op.qty * 1.03) } : {};
      await stop(op.id, w, { qty: op.qty, scrap: op.code === 'print_digital' ? 2 : 0, finish: true, at: f, by: w, extra });
      if (op.status === 'check' && qc) await accept(op.id, QC, { at: ago(shift - hours - 0.3) });
      shift -= hours + 0.2;
    }
    if (prodOrders[0]) {
      const ops = opsOf(prodOrders[0].id);
      for (const code of ['layout', 'cut_paper']) for (const op of ops.filter((x) => x.code === code)) await doneOp(op, Math.max(0.3, (op.plan_min || 30) / 60 * 1.15));
      const pr = ops.find((x) => x.code.startsWith('print') && x.part === 'Блок');
      if (pr) await doneOp(pr, Math.max(0.5, (pr.plan_min || 60) / 60 * 0.9));
      // мастер исправил отметку: переплётчица забыла вовремя нажать «готово»
      const lay = LOGS.find((l) => (getOp(l.op_id) || {}).code === 'layout' && l.order_id === prodOrders[0].id);
      if (lay) {
        const cut = Math.max(4, Math.round((Date.parse(lay.finished_at) - Date.parse(lay.started_at)) / 60000 / 3));
        fixLog(lay.id, MASTER, { finished_at: new Date(Date.parse(lay.finished_at) - cut * 60000).toISOString(),
          reason: `Забыла сразу нажать «готово»: закончила на ${cut} мин раньше` }, ago(20));
      }
      const fold = ops.find((x) => x.code === 'fold');
      if (fold) await start(fold.id, BIND, { force: true, at: ago(0.7), by: BIND });
    }
    if (prodOrders[1]) {
      const ops = opsOf(prodOrders[1].id);
      shift = 26;
      for (const op of ops.filter((x) => ['layout', 'cut_paper'].includes(x.code))) await doneOp(op, Math.max(0.3, (op.plan_min || 30) / 60 * 1.3));
      // блок напечатан и ждёт приёмки ОТК
      const pr = ops.find((x) => x.code.startsWith('print') && x.part === 'Блок');
      if (pr) await doneOp(pr, Math.max(0.5, (pr.plan_min || 60) / 60), { qc: false });
      // обложка: была пауза из-за бумаги, сейчас снова в работе
      const cov = ops.find((x) => x.code.startsWith('print') && x.part !== 'Блок');
      if (cov) {
        await start(cov.id, PRINT, { force: true, at: ago(3), by: PRINT });
        await stop(cov.id, PRINT, { qty: Math.round(cov.qty / 3), reason: 'Нет бумаги или материала', at: ago(2.6), by: PRINT });
        await start(cov.id, PRINT, { force: true, at: ago(1.1), by: PRINT });
      }
    }
  })());

  /* ---------- перехват запросов ---------- */
  async function withOrderExtras(o) {
    const m = META[o.id] || {};
    return { ...o, number: m.number || o.number, price_locked: m.price_locked ? 1 : 0, reprint_of: m.reprint_of || null };
  }

  window.fetch = async function (url, opts = {}) {
    const u = typeof url === 'string' ? url : url.url;
    if (!u.includes('/api/')) return baseFetch(url, opts);
    const method = (opts.method || 'GET').toUpperCase();
    const path = u.slice(u.indexOf('/api/')).split('?')[0];
    const qs = new URLSearchParams(u.includes('?') ? u.slice(u.indexOf('?') + 1) : '');
    let body = {};
    try { body = opts.body ? JSON.parse(opts.body) : {}; } catch { /* пусто */ }

    // вход: любой логин из списка людей демо (пароль любой); пароль реальных цен обрабатывает demo-mock
    if (path === '/api/login') {
      const resp = await baseFetch(url, opts);
      await resp.json();
      const x = DUSERS.find((d) => d.active && d.login === String(body.login || '').trim().toLowerCase()) || DUSERS[0];
      const p = pub(x);
      sessionStorage.setItem('demo_user', JSON.stringify(p));
      return J({ user: p });
    }
    if (path === '/api/me') { const x = cur(); return x ? J({ user: pub(x) }) : J({ error: 'Требуется вход' }, 401); }
    const user = cur();
    if (!user) return baseFetch(url, opts);
    const need = needPerm(method, path);
    if (need && !can(user, need)) return J({ error: 'Нет доступа: у вашей должности нет такого права' }, 403);
    await ensureReady();
    const eff = effOf(user);
    const deny = (t) => J({ error: t || 'Это задание участка, где у вас нет прав' }, 403);
    let m;

    /* --- пользователи, должности, журнал действий --- */
    if (path === '/api/users' && method === 'GET') return J(DUSERS.map(pub));
    if (path === '/api/users' && method === 'POST') {
      const login = String(body.login || '').trim().toLowerCase(), name = String(body.name || '').trim();
      if (!login || !name || !body.password) return J({ error: 'Заполните логин, имя и пароль' }, 400);
      if (DUSERS.some((x) => x.login === login)) return J({ error: 'Такой логин уже существует' }, 400);
      const a = cleanAssignment(body, { positions: [], extra: [], areas: [] });
      const nu = { id: seqUser++, login, name, active: 1, positions: a.positions, extra_perms: a.extra, areas: a.areas };
      DUSERS.push(nu);
      audit(user.id, 'Пользователь создан', `${name} (${login}): ${describe(a)}`);
      return J({ ok: true, id: nu.id });
    }
    if ((m = path.match(/^\/api\/users\/(\d+)$/)) && method === 'PUT') {
      const x = userById(Number(m[1]));
      if (!x) return J({ error: 'Нет такого пользователя' }, 404);
      const prev = { positions: x.positions, extra: x.extra_perms, areas: x.areas };
      const a = cleanAssignment(body, prev);
      const active = body.active === undefined ? !!x.active : !!body.active;
      if (x.id === user.id && !active) return J({ error: 'Нельзя заблокировать самого себя' }, 400);
      if (x.id === user.id && !a.eff.perms.includes('users')) return J({ error: 'Нельзя снять с себя право управлять пользователями: так вы потеряете доступ к этой странице' }, 400);
      const name = String(body.name ?? x.name).trim() || x.name;
      const same = (p, q) => JSON.stringify([...p].sort()) === JSON.stringify([...q].sort());
      const changes = [];
      if (name !== x.name) changes.push(`имя: ${x.name} → ${name}`);
      if (active !== !!x.active) changes.push(active ? 'разблокирован' : 'заблокирован');
      if (!same(a.positions, prev.positions) || !same(a.extra, prev.extra) || !same(a.areas, prev.areas)) changes.push('права: ' + describe(a));
      if (body.password) changes.push('задан новый пароль');
      Object.assign(x, { name, active: active ? 1 : 0, positions: a.positions, extra_perms: a.extra, areas: a.areas });
      if (changes.length) audit(user.id, 'Пользователь изменён', `${name} (${x.login}): ${changes.join('; ')}`);
      return J({ ok: true });
    }
    if (path === '/api/positions' && method === 'GET') return J({ positions: P.catalog(POS_SAVED) });
    if (path === '/api/positions' && method === 'PUT') {
      const out = [], changed = [];
      const prev = P.catalog(POS_SAVED);
      const same = (p, q) => JSON.stringify([...(p || [])].sort()) === JSON.stringify([...(q || [])].sort());
      for (const x of Array.isArray(body.positions) ? body.positions : []) {
        const perms = P.parseList(x.perms).filter((k) => P.KEYS.includes(k));
        const areas = P.parseList(x.areas);
        const builtin = P.POSITIONS.find((y) => y.id === x.id);
        if (builtin) {
          if (builtin.module) continue;
          if (builtin.id === 'ceo' && !perms.includes('users')) return J({ error: 'У генерального директора должно остаться право «Пользователи, должности и права»' }, 400);
          if (!same(perms, builtin.perms) || !same(areas, builtin.areas)) out.push({ id: builtin.id, perms, areas });
        } else {
          const name = String(x.name || '').trim().slice(0, 80);
          if (!name) return J({ error: 'У новой должности нет названия' }, 400);
          out.push({ id: /^c_[a-z0-9]{3,20}$/.test(String(x.id || '')) ? x.id : 'c_' + Date.now().toString(36), name,
            group: P.POS_GROUPS.some((g) => g.id === x.group) ? x.group : 'shop', perms, areas, custom: true });
        }
      }
      const next = P.catalog(out);
      for (const x of next) { const was = prev.find((y) => y.id === x.id); if (!was) changed.push('новая: ' + x.name); else if (!same(was.perms, x.perms) || !same(was.areas, x.areas)) changed.push(x.name); }
      for (const x of prev) if (!next.some((y) => y.id === x.id)) changed.push('удалена: ' + x.name);
      POS_SAVED = out;
      if (changed.length) audit(user.id, 'Изменены должности', changed.join('; '));
      return J({ ok: true, positions: next });
    }
    if (path === '/api/audit') {
      const from = qs.get('from') || '', to = qs.get('to') ? qs.get('to') + ' 23:59:59' : '', uid = Number(qs.get('user_id')) || null;
      return J(AUDIT.filter((a) => (!from || a.created_at >= from) && (!to || a.created_at <= to) && (!uid || a.user_id === uid))
        .slice().sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id))
        .map((a) => ({ ...a, user_name: uname(a.user_id) })));
    }

    /* --- справочник производства --- */
    if (path === '/api/production') {
      if (method === 'GET') return J(PROD);
      try { PROD = cleanProd(body); return J({ ok: true, production: PROD }); } catch (e) { return J({ error: e.message }, 400); }
    }
    if (path === '/api/production/reset') { PROD = withRegl(clone(DEF)); return J({ ok: true }); }

    // расчёт: техкарта поверх результата
    if (path.startsWith('/api/calc/') && method === 'POST') {
      const resp = await baseFetch(url, opts);
      const data = await resp.json();
      const type = path.split('/')[3];
      if (resp.ok && data && data.ok && PR.techcard.supports(type)) {
        try { data.techcard = PR.techcard.build(type, data, PROD); } catch (e) { data.techcard = { ok: false, error: 'Техкарта не построена: ' + e.message }; }
      }
      return J(data, resp.status);
    }

    /* --- клиенты: только свои у менеджера без права «все» --- */
    if (path === '/api/clients' && method === 'GET') {
      let list = await (await baseFetch(url, opts)).json();
      if (!can(user, 'orders.all')) {
        const mine = new Set((await allOrders()).filter((o) => o.manager_id === user.id).map((o) => o.client_id));
        list = list.filter((c) => mine.has(c.id) || CLIENT_OWNER[c.id] === user.id);
        const orders = (await allOrders()).filter((o) => o.manager_id === user.id && o.status !== 'cancelled');
        list = list.map((c) => ({ ...c, orders_count: orders.filter((o) => o.client_id === c.id).length,
          orders_total: orders.filter((o) => o.client_id === c.id).reduce((s, o) => s + (o.price || 0), 0) }));
      }
      if (!can(user, 'money.price')) list = list.map(({ orders_total, ...c }) => c);
      return J(list);
    }
    if (path === '/api/clients' && method === 'POST') {
      const r = await (await baseFetch(url, opts)).json();
      if (r && r.id) CLIENT_OWNER[r.id] = user.id;
      return J(r);
    }

    /* --- склад: стоимость по закупочным ценам видят снабжение и те, кто видит себестоимость --- */
    if (path === '/api/stock' && method === 'GET' && !can(user, ['purchases', 'money.cost'])) {
      const list = await (await baseFetch(url, opts)).json();
      return J(list.map(({ stock_value, last_price, ...r }) => r));
    }
    if (/^\/api\/stock\/\d+\/batches$/.test(path) && !can(user, ['purchases', 'money.cost'])) {
      const list = await (await baseFetch(url, opts)).json();
      return J(list.map(({ unit_price, ...r }) => r));
    }
    if (path === '/api/tasks' && method === 'GET' && !can(user, 'orders.all')) {
      const list = await (await baseFetch(url, opts)).json();
      const mine = new Set((await allOrders()).filter((o) => o.manager_id === user.id).map((o) => o.id));
      return J(list.filter((t) => t.user_id === user.id || mine.has(t.order_id)));
    }

    /* --- заказы --- */
    if (path === '/api/orders' && method === 'GET') {
      let list = await (await baseFetch(url, opts)).json();
      if (!can(user, 'orders.all')) list = list.filter((o) => o.manager_id === user.id);
      return J(await Promise.all(list.map(async (o) => {
        const ops = opsOf(o.id);
        const x = await withOrderExtras(o);
        return orderOut(ops.length ? { ...x, ops_total: ops.length, ops_done: ops.filter((p) => p.status === 'done').length,
          ops_working: ops.filter((p) => p.status === 'work').length } : x, user);
      })));
    }
    if (path === '/api/orders' && method === 'POST') {
      const b = { ...body };
      if (!can(user, 'orders.assign') || !b.manager_id) b.manager_id = user.id;
      if (!can(user, 'money.price')) b.price = 0;
      if (!can(user, 'money.cost')) b.cost = 0;
      return J(await base('POST', '/api/orders', b));
    }
    if ((m = path.match(/^\/api\/orders\/(\d+)\/reprint$/)) && method === 'POST') {
      const o = await getOrder(Number(m[1]));
      if (!orderAllowed(user, o)) return J({ error: 'Это заказ другого менеджера' }, 403);
      const tiraj = Math.max(1, Math.floor(Number(body.tiraj) || o.quantity || 1));
      let params = parse(o.params_json, {}), calc = parse(o.calc_json, {});
      if (o.product_type && Number(params.tiraj) !== tiraj) {
        params = { ...params, tiraj };
        const c = await base('POST', '/api/calc/' + o.product_type, params);
        if (c && c.ok) calc = c;
      }
      const n = Object.values(META).filter((x) => x.reprint_of === o.id).length + 1;
      const number = `${(META[o.id] && META[o.id].number) || o.number}/П${n}`;
      const r = await base('POST', '/api/orders', { client_id: o.client_id, manager_id: o.manager_id, title: `Перепечатка: ${o.title || ''}`,
        status: 'calc', product_type: o.product_type, params, calc, price: 0, cost: Number(calc.cost) || 0, quantity: tiraj,
        notes: body.reason ? 'Причина перепечатки: ' + body.reason : '' });
      Object.assign(meta(r.id), { reprint_of: o.id, number });
      logEvent(r.id, `Перепечатка к заказу № ${o.number}${body.reason ? ': ' + body.reason : ''} (${tiraj} экз., клиенту бесплатно)`, user.id);
      logEvent(o.id, `Создана перепечатка № ${number} (${tiraj} экз.)`, user.id);
      return J({ id: r.id, number });
    }
    if ((m = path.match(/^\/api\/orders\/(\d+)\/ops\/generate$/)) && method === 'POST') {
      const r = await generate(Number(m[1]), { force: !!body.force, by: user.id });
      return r.ok ? J(r) : J({ error: r.reason }, 400);
    }
    if ((m = path.match(/^\/api\/orders\/(\d+)\/ops$/)) && method === 'POST') {
      if (body.area_id && !can(user, 'floor.manage', body.area_id)) return deny();
      if (!can(user, 'money.cost')) delete body.plan_cost;
      const r = await addOp(Number(m[1]), body, user.id);
      return J(r, r.error ? 400 : 200);
    }
    if ((m = path.match(/^\/api\/orders\/(\d+)$/))) {
      const id = Number(m[1]);
      if (method === 'GET') {
        const o = await getOrder(id);
        if (o.error) return J(o, 404);
        if (!orderAllowed(user, o)) return J({ error: 'Это заказ другого менеджера' }, 403);
        const x = await withOrderExtras(o);
        // техкарта в снимке расчёта: тогда на схеме маршрута видны статусы заданий
        const calc = parse(o.calc_json, {});
        if (calc && !calc.techcard && calc.tech && PR.techcard.supports(o.product_type)) {
          const tc = techcardOf(o);
          if (tc) x.calc_json = JSON.stringify({ ...calc, techcard: tc });
        }
        x.ops = decorate(opsOf(id));
        x.reprints = (await allOrders()).filter((r) => (META[r.id] || {}).reprint_of === id)
          .map((r) => ({ id: r.id, number: META[r.id].number, status: r.status, quantity: r.quantity }));
        if (x.reprint_of) { const src = await getOrder(x.reprint_of); x.reprint_of_number = (META[src.id] || {}).number || src.number; }
        x.log = [...(o.log || []), ...(EXTRA_LOG[id] || [])].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
        return J(orderOut(x, user));
      }
      if (method === 'PUT') {
        const before = await getOrder(id);
        if (!orderAllowed(user, before)) return J({ error: 'Это заказ другого менеджера' }, 403);
        if (!can(user, 'orders.edit')) {
          const keys = Object.keys(body).filter((k) => body[k] !== undefined);
          if (keys.some((k) => !['prod_stage', 'status'].includes(k)) || (body.status != null && !['ready', 'production'].includes(body.status))) {
            return J({ error: 'Менять заказ может менеджер' }, 403);
          }
        }
        if (body.manager_id != null && Number(body.manager_id || 0) !== Number(before.manager_id || 0)) {
          if (!can(user, 'orders.assign')) return J({ error: 'Передать заказ другому менеджеру может руководитель отдела продаж' }, 403);
          logEvent(id, `Менеджер заказа: ${uname(Number(body.manager_id)) || '—'}`, user.id);
          audit(user.id, 'Заказ передан другому менеджеру', `№ ${before.number} → ${uname(Number(body.manager_id)) || '—'}`);
        }
        if (!can(user, 'money.price')) { delete body.price; delete body.price_locked; }
        if (!can(user, 'money.cost')) delete body.cost;
        const mm = meta(id);
        if (mm.price_locked && !can(user, 'price.approved')) {
          if (body.price_locked != null && !body.price_locked) return J({ error: 'Цена утверждена. Снять фиксацию может руководитель с правом «Менять утверждённую цену»' }, 403);
          if (!body.calc && body.price != null && Math.abs(Number(body.price) - Number(before.price)) > 0.004) {
            return J({ error: 'Цена утверждена. Изменить её может руководитель с правом «Менять утверждённую цену»' }, 403);
          }
        }
        if (mm.price_locked && body.price_locked != null && !body.price_locked) audit(user.id, 'Снята фиксация цены', `Заказ № ${before.number}, цена ${before.price} ₽`);
        if (mm.price_locked && !body.calc && body.price != null && Math.abs(Number(body.price) - Number(before.price)) > 0.004) {
          audit(user.id, 'Изменена утверждённая цена', `Заказ № ${before.number}: ${before.price} → ${body.price} ₽`);
        }
        const locked = body.price_locked != null ? !!body.price_locked : !!mm.price_locked;
        if (body.price_locked != null && locked !== !!mm.price_locked) logEvent(id, locked ? `Цена зафиксирована: ${before.price} ₽` : 'Фиксация цены снята', user.id);
        let priceKept = false;
        if (mm.price_locked && locked && body.calc && body.price != null && Math.abs(Number(body.price) - Number(before.price)) > 0.004) {
          logEvent(id, `Пересчёт показал ${body.price} ₽, но цена зафиксирована: в заказе осталось ${before.price} ₽`, user.id);
          body.price = before.price; priceKept = true;
        }
        mm.price_locked = locked;
        const { price_locked, ...rest } = body;
        await base('PUT', '/api/orders/' + id, rest);
        const after = await getOrder(id);
        let ops = null, warnings = [];
        if (after.status === 'production' && PR.techcard.supports(after.product_type)) {
          const recalculated = !!body.calc && before.calc_json !== after.calc_json;
          if (before.status !== 'production' || recalculated) {
            if (recalculated && hasProgress(id)) ops = { ok: false, reason: 'По заказу уже есть отметки цеха — задания не пересозданы' };
            else ops = await generate(id, { force: recalculated || !hasProgress(id), by: user.id });
          }
        }
        if (after.status === 'production' && before.status !== 'production') warnings = await launchCheck(after);
        return J({ ok: true, ops, priceKept, warnings });
      }
      if (method === 'DELETE') {
        const o = await getOrder(id);
        if (o && !o.error) audit(user.id, 'Заказ удалён', `№ ${o.number} ${o.title || ''}`.trim());
        OPS = OPS.filter((x) => x.order_id !== id);
        return baseFetch(url, opts);
      }
    }

    /* --- производство --- */
    if (path === '/api/floor/areas') {
      return J({ areas: PROD.areas.map((a) => ({ id: a.id, name: a.name, kind: a.kind, queue: a.queue || 'manual' })),
        machines: PROD.machines.map((x) => ({ id: x.id, name: x.name, areaId: x.areaId })), regl: regl() });
    }
    if (path === '/api/floor/workers') {
      return J(DUSERS.filter((x) => x.active).map((x) => ({ x, e: effOf(x) }))
        .filter(({ e }) => e.perms.includes('floor.work') || e.perms.includes('floor.manage'))
        .map(({ x, e }) => ({ id: x.id, name: x.name, title: P.title(e), areas: e.areas || [], work: e.perms.includes('floor.work'), manage: e.perms.includes('floor.manage') })));
    }
    if (path === '/api/floor/catalog') return J(PROD.ops.map((o) => ({ code: o.code, name: o.name, areaId: o.areaId, machineId: o.machineId, unit: o.unit })));
    if (path === '/api/floor/queue') return J((await queue()).map(stripOp(user)));
    if (path === '/api/floor/work') {
      let areas = eff.areas;
      if (!can(user, 'floor.work') && qs.get('areas')) areas = qs.get('areas').split(',');
      const list = (await queue({ areas, includeClient: false })).filter((o) => !o.assignee_id || o.assignee_id === user.id)
        .map(({ plan_cost, client_name, ...x }) => x);
      const act = activeOf(user.id);
      return J({ areas: eff.areas || [], active: act ? act.op_id : null, ops: list, regl: regl() });
    }
    if (path === '/api/floor/qc') return J((await qcList(eff.areas)).map(stripOp(user)));
    if ((m = path.match(/^\/api\/floor\/log\/(\d+)\/fix$/)) && method === 'POST') {
      const l = LOGS.find((x) => x.id === Number(m[1]));
      if (!l) return J({ error: 'Отметка не найдена' }, 404);
      if (!can(user, 'floor.fix', l.area_id)) return deny('Исправлять отметки этого участка может его мастер или директор по производству');
      const r = fixLog(l.id, user.id, body);
      return J(r, r.error ? 400 : 200);
    }
    if ((m = path.match(/^\/api\/floor\/ops\/(\d+)\/(start|pause|finish|reopen|take|assign|accept|rework)$/)) && method === 'POST') {
      const op = getOp(Number(m[1]));
      if (!op) return J({ error: 'Задание не найдено' }, 404);
      const act = m[2];
      let r;
      if (act === 'reopen') { if (!can(user, 'floor.manage', op.area_id)) return deny(); r = await reopen(op.id, user.id); }
      else if (act === 'take') { if (!can(user, 'floor.work', op.area_id)) return deny('Это задание другого участка'); r = take(op.id, user.id); }
      else if (act === 'assign') {
        if (!can(user, 'floor.manage', op.area_id)) return deny();
        if (body.user_id) {
          const w = userById(Number(body.user_id));
          if (!w || !w.active) return J({ error: 'Нет такого сотрудника' }, 400);
          if (!can(w, 'floor.work', op.area_id) && !can(w, 'floor.manage', op.area_id)) return J({ error: `У сотрудника ${w.name} нет участка «${op.area_name}»` }, 400);
        }
        r = assign(op.id, body.user_id || null, user.id);
      } else if (act === 'accept' || act === 'rework') {
        if (!can(user, 'floor.qc', op.area_id)) return deny('Этот участок принимает другой контролёр');
        r = act === 'accept' ? await accept(op.id, user.id, body) : rework(op.id, user.id, body);
      } else {
        // кто отмечает: сотрудник за себя на своих участках, мастер участка за любого
        const wid = Number(body.user_id) || user.id;
        let reassign = false;
        if (wid !== user.id) {
          if (!can(user, 'floor.manage', op.area_id)) return deny('Отмечать за другого сотрудника может мастер этого участка');
          reassign = true;
        } else if (!can(user, 'floor.work', op.area_id)) {
          if (!can(user, 'floor.manage', op.area_id)) return deny('Это задание другого участка');
          reassign = true;
        }
        r = act === 'start' ? await start(op.id, wid, { force: !!body.force, by: user.id, reassign })
          : await stop(op.id, wid, { qty: body.qty, scrap: body.scrap, note: body.note, reason: body.reason, extra: body.extra, finish: act === 'finish', by: user.id });
      }
      if (r.needConfirm) return J({ error: r.error, needConfirm: true }, 409);
      return J(r, r.error ? 400 : 200);
    }
    if ((m = path.match(/^\/api\/floor\/ops\/(\d+)$/))) {
      const op = getOp(Number(m[1]));
      if (!op) return J({ error: 'Задание не найдено' }, 404);
      if (!can(user, 'floor.manage', op.area_id)) return deny();
      if (method === 'PUT') { const r = update(op.id, body, user.id); return J(r, r.error ? 400 : 200); }
      if (method === 'DELETE') { const r = await removeOp(op.id, user.id); return J(r, r.error ? 400 : 200); }
    }
    if (path === '/api/floor/reorder' && method === 'POST') {
      for (const id of body.ids || []) { const op = getOp(Number(id)); if (op && !can(user, 'floor.manage', op.area_id)) return deny('Очередь этого участка ставит его мастер'); }
      (body.ids || []).forEach((id, i) => { const op = getOp(Number(id)); if (op) op.queue_pos = i + 1; });
      return J({ ok: true });
    }
    if (path === '/api/floor/journal') {
      let rows = await journal({ from: qs.get('from'), to: qs.get('to'), userId: Number(qs.get('user_id')) || null, areaId: qs.get('area_id') });
      if (!can(user, 'floor.view')) rows = rows.filter((l) => can(user, 'floor.fix', l.area_id));
      return J(rows.map((l) => ({ ...l, canFix: can(user, 'floor.fix', l.area_id) })));
    }
    if (path === '/api/floor/report') {
      const r = await report({ from: qs.get('from'), to: qs.get('to') });
      if (!can(user, 'money.cost')) {
        delete r.totals.factCost; delete r.totals.planCost;
        r.byMachine = r.byMachine.map(({ factCost, ...x }) => x);
        r.byOrder = r.byOrder.map(({ planCost, factCost, ...x }) => x);
        r.costHidden = true;
      }
      return J(r);
    }

    return baseFetch(url, opts);
  };

  /* ---------- «Посмотреть СРМ глазами…»: переключение должности без выхода ----------
     Данные демо при переключении сохраняются: можно отметить работу за печатника
     и сразу посмотреть, что увидят ОТК и директор по производству. */
  const EYES = [
    { group: 'Офис', id: 1, sees: 'всё: цены, себестоимость, должности и права, журнал действий' },
    { group: 'Офис', id: 3, sees: 'все заказы и клиенты, передаёт заказы, снимает фиксацию цены' },
    { group: 'Офис', id: 2, sees: 'только свои заказы и клиентов; утверждённую цену не меняет' },
    { group: 'Цех', id: 6, sees: 'весь цех: очередь, исполнители, исправления, приёмка; цен не видит' },
    { group: 'Цех', id: 7, sees: 'свои задания на офсете и цифре: совмещает две должности' },
    { group: 'Цех', id: 8, sees: 'свои задания: резка, переплёт, отделка, упаковка' },
    { group: 'Цех', id: 9, sees: 'что ждёт приёмки; свою работу принять не может' },
    { group: 'Склад', id: 10, sees: 'только склад: остатки, приход, выдача; без стоимости' },
  ];
  const shortTitle = (u) => (pub(u).title || '').split(', ')[0] || 'без должности';
  // в списке: совмещение видно сразу («Печатник офсетной печати + Печатник цифровой печати»)
  const cardTitle = (u) => {
    const t = (pub(u).title || 'без должности').split(', ');
    return t.length <= 2 ? t.join(' + ') : `${t[0]} и ещё ${t.length - 1}`;
  };
  const initials = (name) => String(name || '?').replace(/\(.*?\)/g, '').trim().split(/\s+/).slice(0, 2)
    .map((w) => w[0] || '').join('').toUpperCase();
  const esc2 = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function switchTo(id) {
    const x = userById(id);
    if (!x || !x.active) return;
    const p = pub(x);
    sessionStorage.setItem('demo_user', JSON.stringify(p));
    document.querySelectorAll('.modal-overlay').forEach((el) => el.remove());
    closeEyes();
    // ядро приложения (app.js): новый пользователь без перезагрузки страницы
    state.user = p;
    state.users = state.clients = state.schema = state.suppliers = null;
    location.hash = homeRoute() || '#/orders';
    showApp();
    toast(`Теперь вы смотрите глазами: ${shortTitle(x)}`, 'ok');
  }

  let eyesPanel = null;
  function closeEyes() { if (eyesPanel) { eyesPanel.remove(); eyesPanel = null; } }
  function openEyes() {
    if (eyesPanel) { closeEyes(); return; }
    const curId = (me() || {}).id;
    const cards = EYES.map((e) => ({ ...e, user: userById(e.id) })).filter((e) => e.user && e.user.active);
    const groups = [...new Set(cards.map((c) => c.group))];
    eyesPanel = document.createElement('div');
    eyesPanel.id = 'demo-eyes-panel';
    eyesPanel.innerHTML = `
      <div class="de-h">Посмотреть СРМ глазами…</div>
      <div class="de-sub">Демо: люди и цифры выдуманные. Данные при переключении сохраняются.</div>
      ${groups.map((g) => `<div class="de-g">${esc2(g)}</div>${cards.filter((c) => c.group === g).map((c) => `
        <button class="de-item${c.id === curId ? ' cur' : ''}" data-id="${c.id}">
          <span class="de-av">${esc2(initials(c.user.name))}</span>
          <span class="de-txt"><b>${esc2(cardTitle(c.user))} · ${esc2(c.user.name)}</b>
            <span>видит: ${esc2(c.sees)}</span></span>
          ${c.id === curId ? '<span class="de-ok">✓</span>' : ''}
        </button>`).join('')}`).join('')}
      <button class="de-reset">↻ Начать демо заново</button>`;
    document.body.appendChild(eyesPanel);
    eyesPanel.querySelectorAll('.de-item').forEach((b) => b.addEventListener('click', () => switchTo(Number(b.dataset.id))));
    eyesPanel.querySelector('.de-reset').addEventListener('click', () => location.reload());
  }

  function mountEyes() {
    const css = document.createElement('style');
    css.textContent = `
      #demo-eyes { position: fixed; left: 12px; bottom: 12px; z-index: 90; display: none; align-items: center; gap: 8px;
        background: #111; color: #fff; border: none; border-radius: 22px; padding: 9px 14px 9px 10px; cursor: pointer;
        font: 600 13px -apple-system, Segoe UI, Roboto, sans-serif; box-shadow: 0 6px 20px rgba(0,0,0,.25); max-width: calc(100vw - 24px); }
      #demo-eyes .de-av { width: 26px; height: 26px; font-size: 11px; }
      #demo-eyes:hover { background: #E31C79; }
      #demo-eyes-panel { position: fixed; left: 12px; bottom: 62px; z-index: 95; width: 380px; max-width: calc(100vw - 24px);
        max-height: calc(100vh - 90px); overflow-y: auto; background: #16181c; color: #fff; border-radius: 18px; padding: 16px 12px 12px;
        box-shadow: 0 18px 50px rgba(0,0,0,.4); font-family: -apple-system, Segoe UI, Roboto, sans-serif; }
      #demo-eyes-panel .de-h { font-size: 17px; font-weight: 800; padding: 0 8px; }
      #demo-eyes-panel .de-sub { font-size: 12.5px; color: #9aa0a6; padding: 3px 8px 6px; }
      #demo-eyes-panel .de-g { font-size: 11px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: #6b7178; padding: 10px 8px 2px; }
      #demo-eyes-panel .de-item { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; background: transparent;
        border: 1px solid transparent; border-radius: 14px; padding: 8px 8px; color: #fff; cursor: pointer; font: inherit; }
      #demo-eyes-panel .de-item:hover { background: rgba(255,255,255,.06); }
      #demo-eyes-panel .de-item.cur { background: rgba(223,230,144,.12); border-color: rgba(223,230,144,.55); }
      .de-av { flex: none; width: 38px; height: 38px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
        background: #2b2f36; color: #fff; font-weight: 800; font-size: 13px; letter-spacing: .02em; }
      #demo-eyes-panel .de-item.cur .de-av { background: #DFE690; color: #111; }
      #demo-eyes-panel .de-txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      #demo-eyes-panel .de-txt b { font-size: 14px; }
      #demo-eyes-panel .de-item.cur .de-txt b { color: #DFE690; }
      #demo-eyes-panel .de-txt span { font-size: 12.5px; color: #9aa0a6; line-height: 1.35; }
      #demo-eyes-panel .de-ok { flex: none; width: 24px; height: 24px; border-radius: 50%; background: #DFE690; color: #111;
        display: inline-flex; align-items: center; justify-content: center; font-weight: 800; font-size: 13px; }
      #demo-eyes-panel .de-reset { display: block; width: 100%; margin-top: 10px; padding: 11px; border: none; border-radius: 12px;
        background: #2b2f36; color: #fff; font: 600 14px -apple-system, Segoe UI, Roboto, sans-serif; cursor: pointer; }
      #demo-eyes-panel .de-reset:hover { background: #E31C79; }
      @media print { #demo-eyes, #demo-eyes-panel { display: none !important; } }`;
    document.head.appendChild(css);
    const btn = document.createElement('button');
    btn.id = 'demo-eyes';
    btn.title = 'Посмотреть СРМ глазами другой должности';
    document.body.appendChild(btn);
    btn.addEventListener('click', (e) => { e.stopPropagation(); openEyes(); });
    document.addEventListener('mousedown', (e) => {
      if (eyesPanel && !eyesPanel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) closeEyes();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeEyes(); });
    // кнопка видна, когда вошли; подпись: текущая должность
    const sync = () => {
      const x = cur();
      const app = document.getElementById('app');
      const show = !!x && app && !app.classList.contains('hidden');
      btn.style.display = show ? 'inline-flex' : 'none';
      if (!show) { closeEyes(); return; }
      const html = `<span class="de-av">${esc2(initials(x.name))}</span>Глазами: ${esc2(shortTitle(x))} ▾`;
      if (btn.innerHTML !== html) btn.innerHTML = html;
    };
    setInterval(sync, 700);
    sync();
  }
  document.addEventListener('DOMContentLoaded', mountEyes);

  /* ---------- подсказка на экране входа: какие логины пробовать ---------- */
  document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('login-form');
    if (!form) return;
    const hint = document.createElement('div');
    hint.className = 'muted small';
    hint.style.cssText = 'margin-top:12px;line-height:1.5;text-align:left';
    hint.innerHTML = '<b>Логины для демо</b> (пароль любой):<br>demo: генеральный директор<br>petrov: руководитель продаж · ivanova: менеджер<br>'
      + 'master: директор по производству<br>pechatnik: печатник · pereplet: переплётчик<br>otk: контролёр ОТК · sklad: кладовщик<br>'
      + 'После входа кнопка «Глазами» внизу слева переключает должность.';
    form.appendChild(hint);
  });
})();

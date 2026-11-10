/* ДЕМО: производство по операциям прямо в браузере (сервера нет).
   Надстройка над demo-mock.js: техкарты в расчёте, задания участкам, очереди, отметки «начал / пауза / готово»,
   журнал выработки, план и факт, роли «мастер цеха» и «сотрудник цеха», фиксация цены, перепечатки,
   ручные задания, проверка при запуске. Логика повторяет серверный модуль crm/floor.js. */
(function () {
  'use strict';
  const PR = window.DEMO_PRICING;
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

  /* ---------- справочник производства и роли цеха ---------- */
  const DEF = PR.productionDefaults;
  let PROD = clone(DEF);
  const EXTRA_USERS = [
    { id: 6, login: 'master', name: 'Сидоров В. (мастер цеха)', role: 'master', active: 1, areas: [] },
    { id: 7, login: 'pechatnik', name: 'Иванов П. (печатник)', role: 'worker', active: 1, areas: ['offset', 'digital'] },
    { id: 8, login: 'pereplet', name: 'Петрова А. (переплёт)', role: 'worker', active: 1,
      areas: ['prepress', 'cutting', 'lamination', 'stamping', 'brochure', 'bindery', 'finishing', 'manual'] },
  ];
  const userName = (id) => (EXTRA_USERS.find((u) => u.id === id) || {}).name || (me() && me().id === id ? me().name : '');
  const canManage = (u) => !!u && (u.role === 'admin' || u.role === 'master');

  /* ---------- состояние цеха (в памяти вкладки) ---------- */
  let OPS = [], LOGS = [], seqOp = 1, seqLog = 1;
  const META = {};        // id заказа → { price_locked, reprint_of, number }
  const EXTRA_LOG = {};   // id заказа → события производства для истории заказа
  const meta = (id) => (META[id] = META[id] || {});
  function logEvent(orderId, text, who) {
    (EXTRA_LOG[orderId] = EXTRA_LOG[orderId] || []).push({ event: text, user_name: who || (me() || {}).name || '', created_at: dt(Date.now()) });
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

  async function generate(orderId, { force = false } = {}) {
    const order = await getOrder(orderId);
    if (!order || order.error) return { ok: false, reason: 'Заказ не найден' };
    const existing = opsOf(orderId);
    if (existing.length && !force) return { ok: true, created: 0, existing: existing.length };
    if (existing.length && hasProgress(orderId)) return { ok: false, reason: 'По заказу уже есть отметки цеха — задания не пересоздаются' };
    const tc = techcardOf(order);
    if (!tc) return { ok: false, reason: 'Для этого вида продукции техкарты пока нет' };
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
    }));
    logEvent(orderId, existing.length ? `Производство: задания пересозданы по техкарте (${tc.ops.length})`
      : `Производство: созданы задания участкам по техкарте (${tc.ops.length})`);
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
      const logs = LOGS.filter((l) => l.op_id === r.id).map((l) => ({ ...l, user_name: userName(l.user_id) }));
      return { ...r, after, materials: parse(r.materials_json, []), approx: !!r.approx, blockedBy, logs,
        workers: [...new Set(logs.filter((l) => !l.finished_at).map((l) => l.user_name).filter(Boolean))], factMin: factMin(logs) };
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

  async function start(opId, workerId, { force = false, at = null } = {}) {
    const op = getOp(opId);
    if (!op) return { error: 'Задание не найдено' };
    const order = await getOrder(op.order_id);
    if (!order || order.status !== 'production') return { error: 'Заказ не в производстве' };
    if (op.status === 'done') return { error: 'Задание уже выполнено' };
    const act = activeOf(workerId);
    if (act && act.op_id === op.id) return { error: 'Это задание уже в работе' };
    if (act) { const a = getOp(act.op_id); return { error: `Сначала завершите или поставьте на паузу текущее задание: ${a ? a.name : ''}` }; }
    const [d] = decorate([op]);
    if (d.blockedBy.length && !force) return { needConfirm: true, error: 'Ещё не закончены предыдущие операции: ' + d.blockedBy.join(', ') };
    const t = at || nowIso();
    const first = !OPS.some((o) => o.order_id === op.order_id && o.started_at);
    LOGS.push({ id: seqLog++, op_id: op.id, order_id: op.order_id, user_id: workerId, by_user_id: (me() || {}).id || workerId,
      area_id: op.area_id, machine_id: op.machine_id, started_at: t, finished_at: null, qty: 0, scrap: 0, note: '' });
    op.status = 'work';
    op.started_at = op.started_at || t;
    if (first) logEvent(op.order_id, `Производство: начато (${op.name})`, userName(workerId));
    return { ok: true };
  }

  async function stop(opId, workerId, { qty = 0, scrap = 0, note = '', finish = false, at = null } = {}) {
    const op = getOp(opId);
    if (!op) return { error: 'Задание не найдено' };
    if (op.status === 'done') return { error: 'Задание уже выполнено' };
    qty = Math.max(0, Number(qty) || 0); scrap = Math.max(0, Number(scrap) || 0);
    const t = at || nowIso();
    let open = LOGS.find((l) => l.op_id === op.id && l.user_id === workerId && !l.finished_at);
    if (!open && !finish) return { error: 'Это задание сейчас не в работе у этого сотрудника' };
    if (!open) {
      open = { id: seqLog++, op_id: op.id, order_id: op.order_id, user_id: workerId, by_user_id: (me() || {}).id || workerId,
        area_id: op.area_id, machine_id: op.machine_id, started_at: t, finished_at: null, qty: 0, scrap: 0, note: '' };
      LOGS.push(open);
    }
    Object.assign(open, { finished_at: t, qty, scrap, note: String(note || '').slice(0, 500) });
    op.done_qty = r2(op.done_qty + qty);
    if (finish) {
      LOGS.filter((l) => l.op_id === op.id && !l.finished_at).forEach((l) => { l.finished_at = t; });
      Object.assign(op, { status: 'done', finished_at: t, started_at: op.started_at || t });
    } else {
      op.status = LOGS.some((l) => l.op_id === op.id && !l.finished_at) ? 'work' : 'paused';
    }
    const ready = finish ? await syncOrder(op.order_id) : false;
    return { ok: true, orderReady: ready };
  }

  async function syncOrder(orderId) {
    const all = opsOf(orderId);
    if (!all.length || all.some((o) => o.status !== 'done')) return false;
    const order = await getOrder(orderId);
    if (!order || order.status !== 'production') return false;
    await base('PUT', '/api/orders/' + orderId, { status: 'ready', prod_stage: 'done' });
    logEvent(orderId, 'Производство завершено: все задания выполнены, статус → «Готов»');
    return true;
  }

  async function reopen(opId) {
    const op = getOp(opId);
    if (!op) return { error: 'Задание не найдено' };
    if (op.status !== 'done') return { error: 'Задание не выполнено' };
    op.status = 'paused'; op.finished_at = null;
    logEvent(op.order_id, `Производство: задание «${op.name}» (${op.part}) возвращено в работу`);
    const order = await getOrder(op.order_id);
    if (order && order.status === 'ready') await base('PUT', '/api/orders/' + op.order_id, { status: 'production' });
    return { ok: true };
  }

  function update(opId, b) {
    const op = getOp(opId);
    if (!op) return { error: 'Задание не найдено' };
    if (b.machine_id !== undefined && b.machine_id !== op.machine_id) {
      const m = b.machine_id ? PROD.machines.find((x) => x.id === b.machine_id) : null;
      if (b.machine_id && !m) return { error: 'Нет такой машины' };
      if (m && m.areaId !== op.area_id) return { error: 'Машина с другого участка' };
      const p = PR.techcard.replan(PROD, op.code, b.machine_id, op.qty, op.setups);
      Object.assign(op, { machine_id: p.machineId, machine_name: p.machineName, plan_min: p.timeMin, plan_cost: p.planCost, approx: p.approx ? 1 : 0 });
      logEvent(op.order_id, `Производство: «${op.name}» (${op.part}) → ${p.machineName || 'вручную'}`);
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
        return { ...l, user_name: userName(l.user_id), by_name: userName(l.by_user_id), op_name: op.name, part: op.part, unit: op.unit,
          area_name: op.area_name, machine_name: op.machine_name, plan_min: op.plan_min, op_qty: op.qty,
          order_number: (META[o.id] && META[o.id].number) || o.number, order_title: o.title, minutes: factMin([l]) };
      });
  }

  async function report({ from, to } = {}) {
    const orders = new Map((await allOrders()).map((o) => [o.id, o]));
    const sessions = LOGS.filter((l) => (!from || l.started_at >= from) && (!to || l.started_at <= to));
    const done = OPS.filter((op) => op.status === 'done' && (!from || op.finished_at >= from) && (!to || op.finished_at <= to));
    const add = (m, k, init) => { if (!m.has(k)) m.set(k, init()); return m.get(k); };
    const W = new Map(), M = new Map(), O = new Map();
    let factT = 0, factC = 0, planT = 0, planF = 0, planC = 0;
    for (const l of sessions) {
      const op = getOp(l.op_id) || {};
      const min = factMin([l]), c = sessionCost(l);
      factT += min; if (c) factC += c;
      const w = add(W, l.user_id, () => ({ name: userName(l.user_id) || '—', sessions: 0, factMin: 0, scrap: 0, ops: new Set() }));
      w.sessions++; w.factMin += min; w.scrap += l.scrap || 0; w.ops.add(l.op_id);
      const m = add(M, l.area_id + '|' + l.machine_id, () => ({ area: op.area_name || '', machine: op.machine_name || 'вручную', factMin: 0, factCost: 0, planMin: 0, opsDone: 0 }));
      m.factMin += min; if (c) m.factCost += c;
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
      totals: { factMin: r2(factT), factCost: r2(factC), sessions: sessions.length, opsDone: done.length, planMin: r2(planT), planFactMin: r2(planF), planCost: r2(planC) },
      byWorker: [...W.values()].map((x) => fix({ ...x, ops: x.ops.size })).sort((a, b) => b.factMin - a.factMin),
      byMachine: [...M.values()].map(fix).sort((a, b) => b.factMin - a.factMin),
      byOrder: [...O.values()].map(fix),
      deviations: rows.filter((x) => x.devPct != null).sort((a, b) => Math.abs(b.devPct) - Math.abs(a.devPct)).slice(0, 15),
    };
  }

  async function addOp(orderId, b) {
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
      note: String(b.note || ''), status: 'todo', queue_pos: Date.now() / 1000, done_qty: 0, started_at: null, finished_at: null });
    if (order.status === 'ready') await base('PUT', '/api/orders/' + orderId, { status: 'production' });
    logEvent(orderId, `Производство: добавлено задание «${name}» (${area.name}${area.kind === 'outsource' ? ', подряд' : ''})`);
    return { ok: true };
  }

  async function removeOp(opId) {
    const op = getOp(opId);
    if (!op) return { error: 'Задание не найдено' };
    if (op.status !== 'todo' || LOGS.some((l) => l.op_id === op.id)) return { error: 'По заданию уже есть отметки — удалить нельзя' };
    const own = parse(op.after_json, []);
    for (const o of opsOf(op.order_id)) {
      const a = parse(o.after_json, []);
      if (a.includes(op.op_key)) o.after_json = JSON.stringify([...new Set([...a.filter((k) => k !== op.op_key), ...own])]);
    }
    OPS = OPS.filter((o) => o.id !== op.id);
    logEvent(op.order_id, `Производство: удалено задание «${op.name}» (${op.part})`);
    await syncOrder(op.order_id);
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
      const row = { ...o, setupMin: num(o.setupMin, o.name, true), perHour: num(o.perHour, o.name, true), people: Math.max(1, Math.round(num(o.people, o.name) || 1)) };
      row.approx = !!(d.approx && d.setupMin === row.setupMin && d.perHour === row.perHour && (d.machineId || '') === (row.machineId || ''));
      return row;
    });
    for (const d of DEF.ops) if (!ops.some((o) => o.code === d.code)) ops.push(clone(d));
    const pct = num((input.waste || {}).digitalPct ?? DEF.waste.digitalPct, 'техотход');
    return { waste: { digitalPct: pct, approx: pct === DEF.waste.digitalPct }, areas, machines, ops };
  }

  /* ---------- стартовые данные: заказы в производстве уже с заданиями и отметками ---------- */
  // создаются при первом запросе после входа: до входа демо-сервер отвечает «требуется вход»
  let readyP = null;
  const ensureReady = () => readyP || (readyP = (async () => {
    const orders = await allOrders();
    if (!Array.isArray(orders)) { readyP = null; return; }
    const prodOrders = orders.filter((o) => o.status === 'production' && PR.techcard.supports(o.product_type));
    // один заказ печатаем офсетом, чтобы в очередях были RMGT 794 и RYOBI 784
    const big = prodOrders.find((o) => o.product_type === 'books7' && o.quantity >= 500);
    if (big) {
      const params = { ...parse(big.params_json, {}), printType: 'офсет' };
      const calc = await base('POST', '/api/calc/books7', params);
      if (calc && calc.ok) await base('PUT', '/api/orders/' + big.id, { params, calc, price: calc.priceTotal, cost: calc.cost });
    }
    for (const o of prodOrders) await generate(o.id);
    if (big) {
      const ryobi = opsOf(big.id).find((x) => x.code === 'print_offset' && x.part === 'Обложка');
      if (ryobi) update(ryobi.id, { machine_id: 'ryobi784' });
    }
    // история работы: вчера и сегодня, с реальной длительностью смен
    const H = 3600 * 1000, ago = (h) => new Date(Date.now() - h * H).toISOString();
    let shift = 30;
    const workerFor = (op) => (EXTRA_USERS[1].areas.includes(op.area_id) ? 7 : 8);
    async function doneOp(op, hours) {
      hours = Math.min(5, Math.max(0.25, hours));
      if (shift - hours < 1) shift = hours + 1.5;
      const s = ago(shift), f = ago(shift - hours);
      await start(op.id, workerFor(op), { force: true, at: s });
      await stop(op.id, workerFor(op), { qty: op.qty, finish: true, at: f, note: '' });
      shift -= hours + 0.2;
    }
    if (prodOrders[0]) {
      const ops = opsOf(prodOrders[0].id);
      for (const code of ['layout', 'cut_paper']) for (const op of ops.filter((x) => x.code === code)) await doneOp(op, Math.max(0.3, (op.plan_min || 30) / 60 * 1.15));
      const pr = ops.find((x) => x.code.startsWith('print') && x.part === 'Блок');
      if (pr) await doneOp(pr, Math.max(0.5, (pr.plan_min || 60) / 60 * 0.9));
      const fold = ops.find((x) => x.code === 'fold');
      if (fold) { await start(fold.id, 8, { force: true, at: ago(0.7) }); }
    }
    if (prodOrders[1]) {
      const ops = opsOf(prodOrders[1].id);
      shift = 26;
      for (const op of ops.filter((x) => ['layout', 'cut_paper'].includes(x.code))) await doneOp(op, Math.max(0.3, (op.plan_min || 30) / 60 * 1.3));
      const pr = ops.find((x) => x.code.startsWith('print') && x.part === 'Блок');
      if (pr) { await start(pr.id, 7, { force: true, at: ago(1.2) }); }
    }
  })());

  /* ---------- перехват запросов ---------- */
  const WORKER_OK = (p) => ['/api/me', '/api/me/password', '/api/logout', '/api/floor/areas', '/api/floor/work'].includes(p)
    || /^\/api\/floor\/ops\/\d+\/(start|pause|finish)$/.test(p);

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

    // вход: логины master / pechatnik / pereplet открывают роли цеха
    if (path === '/api/login') {
      const resp = await baseFetch(url, opts);
      const data = await resp.json();
      const extra = EXTRA_USERS.find((x) => x.login === String(body.login || '').trim().toLowerCase());
      if (extra) { sessionStorage.setItem('demo_user', JSON.stringify(extra)); return J({ user: extra }); }
      return J({ ...data, user: data.user ? { areas: [], ...data.user } : data.user }, resp.status);
    }
    if (path === '/api/me') { const x = me(); return x ? J({ user: { areas: [], ...x } }) : J({ error: 'Требуется вход' }, 401); }
    const user = me();
    if (!user) return baseFetch(url, opts);
    if (user.role === 'worker' && !WORKER_OK(path)) return J({ error: 'Нет доступа' }, 403);
    await ensureReady();
    const deny = () => J({ error: 'Только мастер цеха или руководитель' }, 403);
    let m;

    if (path === '/api/users' && method === 'GET') {
      const list = await base('GET', '/api/users');
      return J([...list.map((x) => ({ areas: [], ...x })), ...EXTRA_USERS]);
    }

    // справочник производства
    if (path === '/api/production') {
      if (user.role !== 'admin') return J({ error: 'Только для руководителя' }, 403);
      if (method === 'GET') return J(PROD);
      try { PROD = cleanProd(body); return J({ ok: true, production: PROD }); } catch (e) { return J({ error: e.message }, 400); }
    }
    if (path === '/api/production/reset') { PROD = clone(DEF); return J({ ok: true }); }

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

    // заказы
    if (path === '/api/orders' && method === 'GET') {
      const list = await (await baseFetch(url, opts)).json();
      return J(await Promise.all(list.map(async (o) => {
        const ops = opsOf(o.id);
        const x = await withOrderExtras(o);
        return ops.length ? { ...x, ops_total: ops.length, ops_done: ops.filter((p) => p.status === 'done').length,
          ops_working: ops.filter((p) => p.status === 'work').length } : x;
      })));
    }
    if ((m = path.match(/^\/api\/orders\/(\d+)\/reprint$/)) && method === 'POST') {
      const o = await getOrder(Number(m[1]));
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
      logEvent(r.id, `Перепечатка к заказу № ${o.number}${body.reason ? ': ' + body.reason : ''} (${tiraj} экз., клиенту бесплатно)`);
      logEvent(o.id, `Создана перепечатка № ${number} (${tiraj} экз.)`);
      return J({ id: r.id, number });
    }
    if ((m = path.match(/^\/api\/orders\/(\d+)\/ops\/generate$/)) && method === 'POST') {
      if (!canManage(user)) return deny();
      const r = await generate(Number(m[1]), { force: !!body.force });
      return r.ok ? J(r) : J({ error: r.reason }, 400);
    }
    if ((m = path.match(/^\/api\/orders\/(\d+)\/ops$/)) && method === 'POST') {
      if (!canManage(user)) return deny();
      const r = await addOp(Number(m[1]), body);
      return J(r, r.error ? 400 : 200);
    }
    if ((m = path.match(/^\/api\/orders\/(\d+)$/))) {
      const id = Number(m[1]);
      if (method === 'GET') {
        const o = await getOrder(id);
        if (o.error) return J(o, 404);
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
        return J(x);
      }
      if (method === 'PUT') {
        const before = await getOrder(id);
        const mm = meta(id);
        const locked = body.price_locked != null ? !!body.price_locked : !!mm.price_locked;
        if (body.price_locked != null && locked !== !!mm.price_locked) logEvent(id, locked ? `Цена зафиксирована: ${before.price} ₽` : 'Фиксация цены снята');
        let priceKept = false;
        if (mm.price_locked && locked && body.calc && body.price != null && Math.abs(Number(body.price) - Number(before.price)) > 0.004) {
          logEvent(id, `Пересчёт показал ${body.price} ₽, но цена зафиксирована: в заказе осталось ${before.price} ₽`);
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
            else ops = await generate(id, { force: recalculated || !hasProgress(id) });
          }
        }
        if (after.status === 'production' && before.status !== 'production') warnings = await launchCheck(after);
        return J({ ok: true, ops, priceKept, warnings });
      }
    }

    // производство
    if (path === '/api/floor/areas') {
      return J({ areas: PROD.areas.map((a) => ({ id: a.id, name: a.name, kind: a.kind, queue: a.queue || 'manual' })),
        machines: PROD.machines.map((x) => ({ id: x.id, name: x.name, areaId: x.areaId })) });
    }
    if (path === '/api/floor/workers') {
      const admins = (await base('GET', '/api/users')).filter((x) => x.role === 'admin');
      return J([...EXTRA_USERS, ...admins.map((a) => ({ id: a.id, name: a.name, role: a.role, areas: [] }))]);
    }
    if (path === '/api/floor/catalog') return J(PROD.ops.map((o) => ({ code: o.code, name: o.name, areaId: o.areaId, machineId: o.machineId, unit: o.unit })));
    if (path === '/api/floor/queue') return J(await queue());
    if (path === '/api/floor/work') {
      let areas = user.role === 'worker' ? user.areas || [] : null;
      if (user.role !== 'worker' && qs.get('areas')) areas = qs.get('areas').split(',');
      const list = (await queue({ areas, includeClient: false })).map(({ plan_cost, ...x }) => x);
      const act = activeOf(user.id);
      return J({ areas: user.areas || [], active: act ? act.op_id : null, ops: list });
    }
    if ((m = path.match(/^\/api\/floor\/ops\/(\d+)\/(start|pause|finish|reopen)$/)) && method === 'POST') {
      const op = getOp(Number(m[1]));
      if (!op) return J({ error: 'Задание не найдено' }, 404);
      if (m[2] === 'reopen') { if (!canManage(user)) return deny(); const r = await reopen(op.id); return J(r, r.error ? 400 : 200); }
      let wid = user.id;
      if (user.role === 'worker') { if (!(user.areas || []).includes(op.area_id)) return J({ error: 'Это задание другого участка' }, 403); }
      else if (!canManage(user)) return J({ error: 'Отмечать работу могут сотрудник цеха, мастер или руководитель' }, 403);
      else wid = Number(body.user_id) || user.id;
      const r = m[2] === 'start' ? await start(op.id, wid, { force: !!body.force })
        : await stop(op.id, wid, { qty: body.qty, scrap: body.scrap, note: body.note, finish: m[2] === 'finish' });
      if (r.needConfirm) return J({ error: r.error, needConfirm: true }, 409);
      return J(r, r.error ? 400 : 200);
    }
    if ((m = path.match(/^\/api\/floor\/ops\/(\d+)$/))) {
      if (!canManage(user)) return deny();
      if (method === 'PUT') { const r = update(Number(m[1]), body); return J(r, r.error ? 400 : 200); }
      if (method === 'DELETE') { const r = await removeOp(Number(m[1])); return J(r, r.error ? 400 : 200); }
    }
    if (path === '/api/floor/reorder' && method === 'POST') {
      if (!canManage(user)) return deny();
      (body.ids || []).forEach((id, i) => { const op = getOp(Number(id)); if (op) op.queue_pos = i + 1; });
      return J({ ok: true });
    }
    if (path === '/api/floor/journal') {
      return J(await journal({ from: qs.get('from'), to: qs.get('to'), userId: Number(qs.get('user_id')) || null, areaId: qs.get('area_id') }));
    }
    if (path === '/api/floor/report') return J(await report({ from: qs.get('from'), to: qs.get('to') }));

    return baseFetch(url, opts);
  };

  /* ---------- «Посмотреть СРМ глазами…»: переключение роли без выхода ----------
     Данные демо при переключении сохраняются: можно отметить работу за печатника
     и сразу посмотреть, что увидит мастер. */
  const EYES = [
    { id: 1, title: 'Руководитель', sees: 'всё: цены, себестоимость, настройки, справочники', home: '#/orders' },
    { id: 2, title: 'Менеджер', sees: 'заказы, клиенты, калькулятор и КП; цех только смотрит', home: '#/orders' },
    { id: 6, title: 'Мастер цеха', sees: 'очереди участков, машины, отметки за сотрудников', home: '#/production' },
    { id: 7, title: 'Печатник', sees: 'только свои задания: офсет и цифра, без цен и клиентов', home: '#/work' },
    { id: 8, title: 'Переплётчик', sees: 'только свои задания: переплёт, резка, отделка', home: '#/work' },
  ];
  async function eyesUsers() {
    const baseUsers = await base('GET', '/api/users').catch(() => []);
    const all = [...(Array.isArray(baseUsers) ? baseUsers : []), ...EXTRA_USERS];
    return EYES.map((e) => ({ ...e, user: all.find((u) => u.id === e.id) })).filter((e) => e.user);
  }
  const initials = (name) => String(name || '?').replace(/\(.*?\)/g, '').trim().split(/\s+/).slice(0, 2)
    .map((w) => w[0] || '').join('').toUpperCase();
  const esc2 = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function switchTo(card) {
    const user = { areas: [], ...card.user };
    sessionStorage.setItem('demo_user', JSON.stringify(user));
    document.querySelectorAll('.modal-overlay').forEach((m) => m.remove());
    closeEyes();
    // ядро приложения (app.js): новый пользователь без перезагрузки страницы
    state.user = user;
    state.users = state.clients = state.schema = state.suppliers = null;
    location.hash = card.home;
    showApp();
    toast(`Теперь вы смотрите глазами: ${card.title}`, 'ok');
  }

  let eyesPanel = null;
  function closeEyes() { if (eyesPanel) { eyesPanel.remove(); eyesPanel = null; } }
  async function openEyes() {
    if (eyesPanel) { closeEyes(); return; }
    const cards = await eyesUsers();
    const cur = (me() || {}).id;
    eyesPanel = document.createElement('div');
    eyesPanel.id = 'demo-eyes-panel';
    eyesPanel.innerHTML = `
      <div class="de-h">Посмотреть СРМ глазами…</div>
      <div class="de-sub">Демо: люди и цифры выдуманные. Данные при переключении сохраняются.</div>
      ${cards.map((c) => `
        <button class="de-item${c.id === cur ? ' cur' : ''}" data-id="${c.id}">
          <span class="de-av">${esc2(initials(c.user.name))}</span>
          <span class="de-txt"><b>${esc2(c.title)}${/руководител/i.test(c.user.name) ? '' : ' · ' + esc2(String(c.user.name).replace(/\s*\(.*\)$/, ''))}</b>
            <span>видит: ${esc2(c.sees)}</span></span>
          ${c.id === cur ? '<span class="de-ok">✓</span>' : ''}
        </button>`).join('')}
      <button class="de-reset">↻ Начать демо заново</button>`;
    document.body.appendChild(eyesPanel);
    eyesPanel.querySelectorAll('.de-item').forEach((b) => b.addEventListener('click', () => {
      const c = cards.find((x) => String(x.id) === b.dataset.id);
      if (c) switchTo(c);
    }));
    eyesPanel.querySelector('.de-reset').addEventListener('click', () => location.reload());
  }

  function mountEyes() {
    const css = document.createElement('style');
    css.textContent = `
      #demo-eyes { position: fixed; left: 12px; bottom: 12px; z-index: 90; display: none; align-items: center; gap: 8px;
        background: #111; color: #fff; border: none; border-radius: 22px; padding: 9px 14px 9px 10px; cursor: pointer;
        font: 600 13px -apple-system, Segoe UI, Roboto, sans-serif; box-shadow: 0 6px 20px rgba(0,0,0,.25); }
      #demo-eyes .de-av { width: 26px; height: 26px; font-size: 11px; }
      #demo-eyes:hover { background: #E31C79; }
      #demo-eyes-panel { position: fixed; left: 12px; bottom: 62px; z-index: 95; width: 360px; max-width: calc(100vw - 24px);
        max-height: calc(100vh - 90px); overflow-y: auto; background: #16181c; color: #fff; border-radius: 18px; padding: 16px 12px 12px;
        box-shadow: 0 18px 50px rgba(0,0,0,.4); font-family: -apple-system, Segoe UI, Roboto, sans-serif; }
      #demo-eyes-panel .de-h { font-size: 17px; font-weight: 800; padding: 0 8px; }
      #demo-eyes-panel .de-sub { font-size: 12.5px; color: #9aa0a6; padding: 3px 8px 10px; }
      #demo-eyes-panel .de-item { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; background: transparent;
        border: 1px solid transparent; border-radius: 14px; padding: 9px 8px; color: #fff; cursor: pointer; font: inherit; }
      #demo-eyes-panel .de-item:hover { background: rgba(255,255,255,.06); }
      #demo-eyes-panel .de-item.cur { background: rgba(223,230,144,.12); border-color: rgba(223,230,144,.55); }
      .de-av { flex: none; width: 40px; height: 40px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
        background: #2b2f36; color: #fff; font-weight: 800; font-size: 14px; letter-spacing: .02em; }
      #demo-eyes-panel .de-item.cur .de-av { background: #DFE690; color: #111; }
      #demo-eyes-panel .de-txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      #demo-eyes-panel .de-txt b { font-size: 14.5px; }
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
    btn.title = 'Посмотреть СРМ глазами другой роли';
    document.body.appendChild(btn);
    btn.addEventListener('click', (e) => { e.stopPropagation(); openEyes(); });
    document.addEventListener('mousedown', (e) => {
      if (eyesPanel && !eyesPanel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) closeEyes();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeEyes(); });
    // кнопка видна, когда вошли; подпись: текущая роль
    const sync = () => {
      const u = me();
      const app = document.getElementById('app');
      const show = !!u && app && !app.classList.contains('hidden');
      btn.style.display = show ? 'inline-flex' : 'none';
      if (!show) { closeEyes(); return; }
      const card = EYES.find((c) => c.id === u.id);
      const label = card ? card.title : (u.role === 'worker' ? 'Сотрудник цеха' : u.role === 'master' ? 'Мастер цеха' : u.role === 'admin' ? 'Руководитель' : 'Менеджер');
      const html = `<span class="de-av">${esc2(initials(u.name))}</span>Глазами: ${esc2(label)} ▾`;
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
    hint.innerHTML = '<b>Логины для демо</b> (пароль любой):<br>demo: руководитель<br>master: мастер цеха<br>'
      + 'pechatnik: печатник, экран «Мои задания»<br>pereplet: переплётчик';
    form.appendChild(hint);
  });
})();

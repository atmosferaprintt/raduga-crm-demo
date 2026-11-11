'use strict';
/* Производство по операциям: очереди участков (мастер), «Мои задания» (сотрудник цеха),
   «Приёмка ОТК», журнал выработки с исправлениями, план и факт.
   Данные: /api/floor/*, задания создаются из техкарты заказа (floor.js на сервере). */

// ISO-время → «10.11 14:05» в часовом поясе компьютера
function fmtIso(iso, withDate = true) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return (withDate ? `${p(d.getDate())}.${p(d.getMonth() + 1)} ` : '') + `${p(d.getHours())}:${p(d.getMinutes())}`;
}
// ISO → значение для <input type="datetime-local"> в местном времени
function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Участки, машины и регламент цеха (причины паузы, поля результата); обновляется раз в минуту
let _floorRef = null, _floorRefAt = 0;
async function floorRef() {
  if (!_floorRef || Date.now() - _floorRefAt > 60000) { _floorRef = await api('/api/floor/areas'); _floorRefAt = Date.now(); }
  return _floorRef;
}
const reglOf = (ref) => (ref && ref.regl) || { reasons: [], fields: {}, qcOps: [] };

function opStatusBadge(op) {
  if (op.status === 'done') {
    if (op.qc_status === 'rework') return '<span class="op-st op-st-rework" title="' + esc(op.qc_note || '') + '">✓ Готово · ОТК вернул на доработку</span>';
    if (op.qc_status === 'ok') return `<span class="op-st op-st-done" title="Принял: ${esc(op.qc_by_name || '')}">✓ Принято ОТК</span>`;
    return '<span class="op-st op-st-done">✓ Готово</span>';
  }
  if (op.status === 'check') return '<span class="op-st op-st-check">Ждёт приёмки ОТК</span>';
  if (op.status === 'work') {
    return `<span class="op-st op-st-work">● В работе${op.workers && op.workers.length ? ': ' + esc(op.workers.join(', ')) : ''}</span>`;
  }
  if (op.status === 'paused') {
    const last = (op.logs || []).filter((l) => l.reason).slice(-1)[0];
    return `<span class="op-st op-st-paused">Пауза${last ? ': ' + esc(last.reason.toLowerCase()) : ''} · сделано ${fmtNum(op.done_qty)} из ${fmtNum(op.qty)}</span>`;
  }
  if (op.blockedBy && op.blockedBy.length) {
    return `<span class="op-st op-st-wait" title="Ждёт окончания: ${esc(op.blockedBy.join(', '))}">Ждёт: ${esc(op.blockedBy[0])}${
      op.blockedBy.length > 1 ? ` и ещё ${op.blockedBy.length - 1}` : ''}</span>`;
  }
  return '<span class="op-st op-st-ready">Можно начинать</span>';
}

// Кому назначено: имя или «общее на участке»
function opAssigneeHTML(op) {
  if (op.status === 'done' || op.status === 'check' || (op.status === 'work' && (op.workers || []).length)) return '';
  return op.assignee_id
    ? `<span class="op-who" title="Исполнитель">👤 ${esc(op.assignee_name || '')}</span>`
    : '<span class="op-who op-who-free" title="Возьмёт любой сотрудник участка">общее на участке</span>';
}

function opPlanFact(op) {
  const plan = op.plan_min != null ? `план ${op.approx ? '≈ ' : ''}${fmtMinutes(op.plan_min)}` : '';
  const fact = op.factMin > 0 ? `факт ${fmtMinutes(op.factMin)}` : '';
  return [plan, fact].filter(Boolean).join(' · ');
}

// Поля результата в одну строку: «Оттиски 1 200 л. · Приладка 60 л.»
function resultFieldsText(code, extra, ref) {
  const fields = (reglOf(ref).fields || {})[code] || [];
  const out = [];
  for (const f of fields) if (extra && extra[f.key] != null) out.push(`${f.label} ${fmtNum(extra[f.key])} ${f.unit}`);
  for (const [k, v] of Object.entries(extra || {})) if (!fields.some((f) => f.key === k)) out.push(`${k} ${fmtNum(v)}`);
  return out.join(' · ');
}

/* --- действия с заданием: начать, пауза, готово --- */

let _workers = null, _workersAt = 0;
async function floorWorkers() {
  if (!_workers || Date.now() - _workersAt > 60000) { _workers = await api('/api/floor/workers'); _workersAt = Date.now(); }
  return _workers;
}
// Кто может делать задание этого участка
const workersFor = (workers, op) => workers.filter((w) => w.work && (!w.areas.length || w.areas.includes(op.area_id)));

// Чьё задание отмечаем: сотрудник — всегда себя; мастер участка выбирает сотрудника
async function pickWorker(op, title, preferActive) {
  if (!canManageFloor(op.area_id)) return state.user.id;
  const workers = await floorWorkers();
  const active = (op.logs || []).filter((l) => !l.finished_at).map((l) => l.user_id);
  const list = workersFor(workers, op);
  if (!list.some((w) => w.id === state.user.id)) list.push({ id: state.user.id, name: state.user.name, title: 'сам' });
  const def = (preferActive && active[0]) || op.assignee_id || (list.find((w) => w.id !== state.user.id) || {}).id || state.user.id;
  return new Promise((resolve) => {
    const m = openModal({
      title,
      body: `<label class="fld"><span>Кто делает</span><select id="pw-sel">${list.map((w) =>
        `<option value="${w.id}" ${w.id === def ? 'selected' : ''}>${esc(w.name)}${w.title ? ` (${esc(w.title)})` : ''}${active.includes(w.id) ? ' · сейчас работает' : ''}</option>`).join('')}</select></label>
        <div class="muted small" style="margin-top:8px">В журнале будет видно, что отметили вы.</div>`,
      footer: `<button class="btn" data-act="cancel">Отмена</button><button class="btn btn-primary" data-act="ok">Дальше</button>`,
    });
    $('[data-act="cancel"]', m.foot).onclick = () => { m.close(); resolve(null); };
    $('[data-act="ok"]', m.foot).onclick = () => { const v = Number($('#pw-sel', m.body).value); m.close(); resolve(v); };
  });
}

async function opStart(op, onDone) {
  const uid = await pickWorker(op, `Начать: ${op.name}`, false);
  if (!uid) return;
  const send = (force) => api(`/api/floor/ops/${op.id}/start`, { method: 'POST', body: { user_id: uid, force } });
  try {
    await send(false);
  } catch (e) {
    if (e.status !== 409) { toastErr(e); return; }
    if (!await confirmDlg(e.message + '. Всё равно начать?', 'Начать')) return;
    try { await send(true); } catch (e2) { toastErr(e2); return; }
  }
  toast('Начато: ' + op.name, 'ok');
  if (onDone) onDone();
}

// «Взять себе»: общее задание участка становится моим
async function opTake(op, onDone) {
  try { await api(`/api/floor/ops/${op.id}/take`, { method: 'POST' }); toast('Задание ваше: ' + op.name, 'ok'); if (onDone) onDone(); }
  catch (e) { toastErr(e); }
}

// mode: 'pause' (причина + сколько успели) | 'finish' (годные, брак, поля по виду работы)
async function opStop(op, mode, onDone) {
  const uid = await pickWorker(op, (mode === 'finish' ? 'Готово: ' : 'Пауза: ') + op.name, true);
  if (!uid) return;
  const ref = await floorRef().catch(() => null);
  const regl = reglOf(ref);
  const fields = mode === 'finish' ? (regl.fields[op.code] || []) : [];
  const left = Math.max(0, (Number(op.qty) || 0) - (Number(op.done_qty) || 0));
  const reasons = regl.reasons && regl.reasons.length ? regl.reasons : ['Конец смены', 'Другое'];
  const m = openModal({
    title: mode === 'finish' ? `Готово: ${op.name}` : `Пауза: ${op.name}`,
    body: `
      <form id="op-stop-form" style="display:flex;flex-direction:column;gap:13px">
        <div class="muted small">Заказ № ${esc(op.order_number || '')} · ${esc(op.part || '')} · всего ${fmtNum(op.qty)} ${esc(op.unit)}${
          op.done_qty ? `, уже сделано ${fmtNum(op.done_qty)}` : ''}</div>
        ${mode === 'pause' ? `<div class="fld"><span>Причина паузы *</span><div class="reason-list">${reasons.map((r, i) =>
          `<label class="reason-chip"><input type="radio" name="reason" value="${esc(r)}" ${i === 0 ? 'checked' : ''}><span>${esc(r)}</span></label>`).join('')}</div></div>` : ''}
        <div class="form-grid">
          <label class="fld"><span>${mode === 'finish' ? 'Годных' : 'Сделано за эту смену'}, ${esc(op.unit)}</span>
            <input type="number" name="qty" min="0" step="any" inputmode="decimal" value="${mode === 'finish' ? r2js(left) : ''}"></label>
          <label class="fld"><span>Брак, ${esc(op.unit)}</span><input type="number" name="scrap" min="0" step="any" inputmode="decimal" value="0"></label>
          ${fields.map((f) => `<label class="fld"><span>${esc(f.label)}, ${esc(f.unit)}</span>
            <input type="number" name="x_${esc(f.key)}" min="0" step="any" inputmode="decimal"></label>`).join('')}
        </div>
        <label class="fld"><span>Комментарий</span><input type="text" name="note" placeholder="необязательно"></label>
        ${mode === 'finish' && op.qc ? '<div class="info-box">После этой операции работу принимает ОТК. Следующие операции начнутся после приёмки.</div>' : ''}
      </form>`,
    footer: `<button class="btn" data-act="cancel">Отмена</button>
             <button class="btn btn-primary" data-act="ok">${mode === 'finish' ? (op.qc ? 'Готово, на приёмку ОТК' : 'Задание выполнено') : 'Поставить на паузу'}</button>`,
  });
  const form = $('#op-stop-form', m.body);
  $('[data-act="cancel"]', m.foot).onclick = m.close;
  const submit = async () => {
    const f = new FormData(form);
    const num = (v) => Number(String(v || '0').replace(',', '.')) || 0;
    const extra = {};
    for (const fl of fields) { const v = f.get('x_' + fl.key); if (v !== null && String(v).trim() !== '') extra[fl.key] = num(v); }
    try {
      const r = await api(`/api/floor/ops/${op.id}/${mode === 'finish' ? 'finish' : 'pause'}`, {
        method: 'POST', body: { user_id: uid, qty: num(f.get('qty')), scrap: num(f.get('scrap')), note: f.get('note') || '',
          reason: f.get('reason') || '', extra },
      });
      m.close();
      toast(r.orderReady ? 'Все задания заказа выполнены: заказ готов'
        : r.toQc ? 'Готово: работа ушла на приёмку ОТК' : (mode === 'finish' ? 'Задание выполнено' : 'На паузе'), 'ok');
      if (onDone) onDone();
    } catch (e) { toastErr(e); }
  };
  $('[data-act="ok"]', m.foot).onclick = submit;
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
}
const r2js = (x) => Math.round(x * 100) / 100;

async function opReopen(op, onDone) {
  if (!await confirmDlg(`Вернуть «${op.name}» в работу? Отметка «готово» снимется.`, 'Вернуть')) return;
  try { await api(`/api/floor/ops/${op.id}/reopen`, { method: 'POST' }); toast('Задание возвращено в работу', 'ok'); if (onDone) onDone(); }
  catch (e) { toastErr(e); }
}

// Мастер назначает исполнителя: человек участка или «общее»
async function opAssign(op, onDone) {
  const workers = workersFor(await floorWorkers(), op);
  const m = openModal({
    title: 'Исполнитель: ' + op.name,
    body: `<div class="muted small" style="margin-bottom:10px">Заказ № ${esc(op.order_number || '')} · ${esc(op.part || '')} · ${esc(op.area_name || '')}</div>
      <div class="reason-list">
        <label class="reason-chip"><input type="radio" name="who" value="" ${op.assignee_id ? '' : 'checked'}><span>Общее на участке: возьмёт любой</span></label>
        ${workers.map((w) => `<label class="reason-chip"><input type="radio" name="who" value="${w.id}" ${op.assignee_id === w.id ? 'checked' : ''}>
          <span>${esc(w.name)}${w.title ? ` <span class="muted small">${esc(w.title)}</span>` : ''}</span></label>`).join('')}
      </div>
      ${workers.length ? '' : '<div class="muted small" style="margin-top:8px">На этом участке пока нет сотрудников с правом выполнять задания.</div>'}`,
    footer: `<button class="btn" data-act="cancel">Отмена</button><button class="btn btn-primary" data-act="ok">Назначить</button>`,
  });
  $('[data-act="cancel"]', m.foot).onclick = m.close;
  $('[data-act="ok"]', m.foot).onclick = async () => {
    const v = ($('input[name="who"]:checked', m.body) || {}).value || '';
    try {
      await api(`/api/floor/ops/${op.id}/assign`, { method: 'POST', body: { user_id: v ? Number(v) : null } });
      m.close();
      toast(v ? 'Исполнитель назначен' : 'Задание общее для участка', 'ok');
      if (onDone) onDone();
    } catch (e) { toastErr(e); }
  };
}

// ОТК: принять или вернуть на доработку
async function opQc(op, mode, onDone) {
  const ref = await floorRef().catch(() => null);
  const res = (op.logs || []).map((l) => resultFieldsText(op.code, l.extra, ref)).filter(Boolean).join('; ');
  const scrap = (op.logs || []).reduce((s2, l) => s2 + (l.scrap || 0), 0);
  const who = [...new Set((op.logs || []).map((l) => l.user_name).filter(Boolean))].join(', ');
  const m = openModal({
    title: (mode === 'accept' ? 'Принять: ' : 'На доработку: ') + op.name,
    body: `<form id="qc-form" style="display:flex;flex-direction:column;gap:13px">
      <div class="qc-facts">
        <div>Заказ <b>№ ${esc(op.order_number || '')}</b> · ${esc(op.part || '')} · ${esc(op.area_name || '')}${op.machine_name ? ', ' + esc(op.machine_name) : ''}</div>
        <div>Сделал: <b>${esc(who || '—')}</b> · сдано ${fmtNum(op.done_qty)} из ${fmtNum(op.qty)} ${esc(op.unit)}${scrap ? ` · брак ${fmtNum(scrap)}` : ''}</div>
        ${res ? `<div class="muted small">${esc(res)}</div>` : ''}
      </div>
      ${mode === 'accept'
        ? `<label class="fld"><span>Принято, ${esc(op.unit)}</span><input type="number" name="qty" min="0" step="any" value="${r2js(op.done_qty)}"></label>
           <label class="fld"><span>Замечания</span><input type="text" name="note" placeholder="необязательно"></label>`
        : `<label class="fld"><span>Переделать, ${esc(op.unit)}</span><input type="number" name="qty" min="0" step="any" value="${r2js(op.done_qty)}"></label>
           <label class="fld"><span>Что не так *</span><textarea name="note" rows="3" required placeholder="Например: полосы на 20 листах, не та плотность"></textarea></label>
           <div class="muted small">Создастся отдельное задание «Доработка» тому же исполнителю, со своей историей. Следующие операции подождут его.</div>`}
    </form>`,
    footer: `<button class="btn" data-act="cancel">Отмена</button>
      <button class="btn ${mode === 'accept' ? 'btn-primary' : 'btn-danger'}" data-act="ok">${mode === 'accept' ? 'Принять' : 'Вернуть на доработку'}</button>`,
  });
  const form = $('#qc-form', m.body);
  $('[data-act="cancel"]', m.foot).onclick = m.close;
  $('[data-act="ok"]', m.foot).onclick = async () => {
    if (!form.reportValidity()) return;
    const f = new FormData(form);
    try {
      const r = await api(`/api/floor/ops/${op.id}/${mode}`, { method: 'POST', body: { qty: f.get('qty'), note: f.get('note') || '' } });
      m.close();
      toast(r.orderReady ? 'Принято. Все задания заказа выполнены: заказ готов' : mode === 'accept' ? 'Принято' : 'Отправлено на доработку', 'ok');
      if (onDone) onDone();
    } catch (e) { toastErr(e); }
  };
}

// Кнопки действий по статусу задания (мастер участка; ОТК видит свои кнопки)
function opActionsHTML(op) {
  const b = (act, label, cls = '') => `<button class="btn btn-sm ${cls}" data-op-act="${act}" data-op="${op.id}">${label}</button>`;
  const manage = canManageFloor(op.area_id);
  if (op.status === 'check') {
    const out = [];
    if (can('floor.qc', op.area_id)) {
      if ((op.doers || []).includes(state.user.id)) out.push('<span class="muted small">свою работу принимает другой</span>');
      else out.push(b('accept', 'Принять', 'btn-primary'), b('rework', 'На доработку'));
    }
    if (manage) out.push(b('reopen', 'Вернуть', 'btn-ghost'));
    return out.join('');
  }
  if (op.status === 'done') return manage ? b('reopen', 'Вернуть', 'btn-ghost') : '';
  if (!manage) return '';
  const out = [];
  out.push(b('start', op.status === 'paused' ? 'Продолжить' : 'Начать', op.status === 'work' ? '' : 'btn-primary'));
  if (op.status === 'work') out.push(b('pause', 'Пауза'));
  out.push(b('finish', 'Готово', op.status === 'work' ? 'btn-primary' : ''));
  out.push(b('assign', op.assignee_id ? 'Сменить исполнителя' : 'Назначить', 'btn-ghost'));
  return out.join('');
}

function bindOpActions(root, ops, onDone) {
  $$('[data-op-act]', root).forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const op = ops.find((o) => String(o.id) === btn.dataset.op);
    if (!op) return;
    const a = btn.dataset.opAct;
    if (a === 'start') opStart(op, onDone);
    else if (a === 'pause') opStop(op, 'pause', onDone);
    else if (a === 'finish') opStop(op, 'finish', onDone);
    else if (a === 'reopen') opReopen(op, onDone);
    else if (a === 'assign') opAssign(op, onDone);
    else if (a === 'take') opTake(op, onDone);
    else if (a === 'accept' || a === 'rework') opQc(op, a, onDone);
  }));
}

// Исправление отметки: мастер участка или директор, причина обязательна, исходное значение остаётся
async function fixLogDialog(r, onDone) {
  const LBL = { started_at: 'Начало', finished_at: 'Окончание', qty: 'Сделано', scrap: 'Брак' };
  const val = (f, v) => (f.endsWith('_at') ? fmtIso(v) : fmtNum(v));
  const m = openModal({
    title: 'Исправить отметку',
    body: `<form id="fix-form" style="display:flex;flex-direction:column;gap:13px">
      <div class="muted small">${esc(r.user_name || '')} · «${esc(r.op_name || '')}» · заказ № ${esc(r.order_number || '')}</div>
      <div class="form-grid">
        <label class="fld"><span>Начало</span><input type="datetime-local" name="started_at" value="${isoToLocalInput(r.started_at)}"></label>
        <label class="fld"><span>Окончание</span><input type="datetime-local" name="finished_at" value="${isoToLocalInput(r.finished_at)}" ${r.finished_at ? '' : 'disabled title="Смена ещё идёт"'}></label>
        <label class="fld"><span>Сделано, ${esc(r.unit || '')}</span><input type="number" name="qty" min="0" step="any" value="${r.qty || 0}"></label>
        <label class="fld"><span>Брак</span><input type="number" name="scrap" min="0" step="any" value="${r.scrap || 0}"></label>
      </div>
      <label class="fld"><span>Причина исправления *</span><input type="text" name="reason" required placeholder="Например: забыл нажать «пауза» в конце смены"></label>
      ${(r.fixes || []).length ? `<div class="fix-hist"><b>Уже исправляли:</b>${r.fixes.map((x) => `<div>${fmtDateTime(x.created_at)} · ${esc(x.by_name || '')}:
        ${esc(LBL[x.field] || x.field)} было <s>${esc(val(x.field, x.old_value))}</s>, стало ${esc(val(x.field, x.new_value))}. ${esc(x.reason)}</div>`).join('')}</div>` : ''}
      <div class="muted small">Исходная запись сохранится, исправление попадёт в журнал действий.</div>
    </form>`,
    footer: `<button class="btn" data-act="cancel">Отмена</button><button class="btn btn-primary" data-act="ok">Исправить</button>`,
  });
  const form = $('#fix-form', m.body);
  $('[data-act="cancel"]', m.foot).onclick = m.close;
  $('[data-act="ok"]', m.foot).onclick = async () => {
    if (!form.reportValidity()) return;
    const f = new FormData(form);
    const iso = (v) => (v ? new Date(v).toISOString() : undefined);
    const body = { reason: f.get('reason'), qty: f.get('qty'), scrap: f.get('scrap') };
    // время отправляем, только если его поменяли (до минуты)
    if (f.get('started_at') && f.get('started_at') !== isoToLocalInput(r.started_at)) body.started_at = iso(f.get('started_at'));
    if (f.get('finished_at') && f.get('finished_at') !== isoToLocalInput(r.finished_at)) body.finished_at = iso(f.get('finished_at'));
    try {
      await api(`/api/floor/log/${r.id}/fix`, { method: 'POST', body });
      m.close();
      toast('Отметка исправлена, исходная запись сохранена', 'ok');
      if (onDone) onDone();
    } catch (e) { toastErr(e); }
  };
}

/* ================= ПРОИЗВОДСТВО (мастер, руководитель, менеджеры смотрят) ================= */

views.production = async function (box, arg, query) {
  await Promise.all([loadUsers(), loadSchema().catch(() => null)]);
  const TABS = [['queue', 'Очереди участков'], ['orders', 'Заказы в производстве'], ['journal', 'Журнал выработки'], ['report', 'План и факт']];
  let tab = TABS.some(([k]) => k === (query && query.get('tab'))) ? query.get('tab') : 'queue';
  box.innerHTML = `
    <div class="tabs" id="floor-tabs">${TABS.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${l}</button>`).join('')}</div>
    <div id="floor-body"><div class="empty-note">Загрузка…</div></div>`;
  const body = $('#floor-body', box);
  let timer = null;
  const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };
  // живое обновление очередей, пока экран открыт
  const keepFresh = (fn) => {
    stopTimer();
    timer = setInterval(() => {
      if (!box.isConnected) { stopTimer(); return; }
      if (document.querySelector('.modal-overlay') || document.querySelector('.fq-card.dragging')) return;
      fn().catch(() => {});
    }, 30000);
  };

  $$('#floor-tabs button', box).forEach((b) => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    $$('#floor-tabs button', box).forEach((x) => x.classList.toggle('active', x === b));
    render();
  }));

  /* --- очереди участков --- */
  let selArea = null;
  try { selArea = localStorage.getItem('floorArea'); } catch { /* приватный режим */ }

  async function renderQueue() {
    const [ref, ops] = await Promise.all([api('/api/floor/areas'), api('/api/floor/queue')]);
    const areas = ref.areas.filter((a) => a.kind !== 'outsource' || ops.some((o) => o.area_id === a.id));
    const open = (a) => ops.filter((o) => o.area_id === a.id && o.status !== 'done');
    if (!selArea || !areas.some((a) => a.id === selArea)) selArea = (areas.find((a) => open(a).length) || areas[0] || {}).id;
    const area = areas.find((a) => a.id === selArea);
    const manage = canManageFloor(selArea);
    const auto = area && area.queue === 'auto';

    const chips = areas.map((a) => {
      const n = open(a).length, w = open(a).filter((o) => o.status === 'work').length;
      return `<button class="fq-area${a.id === selArea ? ' active' : ''}${n ? '' : ' empty'}" data-area="${esc(a.id)}">
        ${esc(a.name)} <span class="fq-cnt">${n}</span>${w ? `<span class="fq-work" title="в работе">● ${w}</span>` : ''}</button>`;
    }).join('');

    if (!ops.length) {
      body.innerHTML = `<div class="fq-areas">${chips}</div>
        <div class="panel empty-note">Пока нет заданий. Переведите заказ в статус «Производство»: задания участкам
          создадутся из его техкарты (книги 7БЦ и брошюры). Заказы других видов продукции видны на вкладке «Заказы в производстве».</div>`;
      bindChips();
      return;
    }

    const areaOps = ops.filter((o) => o.area_id === selArea);
    const machines = ref.machines.filter((m) => m.areaId === selArea);
    const cols = [...machines.map((m) => ({ id: m.id, name: m.name })), { id: '', name: 'Вручную, без машины' }]
      .filter((c) => c.id !== '' || !machines.length || areaOps.some((o) => !o.machine_id));

    const card = (o) => `
      <div class="fq-card st-${o.status}${o.blockedBy.length && o.status === 'todo' ? ' blocked' : ''}" data-id="${o.id}"
        draggable="${manage && o.status !== 'done' ? 'true' : 'false'}">
        <div class="fq-top"><a href="#/orders/${o.order_id}" class="fq-num">№ ${esc(o.order_number)}</a>
          <span>${o.due_date ? `срок ${orderDueHTML(o.due_date)}` : ''}</span></div>
        <div class="fq-title">${esc(o.order_title || '')}${o.client_name ? ` <span class="muted">· ${esc(o.client_name)}</span>` : ''}</div>
        <div class="fq-op"><b>${esc(o.name)}</b> · ${esc(o.part)}${o.rework_of ? ' <span class="badge st-cancelled">доработка</span>' : ''}</div>
        <div class="fq-meta">${fmtNum(o.qty)} ${esc(o.unit)}${o.qty_note ? ` <span class="muted">(${esc(o.qty_note)})</span>` : ''}</div>
        <div class="fq-meta muted">${opPlanFact(o)}</div>
        ${o.note ? `<div class="fq-note">${esc(o.note)}</div>` : ''}
        <div class="fq-foot">${opStatusBadge(o)}${opAssigneeHTML(o)}</div>
        <div class="fq-actions">${opActionsHTML(o)}</div>
      </div>`;

    body.innerHTML = `
      <div class="fq-areas">${chips}</div>
      <div class="muted small fq-hint">${auto
        ? 'Очередь этого участка формируется автоматически: по сроку сдачи заказа. Перетаскивать можно между машинами.'
        : manage ? 'Очередь ставит мастер: перетащите карточку выше или ниже, или на другую машину. Сверху то, что делать первым.'
            + ' Кнопка «Назначить» отдаёт задание конкретному сотруднику, иначе его возьмёт любой с участка.'
          : 'Очередь ставит мастер участка.'}
        ${manage ? ' <a href="#/work">Экран сотрудника →</a>' : ''}</div>
      <div class="fq-board" style="grid-template-columns: repeat(${cols.length}, minmax(260px, 380px))">
        ${cols.map((c) => {
          const list = areaOps.filter((o) => (o.machine_id || '') === c.id);
          const active = list.filter((o) => o.status !== 'done');
          const done = list.filter((o) => o.status === 'done');
          const planLeft = active.reduce((s, o) => s + Math.max(0, (o.plan_min || 0) - (o.factMin || 0)), 0);
          return `<div class="fq-col" data-machine="${esc(c.id)}">
            <div class="fq-col-head"><span>${esc(c.name)}</span><span class="muted small">${active.length} · ${fmtMinutes(planLeft)}</span></div>
            <div class="fq-cards">${active.map(card).join('') || '<div class="muted small fq-empty">Свободно</div>'}</div>
            ${done.length ? `<details class="fq-done"><summary>Выполнено за сутки: ${done.length}</summary>${done.map(card).join('')}</details>` : ''}
          </div>`;
        }).join('')}
      </div>`;
    bindChips();
    bindOpActions(body, ops, renderQueue);
    if (manage) bindDrag(auto);
  }

  function bindChips() {
    $$('.fq-area', body).forEach((b) => b.addEventListener('click', () => {
      selArea = b.dataset.area;
      try { localStorage.setItem('floorArea', selArea); } catch { /* ничего */ }
      renderQueue().catch(toastErr);
    }));
  }

  // Перетаскивание: порядок внутри машины (ручная очередь) и перенос на другую машину
  function bindDrag(auto) {
    let dragId = null;
    $$('.fq-card[draggable="true"]', body).forEach((c) => {
      c.addEventListener('dragstart', (e) => { dragId = c.dataset.id; c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); });
      c.addEventListener('dragend', () => { c.classList.remove('dragging'); dragId = null; });
    });
    $$('.fq-col', body).forEach((col) => {
      const cards = $('.fq-cards', col);
      col.addEventListener('dragover', (e) => {
        if (!dragId) return;
        e.preventDefault();
        col.classList.add('drag-over');
        if (auto) return;
        const dragging = $('.fq-card.dragging', body);
        const after = [...cards.querySelectorAll('.fq-card:not(.dragging)')].find((x) => {
          const r = x.getBoundingClientRect();
          return e.clientY < r.top + r.height / 2;
        });
        if (dragging) { if (after) cards.insertBefore(dragging, after); else cards.appendChild(dragging); }
      });
      col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over'); });
      col.addEventListener('drop', async (e) => {
        e.preventDefault();
        col.classList.remove('drag-over');
        const id = e.dataTransfer.getData('text/plain');
        if (!id) return;
        try {
          const machine = col.dataset.machine;
          const ops = await api('/api/floor/queue');
          const op = ops.find((o) => String(o.id) === id);
          if (op && (op.machine_id || '') !== machine) {
            await api('/api/floor/ops/' + id, { method: 'PUT', body: { machine_id: machine } });
          }
          if (!auto) {
            const ids = [...cards.querySelectorAll('.fq-card')].map((x) => x.dataset.id);
            await api('/api/floor/reorder', { method: 'POST', body: { ids } });
          }
        } catch (err) { toastErr(err); }
        renderQueue().catch(toastErr);
      });
    });
  }

  /* --- заказы в производстве --- */
  async function renderOrders() {
    const [orders, ops] = await Promise.all([api('/api/orders?status=production'), api('/api/floor/queue')]);
    orders.sort((a, b) => (a.due_date || '9999') < (b.due_date || '9999') ? -1 : 1);
    if (!orders.length) {
      body.innerHTML = '<div class="panel empty-note">Нет заказов в производстве. Переведите заказ в статус «Производство».</div>';
      return;
    }
    const manage = canManageFloor();
    body.innerHTML = `<div class="panel tbl-wrap"><table class="tbl">
      <thead><tr><th>Заказ</th><th>Срок</th><th>Выполнено</th><th>Сейчас</th><th></th></tr></thead>
      <tbody>${orders.map((o) => {
        const mine = ops.filter((x) => x.order_id === o.id);
        const working = mine.filter((x) => x.status === 'work');
        const total = o.ops_total || 0, done = o.ops_done || 0;
        const pct = total ? Math.round((done / total) * 100) : 0;
        const now = working.length ? working.map((x) => `${esc(x.name)} <span class="muted">(${esc(x.area_name)})</span>`).join('<br>')
          : total ? (mine.filter((x) => x.status !== 'done' && !x.blockedBy.length).slice(0, 2).map((x) => `<span class="muted">ждёт начала:</span> ${esc(x.name)}`).join('<br>') || '—') : '';
        return `<tr class="clickable" data-id="${o.id}">
          <td><b>№ ${esc(o.number)}</b><div class="small">${esc(o.title || typeLabel(o.product_type))}</div>
            <div class="muted small">${esc(o.client_name || '')}</div></td>
          <td>${orderDueHTML(o.due_date)}</td>
          <td style="min-width:170px">${total ? `<div class="fq-progress"><div style="width:${pct}%"></div></div>
            <div class="small">${done} из ${total} заданий</div>` : `<div class="small muted">без техкарты</div>
            <select class="fo-stage" data-id="${o.id}" ${manage ? '' : 'disabled'}>${PROD_STAGES.filter((s) => s.key).map((s) =>
              `<option value="${s.key}" ${(o.prod_stage || 'print') === s.key ? 'selected' : ''}>${s.label}</option>`).join('')}</select>`}</td>
          <td class="small">${now}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-sm fo-tz" data-id="${o.id}">ТЗ</button>
            ${!total && manage && TC_TYPES.includes(o.product_type) ? `<button class="btn btn-sm fo-gen" data-id="${o.id}">Создать задания</button>` : ''}
            ${!total && manage ? `<button class="btn btn-sm fo-ready" data-id="${o.id}">→ Готов</button>` : ''}
          </td></tr>`;
      }).join('')}</tbody></table></div>
      <div class="muted small" style="margin-top:8px">Заказы с техкартой переходят в «Готов» сами, когда выполнено последнее задание.
        Для заказов без техкарты (листовая, блокноты, УФ, плоттер) этап ставится вручную или мастер добавляет задания сам.</div>`;
    $$('tr.clickable', body).forEach((tr) => tr.addEventListener('click', (e) => {
      if (e.target.closest('button, select')) return;
      navigate('#/orders/' + tr.dataset.id);
    }));
    $$('.fo-tz', body).forEach((b) => b.addEventListener('click', () => {
      const o = orders.find((x) => String(x.id) === b.dataset.id);
      if (o) printTechTask(o);
    }));
    $$('.fo-gen', body).forEach((b) => b.addEventListener('click', async () => {
      try { const r = await api(`/api/orders/${b.dataset.id}/ops/generate`, { method: 'POST', body: {} }); toast(`Создано заданий: ${r.created}`, 'ok'); renderOrders(); }
      catch (e) { toastErr(e); }
    }));
    $$('.fo-ready', body).forEach((b) => b.addEventListener('click', async () => {
      try { await api('/api/orders/' + b.dataset.id, { method: 'PUT', body: { status: 'ready' } }); toast('Заказ готов', 'ok'); renderOrders(); }
      catch (e) { toastErr(e); }
    }));
    $$('.fo-stage', body).forEach((s) => s.addEventListener('change', async () => {
      try { await api('/api/orders/' + s.dataset.id, { method: 'PUT', body: { prod_stage: s.value } }); toast('Этап изменён', 'ok'); }
      catch (e) { toastErr(e); }
    }));
  }

  /* --- журнал выработки --- */
  async function renderJournal() {
    const [ref, workers] = await Promise.all([floorRef(), api('/api/floor/workers')]);
    const d0 = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
    body.innerHTML = `
      <div class="toolbar" style="margin-bottom:12px">
        <label class="small">с <input type="date" id="fj-from" value="${d0}"></label>
        <label class="small">по <input type="date" id="fj-to" value="${todayISO()}"></label>
        <select id="fj-user"><option value="">Все сотрудники</option>${workers.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select>
        <select id="fj-area"><option value="">Все участки</option>${ref.areas.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select>
        <button class="btn btn-sm" id="fj-csv">Выгрузить в Excel</button>
      </div>
      <div id="fj-out"></div>`;
    const out = $('#fj-out', body);
    let lastRows = [];
    $('#fj-csv', body).addEventListener('click', () => {
      if (!lastRows.length) { toast('Нечего выгружать', 'error'); return; }
      downloadCSV(`журнал-выработки-${todayISO()}.csv`,
        ['Начало', 'Окончание', 'Минут', 'Сотрудник', 'Отметил', 'Участок', 'Машина', 'Заказ', 'Операция', 'Часть', 'Сделано', 'Ед.', 'Брак', 'Примечание'],
        lastRows.map((r) => [fmtIso(r.started_at), r.finished_at ? fmtIso(r.finished_at) : 'идёт', Math.round(r.minutes), r.user_name || '',
          r.by_user_id !== r.user_id ? r.by_name || '' : '', r.area_name || '', r.machine_name || '', r.order_number, r.op_name, r.part || '',
          r.qty || 0, r.unit || '', r.scrap || 0,
          [r.reason ? 'Пауза: ' + r.reason : '', resultFieldsText(r.code, r.extra, ref), r.note || '', (r.fixes || []).length ? 'исправлено' : '']
            .filter(Boolean).join('; ')]));
    });
    async function load() {
      const from = $('#fj-from', body).value, to = $('#fj-to', body).value;
      const qs = new URLSearchParams();
      if (from) qs.set('from', new Date(from + 'T00:00:00').toISOString());
      if (to) qs.set('to', new Date(to + 'T23:59:59').toISOString());
      if ($('#fj-user', body).value) qs.set('user_id', $('#fj-user', body).value);
      if ($('#fj-area', body).value) qs.set('area_id', $('#fj-area', body).value);
      const rows = await api('/api/floor/journal?' + qs);
      lastRows = rows;
      if (!rows.length) { out.innerHTML = '<div class="panel empty-note">За этот период отметок нет</div>'; return; }
      const totalMin = rows.reduce((s, r) => s + (r.minutes || 0), 0);
      // свод по сотрудникам: сколько смен и времени
      const byUser = new Map();
      for (const r of rows) {
        const k = r.user_name || '—';
        const u = byUser.get(k) || { name: k, n: 0, min: 0 };
        u.n++; u.min += r.minutes || 0; byUser.set(k, u);
      }
      out.innerHTML = `
        <div class="fj-sum">${[...byUser.values()].map((u) => `<div class="tile"><div class="t-label">${esc(u.name)}</div>
          <div class="t-value">${fmtMinutes(u.min)}</div><div class="muted small">отметок: ${u.n}</div></div>`).join('')}</div>
        <div class="panel tbl-wrap"><table class="tbl">
        <thead><tr><th>Начало</th><th>Окончание</th><th class="num">Время</th><th>Сотрудник</th><th>Участок, машина</th>
          <th>Заказ</th><th>Операция</th><th class="num">Сделано</th><th class="num">Брак</th><th>Примечание</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${fmtIso(r.started_at)}</td>
          <td>${r.finished_at ? fmtIso(r.finished_at) : '<span class="op-st op-st-work">● идёт</span>'}</td>
          <td class="num">${fmtMinutes(r.minutes)}</td>
          <td>${esc(r.user_name || '—')}${r.by_name && r.by_user_id !== r.user_id ? `<div class="muted small">отметил: ${esc(r.by_name)}</div>` : ''}</td>
          <td>${esc(r.area_name || '')}${r.machine_name ? `<div class="muted small">${esc(r.machine_name)}</div>` : ''}</td>
          <td><a href="#/orders/${r.order_id}">№ ${esc(r.order_number)}</a></td>
          <td>${esc(r.op_name)} <span class="muted small">· ${esc(r.part || '')}</span></td>
          <td class="num">${r.qty ? fmtNum(r.qty) + ' ' + esc(r.unit || '') : ''}</td>
          <td class="num">${r.scrap ? fmtNum(r.scrap) : ''}</td>
          <td class="small">${r.reason ? `<span class="op-st op-st-paused">пауза: ${esc(r.reason)}</span> ` : ''}${esc(resultFieldsText(r.code, r.extra, ref))}
            ${r.note ? `<div>${esc(r.note)}</div>` : ''}
            ${(r.fixes || []).length ? `<div class="fix-mark" title="${esc(r.fixes.map((x) => `${fmtDateTime(x.created_at)} ${x.by_name || ''}: ${x.reason}`).join('\n'))}">✎ исправлено${r.fixes.length > 1 ? ' ' + r.fixes.length + ' раза' : ''}: ${esc(r.fixes[r.fixes.length - 1].reason)}</div>` : ''}</td>
          <td>${r.canFix ? `<button class="btn btn-sm btn-ghost fj-fix" data-id="${r.id}" title="Исправить отметку: с причиной, исходная запись сохранится">Исправить</button>` : ''}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="2">Итого отметок: ${rows.length}</td><td class="num">${fmtMinutes(totalMin)}</td><td colspan="8"></td></tr></tfoot>
        </table></div>`;
      $$('.fj-fix', out).forEach((b) => b.addEventListener('click', () => {
        const r = rows.find((x) => String(x.id) === b.dataset.id);
        if (r) fixLogDialog(r, () => load().catch(toastErr));
      }));
    }
    $$('#fj-from, #fj-to, #fj-user, #fj-area', body).forEach((el) => el.addEventListener('change', () => load().catch(toastErr)));
    await load();
  }

  /* --- план и факт: время и себестоимость по сотрудникам, машинам, заказам --- */
  async function renderReport() {
    const d0 = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    body.innerHTML = `
      <div class="toolbar" style="margin-bottom:12px">
        <label class="small">с <input type="date" id="fr-from" value="${d0}"></label>
        <label class="small">по <input type="date" id="fr-to" value="${todayISO()}"></label>
        <button class="btn btn-sm" id="fr-csv">Выгрузить в Excel</button>
      </div>
      <div id="fr-out"></div>`;
    const out = $('#fr-out', body);
    let last = null;
    const dev = (plan, fact) => {
      if (!(plan > 0) || !(fact > 0)) return '<span class="muted">—</span>';
      const p = Math.round((fact / plan - 1) * 100);
      return `<span class="${p > 15 ? 'overdue' : p < -15 ? 'tc-ok' : ''}">${p > 0 ? '+' : ''}${p}%</span>`;
    };
    const money = (x) => (x > 0 ? fmtMoney(x) : '<span class="muted">—</span>');
    async function load() {
      const qs = new URLSearchParams();
      const from = $('#fr-from', body).value, to = $('#fr-to', body).value;
      if (from) qs.set('from', new Date(from + 'T00:00:00').toISOString());
      if (to) qs.set('to', new Date(to + 'T23:59:59').toISOString());
      const r = last = await api('/api/floor/report?' + qs);
      const T = r.totals;
      if (!T.sessions && !T.opsDone) { out.innerHTML = '<div class="panel empty-note">За этот период отметок цеха нет</div>'; return; }
      out.innerHTML = `
        <div class="stat-tiles">
          <div class="tile"><div class="t-label">Отработано (факт)</div><div class="t-value">${fmtMinutes(T.factMin)}</div>
            <div class="muted small">отметок: ${T.sessions}</div></div>
          <div class="tile"><div class="t-label">Выполнено заданий</div><div class="t-value">${fmtNum(T.opsDone)}</div></div>
          <div class="tile"><div class="t-label">По ним план / факт</div><div class="t-value">${fmtMinutes(T.planMin)} / ${fmtMinutes(T.planFactMin)}</div>
            <div class="small">${dev(T.planMin, T.planFactMin)}</div></div>
          ${r.costHidden ? '' : `<div class="tile"><div class="t-label">Себестоимость факт</div><div class="t-value">${T.factCost > 0 ? fmtMoney(T.factCost) : '—'}</div>
            <div class="muted small">${T.factCost > 0 ? '' : 'задайте ставки в Настройках → Производство'}</div></div>`}
        </div>
        ${(r.byReason || []).length ? `<div class="panel panel-pad" style="margin-bottom:16px"><h3>Паузы и простои по причинам</h3>
          <div class="muted small" style="margin:-6px 0 10px">Сколько раз ставили на паузу и сколько задания стояли до следующего начала.</div>
          <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Причина</th><th class="num">Пауз</th><th class="num">Стояло</th></tr></thead>
          <tbody>${r.byReason.map((x) => `<tr><td>${esc(x.reason)}</td><td class="num">${x.n}</td><td class="num"><b>${fmtMinutes(x.idleMin)}</b></td></tr>`).join('')}</tbody>
          </table></div></div>` : ''}
        <div class="analytics-cols">
          <div class="panel panel-pad"><h3>Сотрудники</h3><div class="tbl-wrap"><table class="tbl">
            <thead><tr><th>Сотрудник</th><th class="num">Отметок</th><th class="num">Заданий</th><th class="num">Время</th><th class="num">Брак</th></tr></thead>
            <tbody>${r.byWorker.map((w) => `<tr><td>${esc(w.name)}</td><td class="num">${w.sessions}</td><td class="num">${w.ops}</td>
              <td class="num"><b>${fmtMinutes(w.factMin)}</b></td><td class="num">${w.scrap ? fmtNum(w.scrap) : ''}</td></tr>`).join('')}</tbody></table></div></div>
          <div class="panel panel-pad"><h3>Машины и участки</h3><div class="tbl-wrap"><table class="tbl">
            <thead><tr><th>Участок, машина</th><th class="num">Факт</th><th class="num">План вып.</th><th class="num">Откл.</th>${r.costHidden ? '' : '<th class="num">Себест.</th>'}</tr></thead>
            <tbody>${r.byMachine.map((m) => `<tr><td>${esc(m.area)}<div class="muted small">${esc(m.machine)}</div></td>
              <td class="num"><b>${fmtMinutes(m.factMin)}</b></td><td class="num">${fmtMinutes(m.planMin)}</td>
              <td class="num">${dev(m.planMin, m.factMin)}</td>${r.costHidden ? '' : `<td class="num">${money(m.factCost)}</td>`}</tr>`).join('')}</tbody></table></div></div>
        </div>
        <div class="panel panel-pad" style="margin-top:16px"><h3>Заказы: план и факт по выполненным заданиям</h3><div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>Заказ</th><th class="num">Заданий</th><th class="num">План</th><th class="num">Факт</th><th class="num">Откл.</th>
            ${r.costHidden ? '' : '<th class="num">Себест. план</th><th class="num">Себест. факт</th>'}</tr></thead>
          <tbody>${r.byOrder.map((o) => `<tr class="clickable" data-id="${o.id}"><td><b>№ ${esc(o.number)}</b> <span class="muted small">${esc(o.title || '')}</span></td>
            <td class="num">${o.opsDone}</td><td class="num">${fmtMinutes(o.planMin)}</td><td class="num">${fmtMinutes(o.factMin)}</td>
            <td class="num">${dev(o.planMin, o.factMin)}</td>${r.costHidden ? '' : `<td class="num">${money(o.planCost)}</td><td class="num">${money(o.factCost)}</td>`}</tr>`).join('')
            || '<tr><td colspan="7" class="muted">Выполненных заданий нет</td></tr>'}</tbody></table></div></div>
        ${r.deviations.length ? `<div class="panel panel-pad" style="margin-top:16px"><h3>Где факт сильнее всего отличается от плана</h3>
          <div class="muted small" style="margin:-6px 0 10px">По этим операциям стоит уточнить нормы в Настройках → Производство.</div>
          <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>Операция</th><th>Заказ</th><th>Участок, машина</th><th class="num">План</th><th class="num">Факт</th><th class="num">Откл.</th></tr></thead>
          <tbody>${r.deviations.map((x) => `<tr><td>${esc(x.name)} <span class="muted small">· ${esc(x.part || '')}</span></td><td>№ ${esc(x.order_number)}</td>
            <td>${esc(x.area || '')}<div class="muted small">${esc(x.machine || '')}</div></td>
            <td class="num">${fmtMinutes(x.planMin)}</td><td class="num">${fmtMinutes(x.factMin)}</td><td class="num">${dev(x.planMin, x.factMin)}</td></tr>`).join('')}</tbody>
          </table></div></div>` : ''}`;
      $$('tr.clickable', out).forEach((tr) => tr.addEventListener('click', () => navigate('#/orders/' + tr.dataset.id)));
    }
    $('#fr-csv', body).addEventListener('click', () => {
      if (!last) return;
      const m = (x) => Math.round(x || 0);
      downloadCSV(`план-факт-${todayISO()}.csv`, ['Раздел', 'Название', 'Подробно', 'План, мин', 'Факт, мин', 'Себест. план, ₽', 'Себест. факт, ₽'], [
        ...last.byWorker.map((w) => ['Сотрудник', w.name, `отметок ${w.sessions}, заданий ${w.ops}, брак ${w.scrap || 0}`, '', m(w.factMin), '', '']),
        ...last.byMachine.map((x) => ['Машина/участок', x.area, x.machine, m(x.planMin), m(x.factMin), '', x.factCost || '']),
        ...last.byOrder.map((o) => ['Заказ', '№ ' + o.number, o.title || '', m(o.planMin), m(o.factMin), o.planCost || '', o.factCost || '']),
      ]);
    });
    $$('#fr-from, #fr-to', body).forEach((el) => el.addEventListener('change', () => load().catch(toastErr)));
    await load();
  }

  function render() {
    stopTimer();
    body.innerHTML = '<div class="empty-note">Загрузка…</div>';
    const fn = tab === 'queue' ? renderQueue : tab === 'orders' ? renderOrders : tab === 'journal' ? renderJournal : renderReport;
    fn().then(() => { if (tab === 'queue' || tab === 'orders') keepFresh(fn); })
      .catch((e) => { body.innerHTML = `<div class="form-error">${esc(e.message)}</div>`; });
  }
  render();
};

/* ================= МОИ ЗАДАНИЯ (сотрудник цеха, с телефона или планшета) ================= */

views.work = async function (box) {
  const ref = await floorRef();
  const areaName = (id) => (ref.areas.find((a) => a.id === id) || {}).name || id;
  let timer = null;

  async function render() {
    const w = await api('/api/floor/work');
    const ops = w.ops;
    const mineNow = (o) => (o.logs || []).some((l) => !l.finished_at && l.user_id === state.user.id);
    const active = ops.find((o) => o.id === w.active) || ops.find(mineNow);
    const open = ops.filter((o) => (o.status === 'todo' || o.status === 'paused' || o.status === 'work') && o !== active);
    const assigned = open.filter((o) => o.assignee_id === state.user.id);
    const common = open.filter((o) => !o.assignee_id);
    const done = ops.filter((o) => o.status === 'done' || o.status === 'check');
    const myAreas = (w.areas || []).map(areaName);

    const card = (o, big) => `
      <div class="wk-card st-${o.status}${big ? ' wk-active' : ''}">
        <div class="wk-top"><span class="wk-num">№ ${esc(o.order_number)}</span>
          <span>${o.due_date ? 'срок ' + orderDueHTML(o.due_date) : ''}</span></div>
        <div class="wk-op">${esc(o.name)}${o.rework_of ? ' <span class="badge st-cancelled">доработка</span>' : ''}</div>
        <div class="wk-part">${esc(o.part)} · ${esc(o.order_title || '')}</div>
        <div class="wk-qty">${fmtNum(o.qty)} ${esc(o.unit)}${o.done_qty ? ` <span class="muted">· сделано ${fmtNum(o.done_qty)}</span>` : ''}</div>
        ${o.qty_note ? `<div class="wk-sub">${esc(o.qty_note)}</div>` : ''}
        ${o.machine_name ? `<div class="wk-sub">Машина: <b>${esc(o.machine_name)}</b></div>` : ''}
        ${o.materials && o.materials.length ? `<div class="wk-sub">Материал: ${o.materials.map((m) => `${esc(m.name)} — ${fmtNum(m.qty)} ${esc(m.unit)}`).join('; ')}</div>` : ''}
        ${o.note ? `<div class="wk-note">${esc(o.note)}</div>` : ''}
        ${o.order_notes ? `<div class="wk-sub muted">Заметки по заказу: ${esc(o.order_notes)}</div>` : ''}
        ${o.qc && o.status !== 'done' && o.status !== 'check' ? '<div class="wk-sub muted">После выполнения работу принимает ОТК</div>' : ''}
        <div class="wk-foot">${opStatusBadge(o)}${big && active ? `<span class="wk-timer">идёт ${fmtMinutes(sinceMin(o))}</span>` : ''}</div>
        <div class="wk-actions">${workActions(o, big)}</div>
      </div>`;

    box.innerHTML = `
      <div class="wk">
        <div class="wk-head"><div><b>${esc(state.user.name)}</b><div class="muted small">${esc(userTitle(state.user))}${myAreas.length ? ' · ' + esc(myAreas.join(', ')) : ' · все участки'}</div></div>
          <button class="btn btn-sm" id="wk-refresh">Обновить</button></div>
        ${active ? `<div class="wk-h">Сейчас в работе</div>${card(active, true)}` : ''}
        <div class="wk-h">Назначено мне ${assigned.length ? `<span class="muted">(${assigned.length})</span>` : ''}</div>
        ${assigned.map((o) => card(o, false)).join('') || '<div class="panel empty-note">Мастер пока ничего не назначил</div>'}
        <div class="wk-h">Общие на участке ${common.length ? `<span class="muted">(${common.length})</span>` : ''}</div>
        <div class="muted small" style="margin:-4px 0 8px">Возьмите задание себе или сразу начните: тогда оно станет вашим.</div>
        ${common.map((o) => card(o, false)).join('') || '<div class="panel empty-note">Общих заданий нет</div>'}
        ${done.length ? `<details class="wk-done"><summary>Выполнено за сутки: ${done.length}</summary>${done.map((o) => card(o, false)).join('')}</details>` : ''}
      </div>`;
    $('#wk-refresh', box).addEventListener('click', () => render().catch(toastErr));
    bindWork(ops);
  }

  const sinceMin = (o) => {
    const l = (o.logs || []).find((x) => !x.finished_at && x.user_id === state.user.id) || (o.logs || []).find((x) => !x.finished_at);
    return l ? (Date.now() - Date.parse(l.started_at)) / 60000 : 0;
  };

  function workActions(o, big) {
    if (o.status === 'done' || o.status === 'check') return '';
    if (big) {
      return `<button class="btn wk-btn" data-w="pause" data-op="${o.id}">Пауза</button>
              <button class="btn btn-primary wk-btn" data-w="finish" data-op="${o.id}">Готово</button>`;
    }
    const take = !o.assignee_id ? `<button class="btn wk-btn" data-w="take" data-op="${o.id}">Взять себе</button>` : '';
    return take + `<button class="btn btn-primary wk-btn" data-w="start" data-op="${o.id}">${o.status === 'paused' ? 'Продолжить' : 'Начать'}</button>`;
  }

  function bindWork(ops) {
    $$('[data-w]', box).forEach((b) => b.addEventListener('click', () => {
      const op = ops.find((o) => String(o.id) === b.dataset.op);
      if (!op) return;
      const again = () => render().catch(toastErr);
      if (b.dataset.w === 'start') opStart(op, again);
      else if (b.dataset.w === 'take') opTake(op, again);
      else opStop(op, b.dataset.w, again);
    }));
  }

  await render();
  timer = setInterval(() => {
    if (!box.isConnected) { clearInterval(timer); return; }
    if (document.querySelector('.modal-overlay')) return;
    render().catch(() => {});
  }, 60000);
};

/* ================= ПРИЁМКА ОТК (контролёр, с планшета) ================= */

views.qc = async function (box) {
  const ref = await floorRef();
  let timer = null;
  async function render() {
    const ops = await api('/api/floor/qc');
    const card = (o) => {
      const own = (o.doers || []).includes(state.user.id);
      const who = [...new Set((o.logs || []).map((l) => l.user_name).filter(Boolean))].join(', ');
      const scrap = (o.logs || []).reduce((s2, l) => s2 + (l.scrap || 0), 0);
      const res = (o.logs || []).map((l) => resultFieldsText(o.code, l.extra, ref)).filter(Boolean).join('; ');
      return `<div class="wk-card st-check">
        <div class="wk-top"><span class="wk-num">№ ${esc(o.order_number)}</span><span>${o.due_date ? 'срок ' + orderDueHTML(o.due_date) : ''}</span></div>
        <div class="wk-op">${esc(o.name)}${o.rework_of ? ' <span class="badge st-cancelled">доработка</span>' : ''}</div>
        <div class="wk-part">${esc(o.part)} · ${esc(o.order_title || '')}</div>
        <div class="wk-qty">Сдано ${fmtNum(o.done_qty)} из ${fmtNum(o.qty)} ${esc(o.unit)}${scrap ? ` <span class="muted">· брак ${fmtNum(scrap)}</span>` : ''}</div>
        <div class="wk-sub">Сделал: <b>${esc(who || '—')}</b> · ${esc(o.area_name || '')}${o.machine_name ? ', ' + esc(o.machine_name) : ''} · ${fmtIso(o.finished_at)}</div>
        ${res ? `<div class="wk-sub">${esc(res)}</div>` : ''}
        ${(o.logs || []).filter((l) => l.note).map((l) => `<div class="wk-note">${esc(l.user_name || '')}: ${esc(l.note)}</div>`).join('')}
        ${o.note ? `<div class="wk-sub muted">${esc(o.note)}</div>` : ''}
        <div class="wk-actions">${own ? '<span class="muted small">Это ваша работа: примет другой контролёр или мастер</span>'
          : `<button class="btn wk-btn" data-q="rework" data-op="${o.id}">На доработку</button>
             <button class="btn btn-primary wk-btn" data-q="accept" data-op="${o.id}">Принять</button>`}</div>
      </div>`;
    };
    box.innerHTML = `<div class="wk">
      <div class="wk-head"><div><b>${esc(state.user.name)}</b><div class="muted small">${esc(userTitle(state.user))}</div></div>
        <button class="btn btn-sm" id="qc-refresh">Обновить</button></div>
      <div class="wk-h">Ждут приёмки ${ops.length ? `<span class="muted">(${ops.length})</span>` : ''}</div>
      <div class="muted small" style="margin:-4px 0 8px">Пока работа не принята, следующие операции по заказу ждут. Возврат на доработку
        создаёт отдельное задание тому же сотруднику.</div>
      ${ops.map(card).join('') || '<div class="panel empty-note">Всё принято: новых работ нет</div>'}
    </div>`;
    $('#qc-refresh', box).addEventListener('click', () => render().catch(toastErr));
    $$('[data-q]', box).forEach((b) => b.addEventListener('click', () => {
      const op = ops.find((o) => String(o.id) === b.dataset.op);
      if (op) opQc(op, b.dataset.q, () => render().catch(toastErr));
    }));
  }
  await render();
  timer = setInterval(() => {
    if (!box.isConnected) { clearInterval(timer); return; }
    if (document.querySelector('.modal-overlay')) return;
    render().catch(() => {});
  }, 60000);
};

/* ================= Производство в карточке заказа ================= */

function orderOpsPanelHTML(order) {
  const ops = order.ops || [];
  const manage = canManageFloor();
  if (!ops.length) {
    if (order.status !== 'production') return '';
    return `<div class="muted">Заданий участкам нет.${manage && TC_TYPES.includes(order.product_type)
      ? ' <button class="btn btn-sm" id="btn-gen-ops">Создать задания по техкарте</button>'
      : ' Для этого вида продукции техкарты пока нет: этап ставится вручную, или добавьте задания участкам сами.'}
      ${manage ? ' <button class="btn btn-sm" id="btn-add-op">+ Задание</button>' : ''}</div>`;
  }
  const done = ops.filter((o) => o.status === 'done').length;
  const pct = Math.round((done / ops.length) * 100);
  const progress = ops.some((o) => o.status !== 'todo' || o.done_qty > 0 || (o.logs || []).length);
  const plan = ops.reduce((s, o) => s + (o.plan_min || 0), 0);
  const fact = ops.reduce((s, o) => s + (o.factMin || 0), 0);
  return `
    <div class="fo-head">
      <div style="flex:1;min-width:200px"><div class="fq-progress"><div style="width:${pct}%"></div></div>
        <div class="small" style="margin-top:4px"><b>${done} из ${ops.length}</b> заданий выполнено · план ${fmtMinutes(plan)}${fact ? ` · факт ${fmtMinutes(fact)}` : ''}</div></div>
      ${manage ? '<button class="btn btn-sm" id="btn-add-op">+ Задание</button>' : ''}
      ${manage && !progress ? '<button class="btn btn-sm" id="btn-regen-ops" title="Цех ещё не начинал: задания можно пересоздать по текущей техкарте">Пересоздать по техкарте</button>' : ''}
    </div>
    <div class="tbl-wrap"><table class="tbl fo-tbl">
      <thead><tr><th>Операция</th><th>Участок, машина</th><th class="num">Объём</th><th>Статус</th><th class="num">План / факт</th><th>Кто, когда</th>${manage ? '<th></th>' : ''}</tr></thead>
      <tbody>${ops.map((o) => {
        // кто и когда: последние две смены, коротко (фамилия, дата и время начала)
        const logs = o.logs || [];
        const who = (logs.length ? '' : opAssigneeHTML(o))
          + logs.slice(-2).map((l) => `${esc(String(l.user_name || '').split(' ')[0])} <span class="muted">${fmtIso(l.started_at)}</span>`).join('<br>')
          + (logs.length > 2 ? `<br><span class="muted">и ещё ${logs.length - 2}</span>` : '')
          + (o.qc_by_name ? `<br><span class="muted">ОТК: ${esc(o.qc_by_name.split(' ')[0])}</span>` : '');
        return `<tr class="st-row-${o.status}">
          <td><b>${esc(o.name)}</b><div class="muted small">${esc(o.part)}${o.qc ? ' · ОТК' : ''}</div></td>
          <td>${esc(o.area_name)}${o.machine_name ? `<div class="muted small">${esc(o.machine_name)}</div>` : ''}</td>
          <td class="num">${fmtNum(o.qty)} ${esc(o.unit)}</td>
          <td>${opStatusBadge(o)}</td>
          <td class="num small">${o.plan_min != null ? fmtMinutes(o.plan_min) : '—'}<br>${o.factMin ? fmtMinutes(o.factMin) : ''}</td>
          <td class="small">${who}</td>
          ${manage ? `<td class="fo-act">${order.status === 'production' || o.status === 'done' || o.status === 'check' ? opActionsHTML(o) : ''}${
            o.status === 'todo' && !(o.logs || []).length ? ` <button class="btn btn-ghost btn-sm" data-op-del="${o.id}" title="Удалить задание">✕</button>` : ''}</td>` : ''}
        </tr>`;
      }).join('')}</tbody></table></div>`;
}

function bindOrderOpsPanel(root, order, onDone) {
  bindOpActions(root, (order.ops || []).map((o) => ({ ...o, order_number: order.number })), onDone);
  $$('[data-op-del]', root).forEach((b) => b.addEventListener('click', async () => {
    const op = (order.ops || []).find((o) => String(o.id) === b.dataset.opDel);
    if (!op || !await confirmDlg(`Удалить задание «${op.name}» (${op.part})?`)) return;
    try { await api('/api/floor/ops/' + op.id, { method: 'DELETE' }); toast('Задание удалено', 'ok'); onDone(); }
    catch (e) { toastErr(e); }
  }));
  const addBtn = $('#btn-add-op', root);
  if (addBtn) addBtn.addEventListener('click', () => addOpDialog(order, onDone));
  const gen = $('#btn-gen-ops', root) || $('#btn-regen-ops', root);
  if (gen) gen.addEventListener('click', async () => {
    try {
      const r = await api(`/api/orders/${order.id}/ops/generate`, { method: 'POST', body: { force: true } });
      toast(`Заданий: ${r.created}`, 'ok');
      onDone();
    } catch (e) { toastErr(e); }
  });
}

/* Мастер добавляет задание в заказ: операция из справочника или своя, на любой участок, в том числе подрядчику */
async function addOpDialog(order, onDone) {
  const [ref, catalog] = await Promise.all([api('/api/floor/areas'), api('/api/floor/catalog')]);
  const ops = order.ops || [];
  const m = openModal({
    title: 'Новое задание в заказ № ' + order.number,
    body: `
      <form id="add-op-form" style="display:flex;flex-direction:column;gap:12px">
        <label class="fld"><span>Операция из справочника</span><select name="code"><option value="">— своя операция —</option>
          ${catalog.map((c) => `<option value="${esc(c.code)}">${esc(c.name)}</option>`).join('')}</select></label>
        <label class="fld"><span>Название *</span><input name="name" type="text" required placeholder="Например: УФ-лак обложки"></label>
        <label class="fld"><span>Участок *</span><select name="area_id">${ref.areas.map((a) =>
          `<option value="${esc(a.id)}">${esc(a.name)}${a.kind === 'outsource' ? ' (подряд)' : ''}</option>`).join('')}</select></label>
        <label class="fld"><span>Машина</span><select name="machine_id"></select></label>
        <div class="form-grid">
          <label class="fld"><span>Объём</span><input name="qty" type="number" min="0" step="any" value="${order.quantity || 0}"></label>
          <label class="fld"><span>Единица</span><input name="unit" type="text" value="экз."></label>
          <label class="fld"><span>План, мин (пусто: по нормам)</span><input name="plan_min" type="number" min="0" step="any"></label>
          <label class="fld"><span>Себестоимость, ₽ (для подряда: цена подрядчика)</span><input name="plan_cost" type="number" min="0" step="any"></label>
        </div>
        <label class="fld"><span>Часть изделия</span><input name="part" type="text" value="Заказ" placeholder="Блок, Обложка, Книга…"></label>
        <label class="fld"><span>Делать после</span><select name="after_key"><option value="">— можно сразу —</option>
          ${ops.map((o) => `<option value="${esc(o.op_key)}">${esc(o.name)} · ${esc(o.part)}</option>`).join('')}</select></label>
        <label class="fld"><span>Примечание</span><input name="note" type="text"></label>
      </form>`,
    footer: `<button class="btn" data-act="cancel">Отмена</button><button class="btn btn-primary" data-act="save">Добавить</button>`,
    wide: true,
  });
  const form = $('#add-op-form', m.body);
  const syncMachines = () => {
    const a = form.elements.area_id.value;
    form.elements.machine_id.innerHTML = '<option value="">— вручную —</option>' +
      ref.machines.filter((x) => x.areaId === a).map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
  };
  form.elements.area_id.addEventListener('change', syncMachines);
  form.elements.code.addEventListener('change', () => {
    const c = catalog.find((x) => x.code === form.elements.code.value);
    if (!c) return;
    form.elements.name.value = c.name;
    form.elements.area_id.value = c.areaId;
    syncMachines();
    form.elements.machine_id.value = c.machineId || '';
    form.elements.unit.value = c.unit || 'шт.';
  });
  syncMachines();
  $('[data-act="cancel"]', m.foot).onclick = m.close;
  const submit = async () => {
    if (!form.reportValidity()) return;
    const f = new FormData(form);
    const body = Object.fromEntries(f.entries());
    try {
      await api(`/api/orders/${order.id}/ops`, { method: 'POST', body });
      m.close();
      toast('Задание добавлено', 'ok');
      onDone();
    } catch (e) { toastErr(e); }
  };
  $('[data-act="save"]', m.foot).onclick = submit;
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
}

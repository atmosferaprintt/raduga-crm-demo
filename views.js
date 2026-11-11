'use strict';
/* Виды: заказы, карточка заказа, клиенты, задачи, аналитика, настройки */

/* ================= ЗАКАЗЫ ================= */

function orderDueHTML(due) {
  if (!due) return '<span class="muted">—</span>';
  return `<span class="${isOverdue(due) ? 'overdue' : ''}">${fmtDate(due)}</span>`;
}

function newOrderDialog(preset = {}) {
  const m = openModal({
    title: 'Новый заказ',
    wide: true,
    body: `
      <form id="new-order-form" class="form-grid">
        <label class="fld span2"><span>Название</span><input name="title" type="text" placeholder="Например: Книга «Сказки», 7БЦ" required></label>
        <label class="fld"><span>Клиент</span>
          <select name="client_id" required><option value="">— выберите —</option>${clientOptions(preset.client_id)}</select>
        </label>
        <label class="fld"><span>Менеджер</span>
          <select name="manager_id" ${can('orders.assign') ? '' : 'disabled title="Передать заказ другому менеджеру может руководитель отдела продаж"'}>${managerOptions(preset.manager_id ?? state.user.id)}</select>
        </label>
        <label class="fld"><span>Статус</span>
          <select name="status">${STATUSES.map((s) => `<option value="${s.key}">${s.label}</option>`).join('')}</select>
        </label>
        <label class="fld"><span>Срок сдачи</span><input name="due_date" type="date"></label>
        <label class="fld"><span>Тираж, экз.</span><input name="quantity" type="number" min="0" value="0"></label>
        ${can('money.price') ? '<label class="fld"><span>Цена за тираж, ₽</span><input name="price" type="number" min="0" step="0.01" value="0"></label>' : ''}
        <label class="fld span2"><span>Заметки</span><textarea name="notes" rows="2"></textarea></label>
      </form>`,
    footer: `<button class="btn" data-act="cancel">Отмена</button>
             <button class="btn btn-primary" data-act="save">Создать заказ</button>`,
  });
  const form = $('#new-order-form', m.body);
  async function submit() {
    const f = new FormData(form);
    if (!form.reportValidity()) return;
    try {
      const r = await api('/api/orders', {
        method: 'POST',
        body: {
          title: f.get('title'), client_id: Number(f.get('client_id')) || null,
          manager_id: can('orders.assign') ? Number(f.get('manager_id')) || null : state.user.id, status: f.get('status'),
          due_date: f.get('due_date') || '', quantity: Number(f.get('quantity')) || 0,
          price: Number(f.get('price')) || 0, notes: f.get('notes') || '',
        },
      });
      m.close();
      toast(`Заказ №${r.number} создан`, 'ok');
      navigate('#/orders/' + r.id);
    } catch (e) { toastErr(e); }
  }
  $('[data-act="cancel"]', m.foot).onclick = m.close;
  $('[data-act="save"]', m.foot).onclick = submit;
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
}

views.orders = async function (box) {
  await Promise.all([loadUsers(), loadClients(), loadSchema().catch(() => null)]);
  let mode = localStorage.getItem('ordersMode') || 'kanban';
  const filters = { q: '', status: '', manager_id: '' };

  box.innerHTML = `
    <div class="page-head">
      <div class="toolbar">
        <div class="view-toggle">
          <button data-mode="kanban" title="Доска">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="18" rx="1.5"/><rect x="14" y="3" width="7" height="12" rx="1.5"/></svg>
            Доска</button>
          <button data-mode="table" title="Таблица">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="7" x2="21" y2="7"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="17" x2="21" y2="17"/></svg>
            Таблица</button>
        </div>
        <input type="text" id="ord-q" placeholder="Поиск: номер, название, клиент…">
        <select id="ord-status">
          <option value="">Все статусы</option>
          ${STATUSES.map((s) => `<option value="${s.key}">${s.label}</option>`).join('')}
        </select>
        <select id="ord-manager" class="${can('orders.all') ? '' : 'hidden'}">
          <option value="">Все менеджеры</option>
          ${managerOptions()}
        </select>
        ${can('orders.all') ? '' : '<span class="muted small" title="Право «Все клиенты и заказы» даёт руководитель">Показаны ваши заказы</span>'}
      </div>
      <div class="toolbar">
        <button class="btn" id="btn-orders-csv" title="Выгрузить заказы с текущими фильтрами">Выгрузить в Excel</button>
        <button class="btn btn-primary ${can('orders.edit') ? '' : 'hidden'}" id="btn-new-order">+ Новый заказ</button>
      </div>
    </div>
    <div id="orders-body"><div class="empty-note">Загрузка…</div></div>`;
  $('#btn-orders-csv', box).addEventListener('click', async () => {
    try {
      const list = await fetchOrders();
      // суммы в выгрузке только у тех, кто их видит
      const P = can('money.price'), C = can('money.cost');
      downloadCSV(`заказы-${todayISO()}.csv`,
        ['Номер', 'Создан', 'Клиент', 'Название', 'Вид продукции', 'Статус', 'Тираж', ...(P ? ['Цена, ₽'] : []), ...(C ? ['Себестоимость, ₽'] : []),
          'Срок', 'Менеджер', 'Заданий выполнено'],
        list.map((o) => [o.number, fmtDate(o.created_at), o.client_name || '', o.title || '', typeLabel(o.product_type), statusLabel(o.status),
          o.quantity || 0, ...(P ? [o.price || 0] : []), ...(C ? [o.cost || 0] : []), fmtDate(o.due_date), o.manager_name || '',
          o.ops_total ? `${o.ops_done} из ${o.ops_total}` : '']));
    } catch (e) { toastErr(e); }
  });

  $('#ord-manager', box).value = '';
  const body = $('#orders-body', box);

  async function fetchOrders() {
    const p = new URLSearchParams();
    if (filters.q) p.set('q', filters.q);
    if (filters.status && mode === 'table') p.set('status', filters.status);
    if (filters.manager_id) p.set('manager_id', filters.manager_id);
    return api('/api/orders?' + p.toString());
  }

  function kbCardHTML(o) {
    return `
      <div class="kb-card" draggable="${can('orders.edit') ? 'true' : 'false'}" data-id="${o.id}">
        <div class="kb-num"><span>№ ${esc(o.number)}</span><span>${orderDueHTML(o.due_date)}</span></div>
        <div class="kb-title">${esc(o.title || typeLabel(o.product_type))}</div>
        <div class="kb-client">${esc(o.client_name || 'Без клиента')}</div>
        <div class="kb-foot">
          <span class="kb-price">${can('money.price') ? (o.price ? fmtMoney(o.price) : '—') : (o.quantity ? fmtNum(o.quantity) + ' экз.' : '')}</span>
          <span>${esc(o.manager_name || '')}</span>
        </div>
      </div>`;
  }

  function renderKanban(orders) {
    const cols = STATUSES.map((s) => {
      const list = orders.filter((o) => o.status === s.key);
      return `
        <div class="kb-col" data-status="${s.key}">
          <div class="kb-col-head"><span>${s.label}</span><span class="cnt">${list.length}</span></div>
          <div class="kb-cards">${list.map(kbCardHTML).join('') || ''}</div>
        </div>`;
    }).join('');
    body.innerHTML = `<div class="kanban">${cols}</div>`;

    $$('.kb-card', body).forEach((card) => {
      card.addEventListener('click', () => navigate('#/orders/' + card.dataset.id));
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', card.dataset.id);
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
    });
    $$('.kb-col', body).forEach((col) => {
      col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag-over'); });
      col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
      col.addEventListener('drop', async (e) => {
        e.preventDefault();
        col.classList.remove('drag-over');
        const id = e.dataTransfer.getData('text/plain');
        if (!id) return;
        try {
          const r = await api('/api/orders/' + id, { method: 'PUT', body: { status: col.dataset.status } });
          opsToast(r);
          await refresh();
        } catch (err) { toastErr(err); }
      });
    });
  }

  function renderTable(orders) {
    if (!orders.length) { body.innerHTML = '<div class="panel empty-note">Заказов не найдено</div>'; return; }
    body.innerHTML = `
      <div class="panel tbl-wrap">
        <table class="tbl">
          <thead><tr>
            <th>№</th><th>Название</th><th>Клиент</th><th>Статус</th><th>Менеджер</th>
            <th class="num">Тираж</th>${can('money.price') ? '<th class="num">Сумма</th>' : ''}<th>Срок</th><th>Создан</th>
          </tr></thead>
          <tbody>
            ${orders.map((o) => `
              <tr class="clickable" data-id="${o.id}">
                <td class="mono">${esc(o.number)}</td>
                <td><b>${esc(o.title || typeLabel(o.product_type))}</b></td>
                <td>${esc(o.client_name || '—')}</td>
                <td>${statusBadge(o.status)}</td>
                <td>${esc(o.manager_name || '—')}</td>
                <td class="num">${o.quantity ? fmtNum(o.quantity) : '—'}</td>
                ${can('money.price') ? `<td class="num">${o.price ? fmtMoney(o.price) : '—'}</td>` : ''}
                <td>${orderDueHTML(o.due_date)}</td>
                <td class="muted small">${fmtDate(o.created_at)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    $$('tr.clickable', body).forEach((tr) =>
      tr.addEventListener('click', () => navigate('#/orders/' + tr.dataset.id)));
  }

  async function refresh() {
    const orders = await fetchOrders();
    if (mode === 'kanban') renderKanban(orders); else renderTable(orders);
  }

  function syncToggle() {
    $$('.view-toggle button', box).forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    $('#ord-status', box).style.display = mode === 'table' ? '' : 'none';
  }
  $$('.view-toggle button', box).forEach((b) => b.addEventListener('click', async () => {
    mode = b.dataset.mode;
    localStorage.setItem('ordersMode', mode);
    syncToggle();
    await refresh();
  }));

  $('#ord-q', box).addEventListener('input', debounce(async (e) => { filters.q = e.target.value.trim(); await refresh(); }));
  $('#ord-status', box).addEventListener('change', async (e) => { filters.status = e.target.value; await refresh(); });
  $('#ord-manager', box).addEventListener('change', async (e) => { filters.manager_id = e.target.value; await refresh(); });
  $('#btn-new-order', box).addEventListener('click', () => newOrderDialog());

  syncToggle();
  await refresh();
};


/* Производство (очереди участков, мои задания, журнал) — public/floor.js */

// Сообщение после передачи заказа в производство: сколько заданий получили участки
function opsToast(r) {
  const ops = r && r.ops;
  if (ops && ops.ok && ops.created) toast(`Участки получили задания по техкарте: ${ops.created}`, 'ok');
  else if (ops && !ops.ok && ops.reason) toast(ops.reason, 'error');
  if (r && r.priceKept) toast('Цена зафиксирована: пересчёт её не изменил', 'ok');
  // проверка при запуске в производство: не блокирует, а подсказывает
  if (r && r.warnings && r.warnings.length) {
    openModal({
      title: 'Заказ в производстве. Проверьте:',
      body: `<ul class="launch-warn">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
        <div class="muted small" style="margin-top:10px">Это подсказки, заказ уже передан в цех. Если всё верно, просто закройте окно.</div>`,
    });
  }
}

/* ================= КАРТОЧКА ЗАКАЗА ================= */

views.order = async function (box, id) {
  const [order] = await Promise.all([api('/api/orders/' + id), loadUsers(), loadClients(), loadSchema().catch(() => null)]);
  $('#page-title').textContent = `Заказ № ${order.number}`;
  const calc = safeParse(order.calc_json);
  const params = safeParse(order.params_json);
  // права: кто ведёт заказ, кто видит деньги, кто меняет утверждённую цену
  const edit = can('orders.edit'), seePrice = can('money.price'), seeCost = can('money.cost');
  const lockedForMe = !!order.price_locked && !can('price.approved');
  const hide = (ok) => (ok ? '' : ' hidden');
  let b24 = null;
  try { const ig = await api('/api/integrations'); b24 = ig && ig.bitrix24; } catch { /* не критично */ }
  const b24on = !!(b24 && (b24.configured || b24.webhookUrl));

  box.innerHTML = `
    <div class="page-head">
      <h2>№ ${esc(order.number)} · ${esc(order.title || typeLabel(order.product_type))} &nbsp;${statusBadge(order.status)}</h2>
      <div class="toolbar">
        <button class="btn${hide(edit && seePrice)}" id="btn-kp" ${calc && calc.priceTotal != null || order.price ? '' : 'disabled title="Нет данных для КП"'}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
          Коммерческое предложение</button>
        <button class="btn" id="btn-tz" ${order.product_type ? '' : 'disabled title="Нет калькуляции"'}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          Техзадание</button>
        <button class="btn${hide(edit)}" id="btn-recalc">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          ${order.product_type ? 'Пересчитать / изменить калькуляцию' : 'Создать калькуляцию'}</button>
        ${calc && ((calc.materials && calc.materials.length) || calc.techcard) ? `<button class="btn${hide(can('stock.edit'))}" id="btn-writeoff" title="Списать материалы тиража со склада">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
          Списать материалы</button>` : ''}
        ${calc && (calc.techcard || (calc.materials && calc.materials.length)) ? `<button class="btn${hide(can('purchases'))}" id="btn-mat-request" title="Сравнить потребность заказа со складом и заказать недостающее">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
          Заявка на материалы</button>` : ''}
        ${order.product_type ? `<button class="btn${hide(edit)}" id="btn-reprint" title="Повтор заказа из-за брака или недовложения: клиенту бесплатно">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
          Перепечатка</button>` : ''}
        ${b24on && edit ? `<button class="btn" id="btn-b24" title="Создать сделку в Битрикс24">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          В Битрикс24</button>` : ''}
        ${can('orders.delete') ? '<button class="btn btn-danger" id="btn-del-order">Удалить</button>' : ''}
      </div>
    </div>
    ${!seePrice ? '<div class="info-box">Цены и суммы по этому заказу скрыты: у вашей должности нет права их видеть.</div>' : ''}
    ${order.reprint_of ? `<div class="warn-box">Это перепечатка к заказу <a href="#/orders/${order.reprint_of}"><b>№ ${esc(order.reprint_of_number || '')}</b></a>: клиенту бесплатно, цена 0 ₽, затраты видны в себестоимости.</div>` : ''}
    ${order.reprints && order.reprints.length ? `<div class="warn-box">Перепечатки по заказу: ${order.reprints.map((r) =>
      `<a href="#/orders/${r.id}"><b>№ ${esc(r.number)}</b></a> (${fmtNum(r.quantity)} экз., ${esc(statusLabel(r.status))})`).join(', ')}</div>` : ''}
    <div class="order-grid">
      <div>
        <div class="panel panel-pad">
          <h3>Данные заказа</h3>
          <form id="order-form" class="form-grid">
            <fieldset class="span2 order-fs" ${edit ? '' : 'disabled'}><div class="form-grid">
            <label class="fld span2"><span>Название</span><input name="title" type="text" value="${esc(order.title)}"></label>
            <label class="fld"><span>Клиент</span>
              <select name="client_id"><option value="">— не выбран —</option>${clientOptions(order.client_id)}</select></label>
            <label class="fld"><span>Менеджер</span>
              <select name="manager_id" ${can('orders.assign') ? '' : 'disabled title="Передать заказ другому менеджеру может руководитель отдела продаж"'}><option value="">—</option>${managerOptions(order.manager_id)}</select></label>
            <label class="fld"><span>Статус</span>
              <select name="status">${STATUSES.map((s) => `<option value="${s.key}" ${s.key === order.status ? 'selected' : ''}>${s.label}</option>`).join('')}</select></label>
            ${order.ops && order.ops.length ? '' : `<label class="fld"><span>Этап производства</span>
              <select name="prod_stage">${PROD_STAGES.map((s) => `<option value="${s.key}" ${s.key === (order.prod_stage || '') ? 'selected' : ''}>${s.label}</option>`).join('')}</select></label>`}
            <label class="fld"><span>Срок сдачи</span><input name="due_date" type="date" value="${esc(order.due_date)}"></label>
            <label class="fld"><span>Тираж, экз.</span><input name="quantity" type="number" min="0" value="${order.quantity || 0}"></label>
            ${seePrice ? `<label class="fld"><span>Цена за тираж, ₽${order.price_locked ? ' 🔒' : ''}</span><input name="price" type="number" min="0" step="0.01" value="${order.price || 0}" ${lockedForMe ? 'disabled title="Цена утверждена: менять её может руководитель с правом «Менять утверждённую цену»"' : ''}></label>` : ''}
            ${seeCost ? `<label class="fld"><span>Себестоимость, ₽</span><input name="cost" type="number" min="0" step="0.01" value="${order.cost || 0}"></label>` : ''}
            <label class="fld"><span>Вид продукции</span><input type="text" value="${esc(typeLabel(order.product_type))}" disabled></label>
            <label class="fld span2"><span>Заметки</span><textarea name="notes" rows="3">${esc(order.notes)}</textarea></label>
            ${seePrice ? `<label class="check-fld span2" title="Цена согласована с клиентом: пересчёт калькуляции не изменит её">
              <input type="checkbox" name="price_locked" ${order.price_locked ? 'checked' : ''} ${lockedForMe ? 'disabled' : ''}>
              <span>Цена согласована с клиентом: пересчёт её не меняет${lockedForMe ? '. <span class="muted">Снять фиксацию может руководитель с правом «Менять утверждённую цену»</span>' : ''}</span></label>` : ''}
            </div></fieldset>
          </form>
          <div class="toolbar" style="margin-top:14px;justify-content:space-between">
            <span class="muted small">Клиент: ${order.client_id ? `<a href="#/clients/${order.client_id}">${esc(order.client_name || '')}</a>` : '—'}
              · Создан ${fmtDateTime(order.created_at)} · Обновлён ${fmtDateTime(order.updated_at)}</span>
            <button class="btn btn-primary${hide(edit)}" id="btn-save-order">Сохранить</button>
          </div>
        </div>

        <div class="panel panel-pad" id="calc-panel">
          <h3>Калькуляция ${order.product_type ? `— ${esc(typeLabel(order.product_type))}` : ''}</h3>
          <div id="calc-content"></div>
        </div>
      </div>
      <div>
        <div class="panel panel-pad">
          <h3>Задачи по заказу</h3>
          <div id="order-tasks"></div>
          <form id="order-task-form" class="toolbar" style="margin-top:12px">
            <input type="text" name="text" placeholder="Новая задача…" required style="flex:1;min-width:140px">
            <input type="date" name="due_date" style="width:auto">
            <select name="user_id" style="min-width:130px">${managerOptions(state.user.id)}</select>
            <button class="btn btn-sm btn-primary" type="submit">Добавить</button>
          </form>
        </div>
        <div class="panel panel-pad">
          <h3>История</h3>
          ${order.log && order.log.length ? `
            <ul class="log-list">
              ${order.log.map((l) => `
                <li><span class="log-when">${fmtDateTime(l.created_at)}</span>
                    <span>${esc(l.event)} <span class="log-who">· ${esc(l.user_name || '')}</span></span></li>`).join('')}
            </ul>` : '<div class="muted">Пока пусто</div>'}
        </div>
      </div>
    </div>
    <div class="panel panel-pad ${order.ops && order.ops.length || order.status === 'production' ? '' : 'hidden'}" id="order-floor" style="margin-top:16px">
      <h3>Производство: задания участкам</h3>
      <div id="order-floor-body">${orderOpsPanelHTML(order)}</div>
    </div>
    <div class="panel panel-pad hidden" id="order-techcard" style="margin-top:16px">
      <h3>Техкарта: маршрут по участкам</h3>
      <div id="order-techcard-body"></div>
    </div>`;

  // техкарта (для старых заказов строится по сохранённым параметрам)
  let orderTc = null;
  techcardForOrder(order, calc, params).then((r) => {
    if (!r || !r.tc) return;
    orderTc = r.tc.ok !== false ? r.tc : null;
    const panel = $('#order-techcard', box);
    if (!panel) return;
    panel.classList.remove('hidden');
    // статусы заданий цеха поверх схемы маршрута
    const status = {};
    for (const op of order.ops || []) status[op.op_key] = op.status;
    $('#order-techcard-body', box).innerHTML = techcardHTML(r.tc, {
      subtitle: r.fresh ? 'Заказ рассчитан до появления техкарт, поэтому она построена по его параметрам и текущим настройкам. Чтобы сохранить её в заказе, нажмите «Пересчитать» и «Обновить заказ».' : '',
      status: (order.ops || []).length && !r.fresh ? status : null,
    });
  });
  bindOrderOpsPanel($('#order-floor', box), order, () => renderRoute());

  // калькуляция
  const calcBox = $('#calc-content', box);
  if (!seePrice) {
    calcBox.innerHTML = `<div class="muted" style="margin-bottom:10px">Суммы расчёта скрыты. Маршрут и объёмы смотрите в техкарте ниже.</div>
      ${order.product_type && Object.keys(params).length ? paramsListHTML(order.product_type, params) : ''}`;
  } else if (calc && (calc.priceTotal != null || calc.ok)) {
    calcBox.innerHTML = calcResultHTML(calc) + `
      <h3 style="margin-top:16px">Параметры</h3>
      ${paramsListHTML(order.product_type, params)}`;
  } else if (order.product_type && Object.keys(params).length) {
    calcBox.innerHTML = `
      <div class="muted" style="margin-bottom:10px">Результат расчёта не сохранён. Параметры:</div>
      ${paramsListHTML(order.product_type, params)}`;
  } else {
    calcBox.innerHTML = '<div class="muted">Калькуляция не выполнялась. Нажмите «Создать калькуляцию».</div>';
  }

  // задачи
  function renderTasks(tasks) {
    const wrap = $('#order-tasks', box);
    if (!tasks.length) { wrap.innerHTML = '<div class="muted">Задач нет</div>'; return; }
    wrap.innerHTML = tasks.map((t) => {
      const assignee = (state.users || []).find((u) => u.id === t.user_id);
      return `
      <div class="task-row ${t.done ? 'done' : ''}" data-id="${t.id}">
        <input type="checkbox" ${t.done ? 'checked' : ''} title="Выполнено">
        <div class="task-text">${esc(t.text)}
          <div class="task-meta">
            ${t.due_date ? `<span class="${!t.done && isOverdue(t.due_date) ? 'overdue' : ''}">до ${fmtDate(t.due_date)}</span>` : ''}
            ${assignee ? `<span>${esc(assignee.name)}</span>` : ''}
          </div>
        </div>
        <button class="btn btn-ghost btn-sm task-del" title="Удалить">✕</button>
      </div>`;
    }).join('');
    $$('.task-row', wrap).forEach((row) => {
      $('input[type="checkbox"]', row).addEventListener('change', async (e) => {
        try { await api('/api/tasks/' + row.dataset.id, { method: 'PUT', body: { done: e.target.checked } }); await reloadTasks(); }
        catch (err) { toastErr(err); }
      });
      $('.task-del', row).addEventListener('click', async () => {
        if (!await confirmDlg('Удалить задачу?')) return;
        try { await api('/api/tasks/' + row.dataset.id, { method: 'DELETE' }); await reloadTasks(); }
        catch (err) { toastErr(err); }
      });
    });
  }
  async function reloadTasks() {
    const o = await api('/api/orders/' + id);
    renderTasks(o.tasks || []);
  }
  renderTasks(order.tasks || []);

  $('#order-task-form', box).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('/api/tasks', {
        method: 'POST',
        body: { order_id: Number(id), text: f.get('text'), due_date: f.get('due_date') || '', user_id: Number(f.get('user_id')) || null },
      });
      e.target.reset();
      $('select[name="user_id"]', e.target).value = state.user.id;
      await reloadTasks();
    } catch (err) { toastErr(err); }
  });

  // сохранение
  $('#btn-save-order', box).addEventListener('click', async () => {
    const f = new FormData($('#order-form', box));
    // поля без права не отправляем: сервер их всё равно не примет
    const body = {
      title: f.get('title'), client_id: Number(f.get('client_id')) || null, status: f.get('status'),
      due_date: f.get('due_date') || '', quantity: Number(f.get('quantity')) || 0,
      notes: f.get('notes') || '', prod_stage: f.get('prod_stage') ?? undefined,
    };
    if (can('orders.assign')) body.manager_id = Number(f.get('manager_id')) || null;
    if (seePrice && !lockedForMe) { body.price = Number(f.get('price')) || 0; body.price_locked = !!f.get('price_locked'); }
    if (seeCost) body.cost = Number(f.get('cost')) || 0;
    try {
      const saved = await api('/api/orders/' + id, { method: 'PUT', body });
      toast('Заказ сохранён', 'ok');
      opsToast(saved);
      renderRoute();
    } catch (e) { toastErr(e); }
  });

  $('#btn-recalc', box).addEventListener('click', () => {
    const t = order.product_type ? `type=${encodeURIComponent(order.product_type)}&` : '';
    navigate(`#/calc?${t}order=${id}`);
  });

  $('#btn-kp', box).addEventListener('click', () => printKP(order, calc, params));
  $('#btn-tz', box).addEventListener('click', () => printTechTask(order, calc, params));

  // списание материалов тиража со склада
  const woBtn = $('#btn-writeoff', box);
  if (woBtn) woBtn.addEventListener('click', async () => {
    try {
      const wasBefore = (order.log || []).some((l) => (l.event || '').startsWith('Склад: списание'));
      if (wasBefore && !await confirmDlg('По этому заказу уже было списание со склада. Списать ещё раз?', 'Списать')) return;
      const stock = await api('/api/stock');
      // по техкарте: реальный расход для цеха (без наценки, заложенной в объём бумаги)
      const srcMats = orderTc ? techcardMaterials(orderTc) : (calc.materials || []);
      const rows = srcMats.map((mt) => ({
        mt, s: stock.find((x) => x.name === mt.name) || null,
        need: Math.ceil(mt.qty * 100) / 100,
      }));
      const m = openModal({
        title: 'Списание материалов со склада',
        wide: true,
        body: `
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr><th>Материал</th><th>Списать</th><th>Ед.</th><th class="num">Остаток на складе</th></tr></thead>
            <tbody>
              ${rows.map((r, i) => `
                <tr>
                  <td><b>${esc(r.mt.name)}</b> <span class="muted small">${esc(r.mt.what || '')}</span></td>
                  <td><input type="number" step="any" min="0" value="${r.s ? r.need : 0}" data-i="${i}" style="width:110px" ${r.s ? '' : 'disabled'}></td>
                  <td class="muted">${esc(r.mt.unit)}</td>
                  <td class="num">${r.s
                    ? `${fmtNum(r.s.qty)}${r.s.qty < r.need ? ' <span class="overdue">не хватает</span>' : ''}`
                    : '<span class="overdue">нет такой позиции на складе</span>'}</td>
                </tr>`).join('')}
            </tbody>
          </table></div>
          <div class="muted small" style="margin-top:10px">
            ${orderTc ? 'Количества взяты из техкарты: реальный расход для цеха, без наценки, заложенной в объём бумаги в прайсе. ' : ''}
            Списание попадёт в историю заказа и в движения склада. Отрицательный остаток допускается —
            это сигнал, что материал надо оприходовать.</div>`,
        footer: `<button class="btn" data-act="cancel">Отмена</button>
                 <button class="btn btn-primary" data-act="save">Списать</button>`,
      });
      $('[data-act="cancel"]', m.foot).onclick = m.close;
      const woSaveBtn = $('[data-act="save"]', m.foot);
      woSaveBtn.onclick = async () => {
        woSaveBtn.disabled = true;
        let done = 0;
        try {
          for (const inp of $$('input[data-i]', m.body)) {
            if (inp.dataset.done) { done++; continue; } // уже списано в этом окне
            const r = rows[Number(inp.dataset.i)];
            const q = Number(String(inp.value).replace(',', '.'));
            if (!r.s || !q || q <= 0) continue;
            await api(`/api/stock/${r.s.id}/move`, {
              method: 'POST',
              body: { qty: -q, order_id: order.id, reason: `Заказ № ${order.number}` },
            });
            inp.dataset.done = '1';
            inp.disabled = true;
            done++;
          }
          m.close();
          if (done) { toast(`Списано позиций: ${done}`, 'ok'); renderRoute(); }
          else toast('Нечего списывать', 'error');
        } catch (e) { toastErr(e); woSaveBtn.disabled = false; }
      };
    } catch (e) { toastErr(e); }
  });

  // перепечатка: новый заказ «№/П1» с теми же параметрами, клиенту бесплатно
  const rpBtn = $('#btn-reprint', box);
  if (rpBtn) rpBtn.addEventListener('click', () => {
    const m = openModal({
      title: 'Перепечатка заказа № ' + order.number,
      body: `<form id="rp-form" style="display:flex;flex-direction:column;gap:13px">
        <div class="muted small">Создастся новый заказ с теми же параметрами и ценой 0 ₽: брак или недовложение не оплачиваются клиентом,
          а затраты видны в себестоимости. Его можно сразу передать в производство.</div>
        <label class="fld"><span>Тираж перепечатки, экз.</span><input name="tiraj" type="number" min="1" value="${order.quantity || 1}"></label>
        <label class="fld"><span>Причина</span><input name="reason" type="text" placeholder="Например: брак ламинации, 40 обложек"></label>
      </form>`,
      footer: `<button class="btn" data-act="cancel">Отмена</button><button class="btn btn-primary" data-act="ok">Создать перепечатку</button>`,
    });
    $('[data-act="cancel"]', m.foot).onclick = m.close;
    $('[data-act="ok"]', m.foot).onclick = async () => {
      const f = new FormData($('#rp-form', m.body));
      try {
        const r = await api(`/api/orders/${order.id}/reprint`, { method: 'POST', body: { tiraj: Number(f.get('tiraj')) || 0, reason: f.get('reason') || '' } });
        m.close();
        toast(`Перепечатка № ${r.number} создана`, 'ok');
        navigate('#/orders/' + r.id);
      } catch (e) { toastErr(e); }
    };
  });

  // заявка на материалы: потребность заказа (по техкарте) против склада → закупка недостающего
  const mrBtn = $('#btn-mat-request', box);
  if (mrBtn) mrBtn.addEventListener('click', async () => {
    try {
      const [stock] = await Promise.all([api('/api/stock'), loadSuppliers().catch(() => null)]);
      const need = orderTc ? techcardMaterials(orderTc) : (calc.materials || []);
      const rows = need.map((mt) => {
        const st = stock.find((x) => x.name === mt.name) || null;
        const qty = Math.ceil(mt.qty * 100) / 100;
        const lack = st ? Math.max(0, Math.ceil(qty - st.qty)) : null;
        return { mt, st, qty, lack };
      });
      const toBuy = rows.filter((r) => r.st && r.lack > 0);
      const m = openModal({
        title: 'Заявка на материалы: заказ № ' + order.number,
        wide: true,
        body: `<div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>Материал</th><th class="num">Нужно</th><th class="num">На складе</th><th class="num">Не хватает</th></tr></thead>
          <tbody>${rows.map((r) => `<tr><td><b>${esc(r.mt.name)}</b> <span class="muted small">${esc(r.mt.what || '')}</span></td>
            <td class="num">${fmtNum(r.qty)} ${esc(r.mt.unit)}${r.mt.kg ? `<div class="muted small">≈ ${fmtNum(r.mt.kg)} кг</div>` : ''}</td>
            <td class="num">${r.st ? fmtNum(r.st.qty) : '<span class="overdue">нет в справочнике склада</span>'}</td>
            <td class="num">${r.lack ? `<b class="overdue">${fmtNum(r.lack)}</b>` : r.st ? '<span class="tc-ok">хватает</span>' : ''}</td></tr>`).join('')}</tbody>
        </table></div>
        <div class="muted small" style="margin-top:10px">${orderTc ? 'Потребность по техкарте: реальный расход для цеха. ' : ''}Остаток склада общий: другие заказы в работе тоже его используют.</div>`,
        footer: `<button class="btn" data-act="cancel">Закрыть</button>
          ${toBuy.length ? `<button class="btn btn-primary" data-act="buy">Создать закупку недостающего (${toBuy.length})</button>` : ''}`,
      });
      $('[data-act="cancel"]', m.foot).onclick = m.close;
      const buy = $('[data-act="buy"]', m.foot);
      if (buy) buy.onclick = () => {
        m.close();
        newPurchaseDialog({ items: toBuy.map((r) => ({ material_id: r.st.id, qty: r.lack, price: r.st.last_price || 0,
          notes: 'для заказа № ' + order.number })) });
      };
    } catch (e) { toastErr(e); }
  });

  // отправка сделки в Битрикс24
  const b24Btn = $('#btn-b24', box);
  if (b24Btn) b24Btn.addEventListener('click', async () => {
    b24Btn.disabled = true;
    try {
      const r = await api(`/api/orders/${order.id}/bitrix`, { method: 'POST' });
      toast(`Сделка создана в Битрикс24 (#${r.dealId})`, 'ok');
      renderRoute();
    } catch (e) { toastErr(e); }
    finally { b24Btn.disabled = false; }
  });

  const delBtn = $('#btn-del-order', box);
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!await confirmDlg(`Удалить заказ № ${order.number}? Действие необратимо.`)) return;
    try { await api('/api/orders/' + id, { method: 'DELETE' }); toast('Заказ удалён', 'ok'); navigate('#/orders'); }
    catch (e) { toastErr(e); }
  });
};

function safeParse(s) {
  try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

/* ================= СКЛАД ================= */

function stockLow(m) { return m.min_qty > 0 && m.qty <= m.min_qty; }

async function stockMoveDialog(mat, dir, onDone) {
  // Приход заводит новую партию; списание — из выбранной партии или FIFO
  let batches = [];
  if (dir < 0) {
    try { batches = (await api(`/api/stock/${mat.id}/batches`)).filter((b) => b.qty_left > 0); }
    catch (e) { toastErr(e); }
  }
  if (dir > 0) await loadSuppliers().catch(() => null);

  const m = openModal({
    title: (dir > 0 ? 'Приход: ' : 'Списание: ') + mat.name,
    body: `
      <form id="stock-move-form" style="display:flex;flex-direction:column;gap:13px">
        <div class="muted">Остаток сейчас: <b>${fmtNum(mat.qty)} ${esc(mat.unit)}</b></div>
        ${dir < 0 && batches.length ? `
          <label class="fld"><span>Из какой партии</span>
            <select name="batch_id">
              <option value="">Автоматически — с самых старых партий (FIFO)</option>
              ${batches.map((b) => `<option value="${b.id}">${esc(b.batch_no)} — остаток ${fmtNum(b.qty_left)}${b.unit_price ? ` · ${fmtMoney(b.unit_price)}/${esc(mat.unit)}` : ''}</option>`).join('')}
            </select></label>` : ''}
        <label class="fld"><span>Количество, ${esc(mat.unit)} *</span>
          <input name="qty" type="number" step="any" min="0" required></label>
        ${dir > 0 ? `
          <label class="fld"><span>Цена закупки, ₽ за ${esc(mat.unit)}</span>
            <input name="price" type="number" step="any" min="0" value="${mat.last_price || ''}" placeholder="для стоимости остатков"></label>
          <label class="fld"><span>Поставщик</span>
            <select name="supplier_id"><option value="">— не указан —</option>${supplierOptions()}</select></label>
          <label class="fld"><span>№ партии</span>
            <input name="batch_no" type="text" placeholder="пусто — присвоится автоматически (П-${new Date().getFullYear()}-…)"></label>` : ''}
        <label class="fld"><span>Комментарий</span>
          <input name="reason" type="text" placeholder="${dir > 0 ? 'Например: поставка бумаги' : 'Например: заказ № 2026-0012'}"></label>
      </form>`,
    footer: `<button class="btn" data-act="cancel">Отмена</button>
             <button class="btn btn-primary" data-act="save">${dir > 0 ? 'Оприходовать' : 'Списать'}</button>`,
  });
  const form = $('#stock-move-form', m.body);
  const batchSel = $('select[name="batch_id"]', form);
  if (batchSel) batchSel.addEventListener('change', () => {
    const b = batches.find((x) => String(x.id) === batchSel.value);
    $('input[name="qty"]', form).max = b ? b.qty_left : '';
  });
  const saveBtn = $('[data-act="save"]', m.foot);
  async function submit() {
    if (saveBtn.disabled) return;
    if (!form.reportValidity()) return;
    const f = new FormData(form);
    const qty = Number(String(f.get('qty')).replace(',', '.'));
    if (!qty || qty <= 0) { toast('Укажите количество больше нуля', 'error'); return; }
    const body = { qty: dir * qty, reason: f.get('reason') || '' };
    if (dir > 0) {
      body.price = Number(String(f.get('price') || '').replace(',', '.')) || 0;
      body.supplier_id = Number(f.get('supplier_id')) || null;
      body.batch_no = f.get('batch_no') || '';
    } else if (f.get('batch_id')) {
      body.batch_id = Number(f.get('batch_id'));
    }
    saveBtn.disabled = true;
    try {
      await api(`/api/stock/${mat.id}/move`, { method: 'POST', body });
      m.close();
      toast(dir > 0 ? 'Приход оформлен — партия заведена' : 'Списано', 'ok');
      onDone && onDone();
    } catch (e) { toastErr(e); saveBtn.disabled = false; }
  }
  $('[data-act="cancel"]', m.foot).onclick = m.close;
  saveBtn.onclick = submit;
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
}

/* Категории материалов: связь склада со справочниками калькуляции */
const MATERIAL_CATEGORIES = {
  '': 'Прочее (в калькуляции не участвует)',
  block: 'Бумага блока и вклейки',
  cover: 'Бумага обложек (брошюры)',
  binding: 'Переплётные материалы',
  plotter: 'Материалы плоттера',
  sheet: 'Бумага листовой (плёнки, за лист)',
  notebook: 'Бумага блокнотов',
};

function stockMaterialDialog(mat, onDone) {
  const v = mat || {};
  const m = openModal({
    title: mat ? 'Материал: ' + mat.name : 'Новый материал',
    body: `
      <form id="stock-mat-form" style="display:flex;flex-direction:column;gap:13px">
        <label class="fld"><span>Название *</span><input name="name" type="text" value="${esc(v.name || '')}" required></label>
        <label class="fld"><span>Категория (для калькуляции)</span>
          <select name="category">${Object.entries(MATERIAL_CATEGORIES).map(([k, label]) =>
            `<option value="${k}" ${String(v.category || '') === k ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
        <div class="muted small" style="margin:-6px 0 0">Материал с категорией сам появится в справочнике цен
          с пометкой «настроить» — останется заполнить цены.</div>
        <label class="fld"><span>Единица учёта</span><input name="unit" type="text" value="${esc(v.unit || 'шт.')}" placeholder="лист А3, пог. м, шт.…"></label>
        ${mat ? '' : `<label class="fld"><span>Начальный остаток</span><input name="qty" type="number" step="any" value="0"></label>`}
        <label class="fld"><span>Минимальный остаток (0 — не следить)</span><input name="min_qty" type="number" step="any" value="${v.min_qty || 0}"></label>
        <label class="fld"><span>Заметки</span><input name="notes" type="text" value="${esc(v.notes || '')}"></label>
      </form>`,
    footer: `<button class="btn" data-act="cancel">Отмена</button>
             <button class="btn btn-primary" data-act="save">${mat ? 'Сохранить' : 'Добавить'}</button>`,
  });
  const form = $('#stock-mat-form', m.body);
  async function submit() {
    if (!form.reportValidity()) return;
    const f = new FormData(form);
    const body = {
      name: f.get('name'), unit: f.get('unit') || 'шт.',
      min_qty: Number(f.get('min_qty')) || 0, notes: f.get('notes') || '',
      category: f.get('category') || '',
    };
    try {
      let r = null;
      if (mat) await api('/api/stock/' + mat.id, { method: 'PUT', body });
      else r = await api('/api/stock', { method: 'POST', body: { ...body, qty: Number(f.get('qty')) || 0 } });
      m.close();
      state.schema = null;
      if (r && r.pricingPlaceholder) {
        toast('Материал добавлен и появился в настройках калькуляции — заполните цены', 'ok');
      } else {
        toast('Сохранено', 'ok');
      }
      onDone && onDone();
    } catch (e) { toastErr(e); }
  }
  $('[data-act="cancel"]', m.foot).onclick = m.close;
  $('[data-act="save"]', m.foot).onclick = submit;
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
}

async function stockHistoryDialog(mat) {
  const moves = await api(`/api/stock/${mat.id}/moves`);
  openModal({
    title: 'Движения: ' + mat.name,
    wide: true,
    body: moves.length ? `
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>Когда</th><th class="num">Кол-во</th><th>Партия</th><th>Заказ</th><th>Кто</th><th>Комментарий</th></tr></thead>
        <tbody>
          ${moves.map((mv) => `
            <tr>
              <td class="muted small">${fmtDateTime(mv.created_at)}</td>
              <td class="num" style="color:${mv.qty > 0 ? '#0a7d34' : '#C4156A'};font-weight:600">${mv.qty > 0 ? '+' : ''}${fmtNum(mv.qty)} ${esc(mat.unit)}</td>
              <td class="mono small">${esc(mv.batch_no || '—')}</td>
              <td>${mv.order_id ? `<a href="#/orders/${mv.order_id}">№ ${esc(mv.order_number || mv.order_id)}</a>` : '—'}</td>
              <td>${esc(mv.user_name || '—')}</td>
              <td class="muted">${esc(mv.reason || '')}</td>
            </tr>`).join('')}
        </tbody>
      </table></div>` : '<div class="muted">Движений ещё не было</div>',
  });
}

/* Партии материала: остаток раскладывается по каждой партии со своей ценой */
async function stockBatchesDialog(mat) {
  const rows = await api(`/api/stock/${mat.id}/batches`);
  let showEmpty = false;
  const m = openModal({ title: 'Партии: ' + mat.name, wide: true, body: '<div id="batches-box"></div>' });
  const boxEl = $('#batches-box', m.body);
  boxEl.addEventListener('click', (e) => { if (e.target.closest('a')) m.close(); });
  function render() {
    const list = rows.filter((r) => showEmpty || r.qty_left > 0);
    const totalLeft = rows.reduce((s, r) => s + r.qty_left, 0);
    const totalVal = rows.reduce((s, r) => s + r.qty_left * r.unit_price, 0);
    boxEl.innerHTML = `
      <label class="check-fld" style="margin-bottom:10px">
        <input type="checkbox" id="b-empty" ${showEmpty ? 'checked' : ''}><span>Показывать израсходованные партии</span></label>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr>
          <th>№ партии</th><th>Приход</th><th>Поставщик</th><th>Закупка</th>
          <th class="num">Цена, ₽</th><th class="num">Пришло</th><th class="num">Остаток</th><th class="num">Стоимость остатка</th>
        </tr></thead>
        <tbody>
          ${list.length ? list.map((r) => `
            <tr ${r.qty_left <= 0 ? 'style="opacity:.5"' : ''}>
              <td class="mono"><b>${esc(r.batch_no)}</b>${r.notes ? `<div class="muted small">${esc(r.notes)}</div>` : ''}</td>
              <td class="muted small">${fmtDateTime(r.received_at)}</td>
              <td>${esc(r.supplier_name || '—')}</td>
              <td>${r.purchase_id ? `<a href="#/purchases/${r.purchase_id}">${esc(r.purchase_number || '№ ' + r.purchase_id)}</a>` : '—'}</td>
              <td class="num">${r.unit_price ? fmtMoney(r.unit_price) : '—'}</td>
              <td class="num muted">${fmtNum(r.qty_initial)}</td>
              <td class="num" style="font-weight:700">${fmtNum(r.qty_left)}</td>
              <td class="num">${r.unit_price ? fmtMoney(r.qty_left * r.unit_price) : '—'}</td>
            </tr>`).join('') : '<tr><td colspan="8" class="empty-note">Партий нет — оформите приход или приёмку закупки</td></tr>'}
        </tbody>
      </table></div>
      <div class="muted small" style="margin-top:10px">
        Итого по партиям: <b>${fmtNum(totalLeft)} ${esc(mat.unit)}</b> на <b>${fmtMoney(totalVal)}</b>.
        Списание разбирает партии с самых старых (FIFO); при списании можно выбрать конкретную партию.</div>`;
    $('#b-empty', boxEl).addEventListener('change', (e) => { showEmpty = e.target.checked; render(); });
  }
  render();
}

views.stock = async function (box) {
  const isAdmin = can('stock.edit');
  const seeValue = can(['purchases', 'money.cost']); // стоимость склада по закупочным ценам
  const filters = { q: '', low: false };

  box.innerHTML = `
    <div class="page-head">
      <div class="toolbar">
        <input type="text" id="st-q" placeholder="Поиск материала…" style="width:230px">
        <label class="check-fld"><input type="checkbox" id="st-low"><span>Только заканчивающиеся</span></label>
      </div>
      ${isAdmin ? '<button class="btn btn-primary" id="btn-new-mat">+ Новый материал</button>' : ''}
    </div>
    <div id="stock-body"><div class="empty-note">Загрузка…</div></div>`;
  const body = $('#stock-body', box);

  async function refresh() {
    let rows = await api('/api/stock');
    const totalCount = rows.length;
    const lowCount = rows.filter(stockLow).length;
    const totalValue = rows.reduce((s, r) => s + (r.stock_value || 0), 0);
    const totalBatches = rows.reduce((s, r) => s + (r.batches_active || 0), 0);
    if (filters.q) {
      const q = filters.q.toLowerCase();
      rows = rows.filter((r) => r.name.toLowerCase().includes(q));
    }
    if (filters.low) rows = rows.filter(stockLow);
    body.innerHTML = `
      <div class="stat-tiles">
        ${seeValue ? `<div class="tile t-main"><div class="t-label">Стоимость склада</div><div class="t-value">${fmtMoney(totalValue)}</div></div>` : ''}
        <div class="tile"><div class="t-label">Позиций</div><div class="t-value">${fmtNum(totalCount)}</div></div>
        <div class="tile"><div class="t-label">Активных партий</div><div class="t-value">${fmtNum(totalBatches)}</div></div>
        <div class="tile"><div class="t-label">Заканчивается</div><div class="t-value" ${lowCount ? 'style="color:#C4156A"' : ''}>${fmtNum(lowCount)}</div></div>
      </div>
      ${lowCount ? `<div class="warn-box" style="margin-bottom:12px"><b>Заканчивается:</b> позиций с остатком ниже минимума — ${lowCount}.
        ${can('purchases') ? '<a href="#/purchases">Создать закупку по дефициту →</a>' : ''}</div>` : ''}
      <div class="panel tbl-wrap">
        <table class="tbl">
          <thead><tr>
            <th>Материал</th><th>Ед. учёта</th><th class="num">Остаток</th>${seeValue ? '<th class="num">Стоимость остатка</th>' : ''}
            <th>Движение</th><th></th>
          </tr></thead>
          <tbody>
            ${rows.length ? rows.map((r) => `
              <tr data-id="${r.id}">
                <td><b>${esc(r.name)}</b>${r.category ? `<div class="muted small">${esc((MATERIAL_CATEGORIES[r.category] || '').split(' (')[0])}</div>` : ''}${r.notes ? `<div class="muted small">${esc(r.notes)}</div>` : ''}</td>
                <td class="muted">${esc(r.unit)}</td>
                <td class="num" style="font-weight:700;${r.qty < 0 || stockLow(r) ? 'color:#C4156A' : ''}">
                  ${fmtNum(r.qty)}${stockLow(r) ? ' <span class="badge st-cancelled">мало</span>' : ''}
                  ${r.min_qty ? `<div class="muted small" style="font-weight:400">мин. ${fmtNum(r.min_qty)}</div>` : ''}</td>
                ${seeValue ? `<td class="num">${r.stock_value ? fmtMoney(r.stock_value) : '—'}</td>` : ''}
                <td class="muted small" style="white-space:nowrap" title="${r.last_move ? esc(fmtDateTime(r.last_move)) : ''}">${r.last_move ? fmtDate(r.last_move) : '—'}</td>
                <td style="white-space:nowrap">
                  <div class="toolbar" style="justify-content:flex-end;flex-wrap:nowrap;gap:4px">
                    <button class="btn btn-sm st-in${isAdmin ? '' : ' hidden'}">+ Приход</button>
                    <button class="btn btn-sm st-out${isAdmin ? '' : ' hidden'}">− Списать</button>
                    <button class="btn btn-sm st-batches" title="Остаток по партиям">Партии${r.batches_active ? ` (${r.batches_active})` : ''}</button>
                    <button class="btn btn-sm btn-ghost st-hist" title="История движений" style="padding:5px 6px">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                    </button>
                    ${isAdmin ? '<button class="btn btn-sm btn-ghost st-edit" title="Изменить" style="padding:5px 6px">✎</button><button class="btn btn-sm btn-ghost st-del" title="Удалить" style="padding:5px 6px">✕</button>' : ''}
                  </div>
                </td>
              </tr>`).join('') : '<tr><td colspan="6" class="empty-note">Материалов не найдено</td></tr>'}
          </tbody>
        </table>
      </div>
      ${seeValue ? `<div class="muted small" style="margin-top:10px">Стоимость остатков считается по ценам партий (закупочным).
        Позиции без цены прихода в стоимости не участвуют.</div>` : ''}`;

    $$('tbody tr[data-id]', body).forEach((tr) => {
      const mat = rows.find((r) => String(r.id) === tr.dataset.id);
      if (!mat) return;
      $('.st-in', tr).addEventListener('click', () => stockMoveDialog(mat, +1, refresh).catch(toastErr));
      $('.st-out', tr).addEventListener('click', () => stockMoveDialog(mat, -1, refresh).catch(toastErr));
      $('.st-batches', tr).addEventListener('click', () => stockBatchesDialog(mat).catch(toastErr));
      $('.st-hist', tr).addEventListener('click', () => stockHistoryDialog(mat).catch(toastErr));
      const ed = $('.st-edit', tr);
      if (ed) ed.addEventListener('click', () => stockMaterialDialog(mat, refresh));
      const del = $('.st-del', tr);
      if (del) del.addEventListener('click', async () => {
        if (!await confirmDlg(`Удалить материал «${mat.name}» вместе с историей движений и партиями?`)) return;
        try { await api('/api/stock/' + mat.id, { method: 'DELETE' }); toast('Материал удалён', 'ok'); await refresh(); }
        catch (e) { toastErr(e); }
      });
    });
  }

  $('#st-q', box).addEventListener('input', debounce(async (e) => { filters.q = e.target.value.trim(); await refresh(); }));
  $('#st-low', box).addEventListener('change', async (e) => { filters.low = e.target.checked; await refresh(); });
  const newBtn = $('#btn-new-mat', box);
  if (newBtn) newBtn.addEventListener('click', () => stockMaterialDialog(null, refresh));

  await refresh();
};

/* ================= ЗАКУПКИ ================= */

function supplierOptions(selectedId) {
  return (state.suppliers || [])
    .filter((s) => s.active || String(s.id) === String(selectedId ?? ''))
    .map((s) => `<option value="${s.id}" ${String(s.id) === String(selectedId ?? '') ? 'selected' : ''}>${esc(s.name)}</option>`)
    .join('');
}

function supplierDialog(supplier, onDone) {
  const s = supplier || {};
  const m = openModal({
    title: supplier ? 'Поставщик: ' + supplier.name : 'Новый поставщик',
    body: `
      <form id="supplier-form" class="form-grid">
        <label class="fld span2"><span>Название *</span><input name="name" type="text" value="${esc(s.name || '')}" required></label>
        <label class="fld"><span>Контактное лицо</span><input name="contact_person" type="text" value="${esc(s.contact_person || '')}"></label>
        <label class="fld"><span>Телефон</span><input name="phone" type="text" value="${esc(s.phone || '')}"></label>
        <label class="fld"><span>E-mail</span><input name="email" type="email" value="${esc(s.email || '')}"></label>
        <label class="fld"><span>ИНН</span><input name="inn" type="text" value="${esc(s.inn || '')}"></label>
        <label class="fld span2"><span>Условия оплаты и поставки</span>
          <input name="terms" type="text" value="${esc(s.terms || '')}" placeholder="Например: предоплата 50%, доставка 5 раб. дней"></label>
        <label class="fld span2"><span>Заметки</span><textarea name="notes" rows="2">${esc(s.notes || '')}</textarea></label>
        ${supplier ? `<label class="check-fld span2"><input type="checkbox" name="active" ${s.active ? 'checked' : ''}><span>Работаем с этим поставщиком</span></label>` : ''}
      </form>`,
    footer: `<button class="btn" data-act="cancel">Отмена</button>
             <button class="btn btn-primary" data-act="save">${supplier ? 'Сохранить' : 'Добавить'}</button>`,
  });
  const form = $('#supplier-form', m.body);
  async function submit() {
    if (!form.reportValidity()) return;
    const f = new FormData(form);
    const body = Object.fromEntries(['name', 'contact_person', 'phone', 'email', 'inn', 'terms', 'notes'].map((k) => [k, f.get(k) || '']));
    if (supplier) body.active = !!f.get('active');
    try {
      if (supplier) await api('/api/suppliers/' + supplier.id, { method: 'PUT', body });
      else await api('/api/suppliers', { method: 'POST', body });
      m.close();
      toast(supplier ? 'Поставщик сохранён' : 'Поставщик добавлен', 'ok');
      await loadSuppliers(true);
      onDone && onDone();
    } catch (e) { toastErr(e); }
  }
  $('[data-act="cancel"]', m.foot).onclick = m.close;
  $('[data-act="save"]', m.foot).onclick = submit;
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
}

/* Новая закупка; preset.items — заготовка позиций (например, дефицит со склада) */
function newPurchaseDialog(preset = {}) {
  const m = openModal({
    title: 'Новая закупка',
    body: `
      <form id="new-purch-form" style="display:flex;flex-direction:column;gap:13px">
        <label class="fld"><span>Поставщик</span>
          <select name="supplier_id"><option value="">— выберу позже —</option>${supplierOptions(preset.supplier_id)}</select></label>
        <label class="fld"><span>Ожидаемая дата поставки</span><input name="expected_date" type="date"></label>
        <label class="fld"><span>Заметки</span><input name="notes" type="text" placeholder="Например: счёт № 214 от 12.07"></label>
        ${preset.items && preset.items.length ? `
          <div class="warn-box">В закупку будут добавлены позиции по дефициту склада: <b>${preset.items.length}</b>.
            Количество и цены можно поправить в карточке закупки.</div>` : ''}
        ${(state.suppliers || []).length ? '' : '<div class="muted small">Поставщиков ещё нет — добавьте их на вкладке «Поставщики», чтобы печатать бланк заказа с контактами.</div>'}
      </form>`,
    footer: `<button class="btn" data-act="cancel">Отмена</button>
             <button class="btn btn-primary" data-act="save">Создать закупку</button>`,
  });
  const form = $('#new-purch-form', m.body);
  async function submit() {
    const f = new FormData(form);
    try {
      const r = await api('/api/purchases', {
        method: 'POST',
        body: {
          supplier_id: Number(f.get('supplier_id')) || null,
          expected_date: f.get('expected_date') || '',
          notes: f.get('notes') || '',
          items: preset.items || [],
        },
      });
      m.close();
      toast(`Закупка ${r.number} создана`, 'ok');
      navigate('#/purchases/' + r.id);
    } catch (e) { toastErr(e); }
  }
  $('[data-act="cancel"]', m.foot).onclick = m.close;
  $('[data-act="save"]', m.foot).onclick = submit;
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
}

views.purchases = async function (box, arg, query) {
  await loadSuppliers(true);
  let tab = query && query.get('tab') === 'suppliers' ? 'suppliers' : 'list';
  let renderSeq = 0; // защита от гонки при быстром переключении вкладок

  box.innerHTML = `
    <div class="tabs">
      <button data-tab="list">Закупки</button>
      <button data-tab="suppliers">Поставщики</button>
    </div>
    <div id="purch-body"></div>`;
  const body = $('#purch-body', box);

  $$('.tabs button', box).forEach((b) => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    syncTabs();
    render();
  }));
  function syncTabs() {
    $$('.tabs button', box).forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  }

  /* --- вкладка «Закупки» --- */
  async function renderList() {
    const seq = ++renderSeq;
    const filters = { q: '', status: '', supplier_id: '' };
    const stock = await api('/api/stock').catch(() => []);
    if (seq !== renderSeq) return;
    const lowMats = stock.filter(stockLow);

    body.innerHTML = `
      ${lowMats.length ? `
        <div class="warn-box" style="margin-bottom:14px">
          <b>Пора заказывать:</b> ${lowMats.slice(0, 6).map((m) => esc(m.name)).join(', ')}${lowMats.length > 6 ? ` и ещё ${lowMats.length - 6}` : ''}.
          <div style="margin-top:8px"><button class="btn btn-sm" id="btn-deficit">Создать закупку по дефициту (${lowMats.length})</button></div>
        </div>` : ''}
      <div class="page-head">
        <div class="toolbar">
          <input type="text" id="pu-q" placeholder="Поиск: номер, поставщик…" style="width:230px">
          <select id="pu-status">
            <option value="">Все статусы</option>
            ${PURCH_STATUSES.map((s) => `<option value="${s.key}">${s.label}</option>`).join('')}
          </select>
          <select id="pu-supplier">
            <option value="">Все поставщики</option>
            ${(state.suppliers || []).map((s) => `<option value="${s.id}">${esc(s.name)}${s.active ? '' : ' (не работаем)'}</option>`).join('')}
          </select>
        </div>
        <button class="btn btn-primary" id="btn-new-purch">+ Новая закупка</button>
      </div>
      <div id="purch-list"><div class="empty-note">Загрузка…</div></div>`;

    const listEl = $('#purch-list', body);
    async function refresh() {
      const p = new URLSearchParams();
      if (filters.q) p.set('q', filters.q);
      if (filters.status) p.set('status', filters.status);
      if (filters.supplier_id) p.set('supplier_id', filters.supplier_id);
      const rows = await api('/api/purchases?' + p.toString());
      if (seq !== renderSeq) return;
      if (!rows.length) { listEl.innerHTML = '<div class="panel empty-note">Закупок не найдено. Создайте первую — «+ Новая закупка».</div>'; return; }
      listEl.innerHTML = `
        <div class="panel tbl-wrap">
          <table class="tbl">
            <thead><tr>
              <th>№</th><th>Поставщик</th><th>Статус</th><th class="num">Позиций</th><th class="num">Сумма</th>
              <th>Поставка к</th><th>Создал</th><th>Создана</th>
            </tr></thead>
            <tbody>
              ${rows.map((r) => `
                <tr class="clickable" data-id="${r.id}">
                  <td class="mono">${esc(r.number)}</td>
                  <td><b>${esc(r.supplier_name || '—')}</b></td>
                  <td>${purchStatusBadge(r.status)}</td>
                  <td class="num">${r.items_count}</td>
                  <td class="num">${r.total ? fmtMoney(r.total) : '—'}</td>
                  <td>${r.expected_date ? `<span class="${['ordered', 'partial'].includes(r.status) && isOverdue(r.expected_date) ? 'overdue' : ''}">${fmtDate(r.expected_date)}</span>` : '—'}</td>
                  <td>${esc(r.user_name || '—')}</td>
                  <td class="muted small">${fmtDate(r.created_at)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
      $$('tr.clickable', listEl).forEach((tr) =>
        tr.addEventListener('click', () => navigate('#/purchases/' + tr.dataset.id)));
    }

    $('#pu-q', body).addEventListener('input', debounce(async (e) => { filters.q = e.target.value.trim(); await refresh(); }));
    $('#pu-status', body).addEventListener('change', async (e) => { filters.status = e.target.value; await refresh(); });
    $('#pu-supplier', body).addEventListener('change', async (e) => { filters.supplier_id = e.target.value; await refresh(); });
    $('#btn-new-purch', body).addEventListener('click', () => newPurchaseDialog());
    const defBtn = $('#btn-deficit', body);
    if (defBtn) defBtn.addEventListener('click', () => {
      // заказ до двойного минимума: чтобы после прихода остаток не был снова «на грани»
      const items = lowMats.map((mt) => ({
        material_id: mt.id,
        qty: Math.max(Math.ceil(mt.min_qty * 2 - mt.qty), 1),
        price: mt.last_price || 0,
      }));
      newPurchaseDialog({ items });
    });

    await refresh();
  }

  /* --- вкладка «Поставщики» --- */
  async function renderSuppliers() {
    const seq = ++renderSeq;
    const rows = await loadSuppliers(true);
    if (seq !== renderSeq) return;
    const isAdmin = can('purchases');
    body.innerHTML = `
      <div class="page-head">
        <span class="muted small">Справочник поставщиков материалов. Из карточки закупки печатается бланк заказа с контактами поставщика.</span>
        <button class="btn btn-primary" id="btn-new-supplier">+ Новый поставщик</button>
      </div>
      <div class="panel tbl-wrap">
        <table class="tbl">
          <thead><tr>
            <th>Название</th><th>Контакт</th><th>Телефон</th><th>E-mail</th><th>Условия</th>
            <th class="num">Закупок</th><th class="num">Сумма</th><th style="width:110px"></th>
          </tr></thead>
          <tbody>
            ${rows.length ? rows.map((s) => `
              <tr data-id="${s.id}" ${s.active ? '' : 'style="opacity:.55"'}>
                <td><b>${esc(s.name)}</b>${s.active ? '' : ' <span class="badge st-cancelled">не работаем</span>'}
                  ${s.notes ? `<div class="muted small">${esc(s.notes)}</div>` : ''}</td>
                <td>${esc(s.contact_person || '—')}</td>
                <td class="mono">${esc(s.phone || '—')}</td>
                <td>${s.email ? `<a href="mailto:${esc(s.email)}">${esc(s.email)}</a>` : '—'}</td>
                <td class="muted small">${esc(s.terms || '—')}</td>
                <td class="num">${s.purchases_count}</td>
                <td class="num">${s.purchases_total ? fmtMoney(s.purchases_total) : '—'}</td>
                <td>
                  <div class="toolbar" style="justify-content:flex-end">
                    <button class="btn btn-sm sp-edit">✎</button>
                    ${isAdmin && !s.purchases_count ? '<button class="btn btn-sm btn-ghost sp-del" title="Удалить">✕</button>' : ''}
                  </div>
                </td>
              </tr>`).join('') : '<tr><td colspan="8" class="empty-note">Поставщиков ещё нет — добавьте первого</td></tr>'}
          </tbody>
        </table>
      </div>`;
    $('#btn-new-supplier', body).addEventListener('click', () => supplierDialog(null, renderSuppliers));
    $$('tbody tr[data-id]', body).forEach((tr) => {
      const s = rows.find((x) => String(x.id) === tr.dataset.id);
      if (!s) return;
      $('.sp-edit', tr).addEventListener('click', () => supplierDialog(s, renderSuppliers));
      const del = $('.sp-del', tr);
      if (del) del.addEventListener('click', async () => {
        if (!await confirmDlg(`Удалить поставщика «${s.name}»?`)) return;
        try { await api('/api/suppliers/' + s.id, { method: 'DELETE' }); await loadSuppliers(true); toast('Поставщик удалён', 'ok'); renderSuppliers(); }
        catch (e) { toastErr(e); }
      });
    });
  }

  function render() {
    (tab === 'list' ? renderList() : renderSuppliers())
      .catch((e) => { body.innerHTML = `<div class="form-error">${esc(e.message)}</div>`; });
  }
  syncTabs();
  render();
};

/* ================= КАРТОЧКА ЗАКУПКИ ================= */

/* Приёмка: принятое приходуется на склад партиями по цене закупки */
function purchaseReceiveDialog(p, onDone) {
  const rows = p.items
    .map((i) => ({ i, remain: Math.max(i.qty - i.received_qty, 0) }))
    .filter((r) => r.remain > 0);
  if (!rows.length) { toast('Всё уже принято', 'ok'); return; }
  const m = openModal({
    title: `Приёмка на склад — ${p.number}`,
    wide: true,
    body: `
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr>
          <th>Материал</th><th class="num">Заказано</th><th class="num">Уже получено</th>
          <th>Принять сейчас</th><th>№ партии</th>
        </tr></thead>
        <tbody>
          ${rows.map((r, idx) => `
            <tr>
              <td><b>${esc(r.i.material_name || '—')}</b> <span class="muted small">${esc(r.i.material_unit || '')}</span></td>
              <td class="num">${fmtNum(r.i.qty)}</td>
              <td class="num muted">${fmtNum(r.i.received_qty)}</td>
              <td><input type="number" step="any" min="0" max="${r.remain}" value="${r.remain}" data-idx="${idx}" style="width:110px"></td>
              <td><input type="text" data-batch="${idx}" placeholder="авто" style="width:130px"></td>
            </tr>`).join('')}
        </tbody>
      </table></div>
      <div class="muted small" style="margin-top:10px">
        Каждая принятая позиция станет отдельной партией на складе с ценой из закупки.
        Если приехала часть — примите её, закупка станет «Частично получено».</div>`,
    footer: `<button class="btn" data-act="cancel">Отмена</button>
             <button class="btn btn-primary" data-act="save">Принять на склад</button>`,
  });
  $('[data-act="cancel"]', m.foot).onclick = m.close;
  const saveBtn = $('[data-act="save"]', m.foot);
  saveBtn.onclick = async () => {
    const items = [];
    for (const inp of $$('input[data-idx]', m.body)) {
      const r = rows[Number(inp.dataset.idx)];
      const qty = Number(String(inp.value).replace(',', '.'));
      if (!qty || qty <= 0) continue;
      if (qty > r.remain + 1e-9) {
        toast(`«${r.i.material_name}»: можно принять не больше ${fmtNum(r.remain)} ${r.i.material_unit}`, 'error');
        return;
      }
      const batchInp = $(`input[data-batch="${inp.dataset.idx}"]`, m.body);
      items.push({ item_id: r.i.id, qty, batch_no: (batchInp && batchInp.value.trim()) || '' });
    }
    if (!items.length) { toast('Укажите количество к приёмке', 'error'); return; }
    saveBtn.disabled = true;
    try {
      const r = await api(`/api/purchases/${p.id}/receive`, { method: 'POST', body: { items } });
      m.close();
      toast(r.status === 'received' ? 'Закупка получена полностью' : 'Принято, закупка получена частично', 'ok');
      onDone && onDone();
    } catch (e) { toastErr(e); saveBtn.disabled = false; }
  };
}

/* Печатный бланк заказа поставщику */
function printPurchaseForm(p) {
  const d = new Date();
  const dateStr = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  const total = p.items.reduce((s, i) => s + i.qty * i.price, 0);
  $('#print-area').innerHTML = `
    <div class="kp">
      <div class="kp-head">
        <div>
          <img src="./logo.webp" alt="raduga">
          <div><b>${esc(COMPANY.brand)}</b></div>
          <div class="kp-slogan">${esc(COMPANY.slogan)}</div>
        </div>
        <div class="kp-requisites">
          <b>${esc(COMPANY.legal)}</b><br>
          ${esc(COMPANY.address)}<br>
          ${esc(COMPANY.phone)} · ${esc(COMPANY.email)}<br>
          ${esc(COMPANY.inn)}
        </div>
      </div>
      <div class="kp-rainbow"></div>

      <h1>Заказ поставщику № ${esc(p.number)}</h1>
      <div class="kp-date">от ${dateStr}</div>

      <div class="kp-block">
        <b class="kp-cap">Поставщик</b>
        ${esc(p.supplier_name || '— не выбран —')}
        ${p.supplier_contact ? ` · ${esc(p.supplier_contact)}` : ''}
        ${p.supplier_phone || p.supplier_email ? `<br><span style="color:#666">${esc([p.supplier_phone, p.supplier_email].filter(Boolean).join(' · '))}</span>` : ''}
        ${p.supplier_inn ? `<br><span style="color:#666">ИНН ${esc(p.supplier_inn)}</span>` : ''}
      </div>

      <table>
        <thead><tr><th>№</th><th>Наименование</th><th>Кол-во</th><th>Ед.</th><th>Цена, ₽</th><th>Сумма, ₽</th></tr></thead>
        <tbody>
          ${p.items.map((i, n) => `
            <tr>
              <td>${n + 1}</td>
              <td>${esc(i.material_name || '—')}${i.notes ? ` <span style="color:#666">(${esc(i.notes)})</span>` : ''}</td>
              <td class="num">${fmtNum(i.qty)}</td>
              <td>${esc(i.material_unit || '')}</td>
              <td class="num">${i.price ? fmtMoney(i.price) : '—'}</td>
              <td class="num">${i.price ? fmtMoney(i.qty * i.price) : '—'}</td>
            </tr>`).join('')}
        </tbody>
      </table>

      ${total ? `<div class="kp-total">Итого: ${fmtMoney(total)}</div>` : ''}
      ${p.expected_date ? `<div>Желаемая дата поставки: <b>${fmtDate(p.expected_date)}</b></div>` : ''}
      ${p.supplier_terms ? `<div>Условия: ${esc(p.supplier_terms)}</div>` : ''}
      ${p.notes ? `<div class="kp-block"><b class="kp-cap">Примечания</b>${esc(p.notes)}</div>` : ''}

      <div class="kp-note">
        Просим подтвердить получение заказа, цены и срок поставки.
        В счетах, накладных и на упаковке просим указывать номер заказа ${esc(p.number)}.
        Адрес доставки: ${esc(COMPANY.address)}.
      </div>

      <div class="kp-sign">
        <div>Заказ составил: ${esc(p.user_name || state.user.name)}<br>
          <span class="kp-slogan">${esc(COMPANY.phone)} · ${esc(COMPANY.email)}</span></div>
        <div>Подпись: <span class="line"></span></div>
      </div>
    </div>`;
  setTimeout(() => window.print(), 60);
}

views.purchase = async function (box, id) {
  const [p, stock] = await Promise.all([api('/api/purchases/' + id), api('/api/stock'), loadSuppliers()]);
  $('#page-title').textContent = `Закупка ${p.number}`;
  const isAdmin = can('purchases');
  const hasReceived = p.items.some((i) => i.received_qty > 0);
  const editable = ['draft', 'ordered'].includes(p.status) && !hasReceived;
  const headerEditable = !['received', 'cancelled'].includes(p.status);

  // локальная копия позиций для редактирования
  const items = p.items.map((i) => ({ ...i }));
  const total = () => items.reduce((s, i) => s + (+i.qty || 0) * (+i.price || 0), 0);

  box.innerHTML = `
    <div class="page-head">
      <h2>${esc(p.number)} · ${esc(p.supplier_name || 'Поставщик не выбран')} &nbsp;${purchStatusBadge(p.status)}</h2>
      <div class="toolbar" id="purch-actions">
        ${headerEditable ? '<button class="btn btn-primary" id="btn-pu-save">Сохранить</button>' : ''}
        ${p.status === 'draft' ? '<button class="btn" id="btn-pu-order" title="Зафиксировать заказ и отправить поставщику">→ Заказано</button>' : ''}
        ${['ordered', 'partial'].includes(p.status) ? '<button class="btn btn-primary" id="btn-pu-receive">Приёмка на склад</button>' : ''}
        <button class="btn" id="btn-pu-print" ${items.length ? '' : 'disabled title="Нет позиций"'}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
          Бланк заказа</button>
        ${p.status === 'ordered' ? '<button class="btn" id="btn-pu-back">Вернуть в черновик</button>' : ''}
        ${p.status === 'partial' ? '<button class="btn" id="btn-pu-close" title="Остаток не будет поставлен">Закрыть закупку</button>' : ''}
        ${['draft', 'ordered', 'partial'].includes(p.status) ? '<button class="btn btn-danger" id="btn-pu-cancel">Отменить</button>' : ''}
        ${p.status === 'cancelled' ? '<button class="btn" id="btn-pu-reopen">Вернуть в работу</button>' : ''}
        ${isAdmin && !hasReceived ? '<button class="btn btn-danger" id="btn-pu-del">Удалить</button>' : ''}
      </div>
    </div>
    <div class="order-grid">
      <div>
        <div class="panel panel-pad">
          <h3>Данные закупки</h3>
          <form id="purch-form" class="form-grid">
            <label class="fld"><span>Поставщик</span>
              <select name="supplier_id" ${headerEditable ? '' : 'disabled'}>
                <option value="">— не выбран —</option>${supplierOptions(p.supplier_id)}
              </select></label>
            <label class="fld"><span>Ожидаемая дата поставки</span>
              <input name="expected_date" type="date" value="${esc(p.expected_date)}" ${headerEditable ? '' : 'disabled'}></label>
            <label class="fld span2"><span>Заметки</span>
              <textarea name="notes" rows="2" ${headerEditable ? '' : 'disabled'}>${esc(p.notes)}</textarea></label>
          </form>
          <div class="muted small" style="margin-top:8px">
            Создана ${fmtDateTime(p.created_at)} · ${esc(p.user_name || '')}</div>
        </div>

        <div class="panel panel-pad">
          <h3>Позиции ${editable ? '' : '<span class="muted small">(состав зафиксирован)</span>'}</h3>
          <div class="tbl-wrap">
            <table class="tbl" id="pi-tbl">
              <thead><tr>
                <th style="min-width:220px">Материал</th><th style="width:110px">Кол-во</th><th>Ед.</th>
                <th style="width:120px">Цена, ₽</th><th class="num">Сумма</th>
                ${hasReceived ? '<th class="num">Получено</th>' : ''}
                ${editable ? '<th style="width:40px"></th>' : ''}
              </tr></thead>
              <tbody></tbody>
              <tfoot><tr>
                <td colspan="4" style="text-align:right"><b>Итого:</b></td>
                <td class="num" id="pi-total" style="font-weight:700"></td>
                ${hasReceived ? '<td></td>' : ''}${editable ? '<td></td>' : ''}
              </tr></tfoot>
            </table>
          </div>
          ${editable ? '<button class="btn btn-sm" id="pi-add" style="margin-top:10px">+ Добавить позицию</button>' : ''}
        </div>
      </div>
      <div>
        <div class="panel panel-pad">
          <h3>Поставщик</h3>
          ${p.supplier_id ? `
            <dl class="info-list">
              <dt>Название</dt><dd>${esc(p.supplier_name || '—')}</dd>
              <dt>Контакт</dt><dd>${esc(p.supplier_contact || '—')}</dd>
              <dt>Телефон</dt><dd class="mono">${esc(p.supplier_phone || '—')}</dd>
              <dt>E-mail</dt><dd>${p.supplier_email ? `<a href="mailto:${esc(p.supplier_email)}">${esc(p.supplier_email)}</a>` : '—'}</dd>
              <dt>Условия</dt><dd>${esc(p.supplier_terms || '—')}</dd>
            </dl>` : '<div class="muted">Поставщик не выбран. Выберите его в данных закупки — контакты попадут в бланк заказа.</div>'}
        </div>
        <div class="panel panel-pad">
          <h3>История</h3>
          ${p.log && p.log.length ? `
            <ul class="log-list">
              ${p.log.map((l) => `
                <li><span class="log-when">${fmtDateTime(l.created_at)}</span>
                    <span>${esc(l.event)} <span class="log-who">· ${esc(l.user_name || '')}</span></span></li>`).join('')}
            </ul>` : '<div class="muted">Пока пусто</div>'}
        </div>
      </div>
    </div>`;

  /* --- позиции --- */
  const tbody = $('#pi-tbl tbody', box);
  const materialOpts = (selectedId, selectedName) => {
    const opts = stock.map((mt) =>
      `<option value="${mt.id}" data-unit="${esc(mt.unit)}" data-price="${mt.last_price || 0}" ${String(mt.id) === String(selectedId ?? '') ? 'selected' : ''}>${esc(mt.name)}</option>`).join('');
    // материал могли удалить со склада — не подменяем его молча первым в списке
    const missing = selectedId && !stock.some((mt) => String(mt.id) === String(selectedId))
      ? `<option value="${selectedId}" selected>${esc(selectedName || 'Материал')} (нет на складе)</option>` : '';
    return missing + opts;
  };

  function renderItems() {
    if (!items.length) {
      const cols = 5 + (hasReceived ? 1 : 0) + (editable ? 1 : 0);
      tbody.innerHTML = `<tr><td colspan="${cols}" class="empty-note">Позиций нет${editable ? ' — добавьте материалы' : ''}</td></tr>`;
    } else {
      tbody.innerHTML = items.map((i, idx) => {
        const sum = (+i.qty || 0) * (+i.price || 0);
        if (!editable) {
          const mt = stock.find((x) => x.id === i.material_id);
          return `
            <tr>
              <td><b>${esc(i.material_name || (mt && mt.name) || '—')}</b></td>
              <td class="num">${fmtNum(i.qty)}</td>
              <td class="muted">${esc(i.material_unit || (mt && mt.unit) || '')}</td>
              <td class="num">${i.price ? fmtMoney(i.price) : '—'}</td>
              <td class="num">${sum ? fmtMoney(sum) : '—'}</td>
              ${hasReceived ? `<td class="num" style="${i.received_qty >= i.qty - 1e-9 ? 'color:#0a7d34' : i.received_qty > 0 ? 'color:#a16207' : ''}">${fmtNum(i.received_qty)}</td>` : ''}
            </tr>`;
        }
        return `
          <tr data-idx="${idx}">
            <td><select class="pi-mat">${materialOpts(i.material_id, i.material_name)}</select></td>
            <td><input class="pi-qty" type="number" step="any" min="0" value="${i.qty || ''}" style="width:100px"></td>
            <td class="muted pi-unit">${esc(i.material_unit || '')}</td>
            <td><input class="pi-price" type="number" step="any" min="0" value="${i.price || ''}" style="width:110px"></td>
            <td class="num pi-sum">${sum ? fmtMoney(sum) : '—'}</td>
            ${hasReceived ? `<td class="num">${fmtNum(i.received_qty)}</td>` : ''}
            <td><button class="btn btn-ghost btn-sm pi-del" title="Убрать">✕</button></td>
          </tr>`;
      }).join('');
    }
    $('#pi-total', box).textContent = total() ? fmtMoney(total()) : '—';

    if (!editable) return;
    $$('tr[data-idx]', tbody).forEach((tr) => {
      const idx = Number(tr.dataset.idx);
      const it = items[idx];
      const sel = $('.pi-mat', tr);
      sel.addEventListener('change', () => {
        const opt = sel.selectedOptions[0];
        it.material_id = Number(sel.value);
        it.material_unit = opt ? opt.dataset.unit : '';
        $('.pi-unit', tr).textContent = it.material_unit;
        if (!(+it.price) && opt && +opt.dataset.price) {
          it.price = +opt.dataset.price;
          $('.pi-price', tr).value = it.price;
        }
        updateSum();
      });
      const updateSum = () => {
        const s = (+it.qty || 0) * (+it.price || 0);
        $('.pi-sum', tr).textContent = s ? fmtMoney(s) : '—';
        $('#pi-total', box).textContent = total() ? fmtMoney(total()) : '—';
      };
      $('.pi-qty', tr).addEventListener('input', (e) => { it.qty = Number(String(e.target.value).replace(',', '.')) || 0; updateSum(); });
      $('.pi-price', tr).addEventListener('input', (e) => { it.price = Number(String(e.target.value).replace(',', '.')) || 0; updateSum(); });
      $('.pi-del', tr).addEventListener('click', () => { items.splice(idx, 1); renderItems(); });
    });
  }
  renderItems();

  const addBtn = $('#pi-add', box);
  if (addBtn) addBtn.addEventListener('click', () => {
    if (!stock.length) { toast('На складе нет материалов — сначала добавьте их в разделе «Склад»', 'error'); return; }
    const first = stock[0];
    items.push({
      material_id: first ? first.id : null,
      material_unit: first ? first.unit : '',
      qty: 0, price: first ? (first.last_price || 0) : 0, received_qty: 0,
    });
    renderItems();
    const lastQty = $$('.pi-qty', tbody).pop();
    if (lastQty) lastQty.focus();
  });

  /* --- сохранение и статусы --- */
  async function saveForm() {
    const f = new FormData($('#purch-form', box));
    const body = {
      supplier_id: Number(f.get('supplier_id')) || null,
      expected_date: f.get('expected_date') || '',
      notes: f.get('notes') || '',
    };
    if (editable) {
      body.items = items
        .filter((i) => i.material_id && +i.qty > 0)
        .map((i) => ({ material_id: i.material_id, qty: +i.qty, price: +i.price || 0, notes: i.notes || '' }));
    }
    await api('/api/purchases/' + id, { method: 'PUT', body });
  }

  async function setStatus(status) {
    if (headerEditable) await saveForm();
    await api('/api/purchases/' + id, { method: 'PUT', body: { status } });
  }

  const on = (sel, fn) => { const el = $(sel, box); if (el) el.addEventListener('click', () => fn().catch(toastErr)); };

  on('#btn-pu-save', async () => { await saveForm(); toast('Закупка сохранена', 'ok'); renderRoute(); });
  on('#btn-pu-order', async () => {
    if (!items.filter((i) => i.material_id && +i.qty > 0).length) { toast('Добавьте позиции в закупку', 'error'); return; }
    await setStatus('ordered');
    toast('Закупка переведена в «Заказано»', 'ok');
    renderRoute();
  });
  on('#btn-pu-back', async () => { await setStatus('draft'); renderRoute(); });
  on('#btn-pu-close', async () => {
    if (!await confirmDlg('Закрыть закупку? Недопоставленный остаток принять будет нельзя.', 'Закрыть')) return;
    await setStatus('received');
    toast('Закупка закрыта', 'ok');
    renderRoute();
  });
  on('#btn-pu-cancel', async () => {
    if (!await confirmDlg(`Отменить закупку ${p.number}?`, 'Отменить закупку')) return;
    await api('/api/purchases/' + id, { method: 'PUT', body: { status: 'cancelled' } });
    toast('Закупка отменена', 'ok');
    renderRoute();
  });
  on('#btn-pu-reopen', async () => { await api('/api/purchases/' + id, { method: 'PUT', body: { status: 'draft' } }); renderRoute(); });
  on('#btn-pu-del', async () => {
    if (!await confirmDlg(`Удалить закупку ${p.number}? Действие необратимо.`)) return;
    await api('/api/purchases/' + id, { method: 'DELETE' });
    toast('Закупка удалена', 'ok');
    navigate('#/purchases');
  });

  const recvBtn = $('#btn-pu-receive', box);
  if (recvBtn) recvBtn.addEventListener('click', async () => {
    // перед приёмкой сохраняем правки и перечитываем закупку, чтобы диалог совпадал с карточкой
    try {
      if (headerEditable) await saveForm();
      const fresh = await api('/api/purchases/' + id);
      purchaseReceiveDialog(fresh, renderRoute);
    } catch (e) { toastErr(e); }
  });

  $('#btn-pu-print', box).addEventListener('click', async () => {
    // перед печатью сохраняем правки, чтобы бланк совпадал с карточкой
    try {
      if (editable && items.some((i) => !i.material_id || !(+i.qty > 0))
          && !await confirmDlg('Есть строки без материала или количества — они не попадут в бланк и будут убраны из закупки. Продолжить?', 'Продолжить')) return;
      if (headerEditable) await saveForm();
      const fresh = await api('/api/purchases/' + id);
      printPurchaseForm(fresh);
    } catch (e) { toastErr(e); }
  });
};

/* ================= КЛИЕНТЫ ================= */

function clientDialog(client) {
  const c = client || {};
  const m = openModal({
    title: client ? 'Клиент: ' + client.name : 'Новый клиент',
    body: `
      <form id="client-form" class="form-grid">
        <label class="fld span2"><span>Имя / название *</span><input name="name" type="text" value="${esc(c.name || '')}" required></label>
        <label class="fld"><span>Компания</span><input name="company" type="text" value="${esc(c.company || '')}"></label>
        <label class="fld"><span>Контактное лицо</span><input name="contact_person" type="text" value="${esc(c.contact_person || '')}"></label>
        <label class="fld"><span>Телефон</span><input name="phone" type="text" value="${esc(c.phone || '')}"></label>
        <label class="fld"><span>E-mail</span><input name="email" type="email" value="${esc(c.email || '')}"></label>
        <label class="fld span2"><span>Заметки</span><textarea name="notes" rows="3">${esc(c.notes || '')}</textarea></label>
      </form>`,
    footer: `<button class="btn" data-act="cancel">Отмена</button>
             <button class="btn btn-primary" data-act="save">${client ? 'Сохранить' : 'Добавить'}</button>`,
  });
  const form = $('#client-form', m.body);
  async function submit() {
    if (!form.reportValidity()) return;
    const f = new FormData(form);
    const body = Object.fromEntries(['name', 'company', 'contact_person', 'phone', 'email', 'notes'].map((k) => [k, f.get(k) || '']));
    try {
      if (client) await api('/api/clients/' + client.id, { method: 'PUT', body });
      else await api('/api/clients', { method: 'POST', body });
      m.close();
      toast(client ? 'Клиент сохранён' : 'Клиент добавлен', 'ok');
      await loadClients(true);
      renderRoute();
    } catch (e) { toastErr(e); }
  }
  $('[data-act="cancel"]', m.foot).onclick = m.close;
  $('[data-act="save"]', m.foot).onclick = submit;
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
}

views.clients = async function (box) {
  box.innerHTML = `
    <div class="page-head">
      <div class="toolbar">
        <input type="text" id="cl-q" placeholder="Поиск: имя, телефон, e-mail, компания…" style="width:290px">
      </div>
      <button class="btn btn-primary${can('orders.edit') ? '' : ' hidden'}" id="btn-new-client">+ Новый клиент</button>
    </div>
    <div id="clients-body"></div>`;

  const body = $('#clients-body', box);
  async function refresh(q) {
    const rows = await api('/api/clients' + (q ? '?q=' + encodeURIComponent(q) : ''));
    if (!q) state.clients = rows;
    if (!rows.length) { body.innerHTML = '<div class="panel empty-note">Клиентов не найдено</div>'; return; }
    body.innerHTML = `
      <div class="panel tbl-wrap">
        <table class="tbl">
          <thead><tr>
            <th>Имя</th><th>Компания</th><th>Контакт</th><th>Телефон</th><th>E-mail</th>
            <th class="num">Заказов</th>${can('money.price') ? '<th class="num">Сумма заказов</th>' : ''}
          </tr></thead>
          <tbody>
            ${rows.map((c) => `
              <tr class="clickable" data-id="${c.id}">
                <td><b>${esc(c.name)}</b></td>
                <td>${esc(c.company || '—')}</td>
                <td>${esc(c.contact_person || '—')}</td>
                <td class="mono">${esc(c.phone || '—')}</td>
                <td>${esc(c.email || '—')}</td>
                <td class="num">${c.orders_count}</td>
                ${can('money.price') ? `<td class="num">${c.orders_total ? fmtMoney(c.orders_total) : '—'}</td>` : ''}
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    $$('tr.clickable', body).forEach((tr) =>
      tr.addEventListener('click', () => navigate('#/clients/' + tr.dataset.id)));
  }
  $('#cl-q', box).addEventListener('input', debounce((e) => refresh(e.target.value.trim())));
  $('#btn-new-client', box).addEventListener('click', () => clientDialog());
  await refresh('');
};

views.client = async function (box, id) {
  await Promise.all([loadClients(), loadUsers(), loadSchema().catch(() => null)]);
  const client = (state.clients || []).find((c) => String(c.id) === String(id));
  if (!client) { box.innerHTML = '<div class="form-error">Клиент не найден</div>'; return; }
  const orders = await api('/api/orders?client_id=' + id);
  $('#page-title').textContent = 'Клиент: ' + client.name;

  box.innerHTML = `
    <div class="page-head">
      <h2>${esc(client.name)}</h2>
      <div class="toolbar">
        <button class="btn${can('orders.edit') ? '' : ' hidden'}" id="btn-edit-client">Редактировать</button>
        <button class="btn btn-primary${can('orders.edit') ? '' : ' hidden'}" id="btn-client-order">+ Новый заказ</button>
        ${client.orders_count === 0 && can('orders.edit') ? '<button class="btn btn-danger" id="btn-del-client">Удалить</button>' : ''}
      </div>
    </div>
    <div class="order-grid">
      <div>
        <div class="panel tbl-wrap">
          <table class="tbl">
            <thead><tr><th>№</th><th>Название</th><th>Статус</th>${can('money.price') ? '<th class="num">Сумма</th>' : ''}<th>Срок</th></tr></thead>
            <tbody>
              ${orders.length ? orders.map((o) => `
                <tr class="clickable" data-id="${o.id}">
                  <td class="mono">${esc(o.number)}</td>
                  <td><b>${esc(o.title || typeLabel(o.product_type))}</b></td>
                  <td>${statusBadge(o.status)}</td>
                  ${can('money.price') ? `<td class="num">${o.price ? fmtMoney(o.price) : '—'}</td>` : ''}
                  <td>${orderDueHTML(o.due_date)}</td>
                </tr>`).join('') : '<tr><td colspan="5" class="empty-note">Заказов ещё нет</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
      <div>
        <div class="panel panel-pad">
          <h3>Контакты</h3>
          <dl class="info-list">
            <dt>Компания</dt><dd>${esc(client.company || '—')}</dd>
            <dt>Контакт</dt><dd>${esc(client.contact_person || '—')}</dd>
            <dt>Телефон</dt><dd class="mono">${esc(client.phone || '—')}</dd>
            <dt>E-mail</dt><dd>${client.email ? `<a href="mailto:${esc(client.email)}">${esc(client.email)}</a>` : '—'}</dd>
            <dt>Заказов</dt><dd>${client.orders_count}${client.orders_total != null ? ' на ' + fmtMoney(client.orders_total) : ''}</dd>
            <dt>Добавлен</dt><dd>${fmtDate(client.created_at)}</dd>
          </dl>
          ${client.notes ? `<h3 style="margin-top:16px">Заметки</h3><div style="white-space:pre-wrap">${esc(client.notes)}</div>` : ''}
        </div>
      </div>
    </div>`;

  $$('tr.clickable', box).forEach((tr) =>
    tr.addEventListener('click', () => navigate('#/orders/' + tr.dataset.id)));
  $('#btn-edit-client', box).addEventListener('click', () => clientDialog(client));
  $('#btn-client-order', box).addEventListener('click', () => newOrderDialog({ client_id: client.id }));
  const del = $('#btn-del-client', box);
  if (del) del.addEventListener('click', async () => {
    if (!await confirmDlg(`Удалить клиента «${client.name}»?`)) return;
    try { await api('/api/clients/' + id, { method: 'DELETE' }); await loadClients(true); toast('Клиент удалён', 'ok'); navigate('#/clients'); }
    catch (e) { toastErr(e); }
  });
};

/* ================= ЗАДАЧИ ================= */

views.tasks = async function (box) {
  await loadUsers();
  const filters = { mine: true, open: true };

  box.innerHTML = `
    <div class="page-head">
      <div class="toolbar">
        <label class="check-fld"><input type="checkbox" id="t-mine" checked><span>Только мои</span></label>
        <label class="check-fld"><input type="checkbox" id="t-open" checked><span>Только открытые</span></label>
      </div>
      <button class="btn btn-primary" id="btn-new-task">+ Новая задача</button>
    </div>
    <div id="tasks-body"></div>`;

  const body = $('#tasks-body', box);

  async function refresh() {
    const p = new URLSearchParams();
    if (filters.mine) p.set('mine', '1');
    if (filters.open) p.set('open', '1');
    const tasks = await api('/api/tasks?' + p.toString());
    if (!tasks.length) { body.innerHTML = '<div class="panel empty-note">Задач нет — отличная работа!</div>'; return; }
    body.innerHTML = `
      <div class="panel tbl-wrap">
        <table class="tbl">
          <thead><tr><th></th><th>Задача</th><th>Заказ</th><th>Исполнитель</th><th>Срок</th><th></th></tr></thead>
          <tbody>
            ${tasks.map((t) => `
              <tr data-id="${t.id}" ${t.done ? 'style="opacity:.55"' : ''}>
                <td style="width:36px"><input type="checkbox" class="t-done" ${t.done ? 'checked' : ''}></td>
                <td ${t.done ? 'style="text-decoration:line-through"' : ''}>${esc(t.text)}</td>
                <td>${t.order_id ? `<a href="#/orders/${t.order_id}">№ ${esc(t.order_number || t.order_id)}</a> <span class="muted small">${esc(t.order_title || '')}</span>` : '<span class="muted">—</span>'}</td>
                <td>${esc(t.user_name || '—')}</td>
                <td class="${!t.done && isOverdue(t.due_date) ? 'overdue' : ''}">${t.due_date ? fmtDate(t.due_date) : '—'}</td>
                <td style="width:44px"><button class="btn btn-ghost btn-sm t-del" title="Удалить">✕</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    $$('tbody tr', body).forEach((tr) => {
      $('.t-done', tr).addEventListener('change', async (e) => {
        try { await api('/api/tasks/' + tr.dataset.id, { method: 'PUT', body: { done: e.target.checked } }); await refresh(); }
        catch (err) { toastErr(err); }
      });
      $('.t-del', tr).addEventListener('click', async () => {
        if (!await confirmDlg('Удалить задачу?')) return;
        try { await api('/api/tasks/' + tr.dataset.id, { method: 'DELETE' }); await refresh(); }
        catch (err) { toastErr(err); }
      });
    });
  }

  $('#t-mine', box).addEventListener('change', (e) => { filters.mine = e.target.checked; refresh(); });
  $('#t-open', box).addEventListener('change', (e) => { filters.open = e.target.checked; refresh(); });

  $('#btn-new-task', box).addEventListener('click', async () => {
    const orders = await api('/api/orders');
    const m = openModal({
      title: 'Новая задача',
      body: `
        <form id="task-form" style="display:flex;flex-direction:column;gap:13px">
          <label class="fld"><span>Текст задачи *</span><input name="text" type="text" required></label>
          <label class="fld"><span>Срок</span><input name="due_date" type="date"></label>
          <label class="fld"><span>Исполнитель</span><select name="user_id">${managerOptions(state.user.id)}</select></label>
          <label class="fld"><span>Заказ (необязательно)</span>
            <select name="order_id">
              <option value="">— без заказа —</option>
              ${orders.map((o) => `<option value="${o.id}">№ ${esc(o.number)} — ${esc(o.title || typeLabel(o.product_type))}</option>`).join('')}
            </select></label>
        </form>`,
      footer: `<button class="btn" data-act="cancel">Отмена</button>
               <button class="btn btn-primary" data-act="save">Добавить</button>`,
    });
    const form = $('#task-form', m.body);
    async function submit() {
      if (!form.reportValidity()) return;
      const f = new FormData(form);
      try {
        await api('/api/tasks', {
          method: 'POST',
          body: {
            text: f.get('text'), due_date: f.get('due_date') || '',
            user_id: Number(f.get('user_id')) || null, order_id: Number(f.get('order_id')) || null,
          },
        });
        m.close();
        await refresh();
      } catch (e) { toastErr(e); }
    }
    $('[data-act="cancel"]', m.foot).onclick = m.close;
    $('[data-act="save"]', m.foot).onclick = submit;
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  });

  await refresh();
};

/* ================= АНАЛИТИКА ================= */

function fmtCompact(n) {
  n = Number(n) || 0;
  if (Math.abs(n) >= 1e6) return _numFmt.format(Math.round(n / 1e5) / 10) + ' млн';
  if (Math.abs(n) >= 1e3) return _numFmt.format(Math.round(n / 100) / 10) + ' тыс.';
  return _numFmt.format(Math.round(n));
}

function revenueChartSVG(byMonth) {
  if (!byMonth.length) return '<div class="empty-note">Нет данных за период</div>';
  const W = 760, H = 280, padL = 70, padR = 16, padT = 24, padB = 40;
  const iw = W - padL - padR, ih = H - padT - padB;
  const max = Math.max(...byMonth.map((m) => m.revenue), 1);
  const step = iw / byMonth.length;
  const barW = Math.min(56, step * 0.62);
  const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    const y = padT + ih - (ih * i) / 4;
    grid += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>
             <text x="${padL - 8}" y="${y + 4}" text-anchor="end" font-size="10.5" fill="#9ca3af">${fmtCompact(v)}</text>`;
  }
  let bars = '';
  byMonth.forEach((m, i) => {
    const h = Math.max(2, (m.revenue / max) * ih);
    const x = padL + i * step + (step - barW) / 2;
    const y = padT + ih - h;
    const [yy, mm] = m.month.split('-');
    const lbl = `${MONTHS[Number(mm) - 1] || mm} ${yy.slice(2)}`;
    bars += `
      <rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="4" fill="#E31C79">
        <title>${lbl}: ${fmtMoney(m.revenue)} (${m.n} зак.)</title>
      </rect>
      <text x="${x + barW / 2}" y="${y - 6}" text-anchor="middle" font-size="10.5" fill="#4b5563">${fmtCompact(m.revenue)}</text>
      <text x="${x + barW / 2}" y="${H - padB + 16}" text-anchor="middle" font-size="11" fill="#6b7280">${lbl}</text>`;
  });
  return `<div class="chart-wrap"><svg class="chart-svg" viewBox="0 0 ${W} ${H}" style="min-width:560px">${grid}${bars}</svg></div>`;
}

views.analytics = async function (box) {
  await loadSchema().catch(() => null);
  const now = new Date();
  const y = now.getFullYear();
  let from = `${y}-01-01`, to = todayISO();

  box.innerHTML = `
    <div class="page-head">
      <div class="toolbar">
        <label class="fld"><span>С</span><input type="date" id="an-from" value="${from}" style="width:auto"></label>
        <label class="fld"><span>По</span><input type="date" id="an-to" value="${to}" style="width:auto"></label>
        <div class="view-toggle" style="align-self:flex-end">
          <button data-preset="month">Месяц</button>
          <button data-preset="quarter">Квартал</button>
          <button data-preset="year" class="active">Год</button>
        </div>
      </div>
    </div>
    <div id="an-body"></div>`;

  const body = $('#an-body', box);

  async function refresh() {
    from = $('#an-from', box).value;
    to = $('#an-to', box).value;
    const d = await api(`/api/analytics?from=${from}&to=${to}`);
    const margin = d.totals.revenue - d.totals.cost;
    const avg = d.totals.orders ? d.totals.revenue / d.totals.orders : 0;
    body.innerHTML = `
      <div class="stat-tiles">
        <div class="tile t-main"><div class="t-label">Выручка</div><div class="t-value">${fmtMoney(d.totals.revenue)}</div></div>
        <div class="tile"><div class="t-label">Маржа</div><div class="t-value">${fmtMoney(margin)}</div></div>
        <div class="tile"><div class="t-label">Заказов</div><div class="t-value">${fmtNum(d.totals.orders)}</div></div>
        <div class="tile"><div class="t-label">Средний чек</div><div class="t-value">${fmtMoney(avg)}</div></div>
      </div>
      <div class="panel panel-pad">
        <h3>Выручка по месяцам</h3>
        ${revenueChartSVG(d.byMonth)}
      </div>
      <div class="analytics-cols">
        <div class="panel tbl-wrap">
          <table class="tbl">
            <thead><tr><th>Менеджер</th><th class="num">Заказов</th><th class="num">Выручка</th><th class="num">Маржа</th></tr></thead>
            <tbody>
              ${d.byManager.length ? d.byManager.map((r) => `
                <tr><td>${esc(r.name || '—')}</td><td class="num">${r.n}</td>
                    <td class="num">${fmtMoney(r.revenue)}</td><td class="num">${fmtMoney(r.margin)}</td></tr>`).join('')
                : '<tr><td colspan="4" class="empty-note">Нет данных</td></tr>'}
            </tbody>
          </table>
        </div>
        <div class="panel tbl-wrap">
          <table class="tbl">
            <thead><tr><th>Вид продукции</th><th class="num">Заказов</th><th class="num">Выручка</th></tr></thead>
            <tbody>
              ${d.byType.length ? d.byType.map((r) => `
                <tr><td>${esc(typeLabel(r.product_type))}</td><td class="num">${r.n}</td>
                    <td class="num">${fmtMoney(r.revenue)}</td></tr>`).join('')
                : '<tr><td colspan="3" class="empty-note">Нет данных</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  function pad2(n) { return String(n).padStart(2, '0'); }
  $$('[data-preset]', box).forEach((b) => b.addEventListener('click', () => {
    $$('[data-preset]', box).forEach((x) => x.classList.toggle('active', x === b));
    const n = new Date();
    let f;
    if (b.dataset.preset === 'month') f = `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-01`;
    else if (b.dataset.preset === 'quarter') f = `${n.getFullYear()}-${pad2(Math.floor(n.getMonth() / 3) * 3 + 1)}-01`;
    else f = `${n.getFullYear()}-01-01`;
    $('#an-from', box).value = f;
    $('#an-to', box).value = todayISO();
    refresh();
  }));
  $('#an-from', box).addEventListener('change', refresh);
  $('#an-to', box).addEventListener('change', refresh);

  await refresh();
};

/* ================= НАСТРОЙКИ (админ) ================= */

views.settings = async function (box, arg, query) {
  // вкладки по правам: каждый видит только то, что ему можно настраивать
  const TABS = [['users', 'Пользователи', 'users'], ['positions', 'Должности и права', 'users'], ['audit', 'Журнал действий', 'audit'],
    ['pricing', 'Настройки калькуляции', 'pricing.setup'], ['ops', 'Доп. операции', 'pricing.setup'], ['calcs', 'Конструктор', 'pricing.setup'],
    ['production', 'Производство', 'prod.setup'], ['integrations', 'Интеграции', 'integrations']].filter((t) => can(t[2]));
  box.innerHTML = `
    <div class="tabs settings-tabs">${TABS.map(([k, l]) => `<button data-tab="${k}">${l}</button>`).join('')}</div>
    <div id="settings-body"></div>`;
  const body = $('#settings-body', box);
  const wanted = query && query.get('tab');
  let tab = TABS.some((t) => t[0] === wanted) ? wanted : (TABS[0] || [''])[0];
  $$('.settings-tabs button', box).forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));

  $$('.settings-tabs button', box).forEach((b) => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    $$('.settings-tabs button', box).forEach((x) => x.classList.toggle('active', x === b));
    render();
  }));

  // Справочник должностей с правками руководителя (встроенные шаблоны + свои)
  async function loadPositions() {
    try { return (await api('/api/positions')).positions; } catch { return Perms.catalog([]); }
  }
  const permLabel = (k) => (Perms.PERMS.find((x) => x.key === k) || {}).label || k;
  const permChips = (perms) => perms.map((k) => `<span class="perm-chip">${esc(permLabel(k))}</span>`).join('');

  async function userDialog(user) {
    const u = user || {};
    let floorAreas = [];
    try { floorAreas = (await api('/api/floor/areas')).areas.filter((a) => a.kind !== 'outsource'); } catch { /* нет справочника */ }
    const cat = await loadPositions();
    const myPos = new Set(u.positions || []);
    const myExtra = new Set(u.extra || []);
    const myAreas = new Set(u.areas || []);
    const m = openModal({
      title: user ? 'Пользователь: ' + user.name : 'Новый пользователь',
      wide: true,
      body: `
        <form id="user-form" class="ud">
          <div class="form-grid">
            ${user ? '' : '<label class="fld"><span>Логин *</span><input name="login" type="text" required autocomplete="off"></label>'}
            <label class="fld"><span>Имя *</span><input name="name" type="text" value="${esc(u.name || '')}" required></label>
          </div>
          ${u.legacy ? `<div class="info-box">Пользователь заведён до должностей: сейчас права по старой роли «${esc(roleLabel(u.role))}».
            Отметьте должности и сохраните.</div>` : ''}
          <div class="ud-sec">
            <div class="ud-h">Должности <span class="muted small">можно несколько: права складываются</span></div>
            ${Perms.POS_GROUPS.map((g) => `<div class="ud-grp"><div class="ud-gname">${esc(g.name)}</div><div class="ud-pos">
              ${cat.filter((pp) => pp.group === g.id).map((pp) => pp.module
                ? `<span class="ud-chip off" title="${esc(pp.module)}">${esc(pp.name)}<small>раздела пока нет</small></span>`
                : `<label class="ud-chip"><input type="checkbox" name="pos" value="${esc(pp.id)}" ${myPos.has(pp.id) ? 'checked' : ''}><span>${esc(pp.name)}</span></label>`).join('')}
            </div></div>`).join('')}
          </div>
          <div class="ud-sec">
            <div class="ud-h">Участки <span class="muted small">где действуют права цеха; не отмечено ни одного: все участки</span></div>
            <div class="ud-pos">${floorAreas.map((a) => `<label class="ud-chip"><input type="checkbox" name="area" value="${esc(a.id)}"
              ${myAreas.has(a.id) ? 'checked' : ''}><span>${esc(a.name)}</span></label>`).join('') || '<span class="muted">Справочник участков пуст</span>'}</div>
          </div>
          <details class="ud-sec" ${myExtra.size ? 'open' : ''}>
            <summary class="ud-h">Отдельные права сверху должности <span class="muted small">например, доступ к деньгам или складу</span></summary>
            ${Perms.GROUPS.map((g) => `<div class="ud-grp"><div class="ud-gname">${esc(g.name)}</div><div class="ud-perms">
              ${Perms.PERMS.filter((pp) => pp.group === g.id).map((pp) => `<label class="check-fld ud-perm" data-perm="${pp.key}">
                <input type="checkbox" name="extra" value="${pp.key}" ${myExtra.has(pp.key) ? 'checked' : ''}>
                <span>${esc(pp.label)}${pp.hint ? ` <span class="muted small">${esc(pp.hint)}</span>` : ''}<em class="ud-by"></em></span></label>`).join('')}
            </div></div>`).join('')}
          </details>
          <div class="ud-sum" id="ud-sum"></div>
          ${user ? `
            <label class="check-fld"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}><span>Активен (может входить в систему)</span></label>
            <label class="fld"><span>Новый пароль (оставьте пустым — без изменений)</span><input name="password" type="password" autocomplete="new-password"></label>`
          : '<label class="fld"><span>Пароль *</span><input name="password" type="password" required autocomplete="new-password"></label>'}
        </form>`,
      footer: `<button class="btn" data-act="cancel">Отмена</button>
               <button class="btn btn-primary" data-act="save">${user ? 'Сохранить' : 'Добавить'}</button>`,
    });
    const form = $('#user-form', m.body);
    const picked = (name) => $$(`input[name="${name}"]:checked`, form).map((c) => c.value);
    // итог: что сможет человек; права от должностей помечаются, отдельные галочки для них не нужны
    function sync() {
      const eff = Perms.effective({ positions: picked('pos'), extra_perms: [], areas: picked('area') }, cat);
      $$('.ud-perm', form).forEach((l) => {
        const byPos = eff.perms.includes(l.dataset.perm);
        const inp = $('input', l);
        inp.disabled = byPos;
        if (byPos) inp.checked = true;
        $('.ud-by', l).textContent = byPos ? ' есть по должности' : '';
      });
      const all = Perms.effective({ positions: picked('pos'), extra_perms: picked('extra'), areas: picked('area') }, cat);
      const areaNames = picked('area').map((id) => (floorAreas.find((a) => a.id === id) || {}).name || id);
      const usesAreas = all.perms.some((k) => Perms.AREA_KEYS.has(k));
      $('#ud-sum', form).innerHTML = all.perms.length
        ? `<div class="ud-h">Итого сможет</div><div>${permChips(all.perms)}</div>
           ${usesAreas ? `<div class="muted small" style="margin-top:6px">Цех: ${areaNames.length ? esc(areaNames.join(', ')) : 'все участки'}</div>` : ''}`
        : '<div class="muted">Пока никаких прав: отметьте должность</div>';
    }
    form.addEventListener('change', (e) => {
      // при выборе должности сами отмечаются её участки
      if (e.target.name === 'pos' && e.target.checked) {
        const pp = cat.find((x) => x.id === e.target.value);
        for (const a of (pp && pp.areas) || []) { const c = $(`input[name="area"][value="${a}"]`, form); if (c) c.checked = true; }
      }
      sync();
    });
    sync();
    async function submit() {
      if (!form.reportValidity()) return;
      const f = new FormData(form);
      const eff = Perms.effective({ positions: picked('pos'), extra_perms: [], areas: [] }, cat);
      const positions = picked('pos');
      const extra = picked('extra').filter((k) => !eff.perms.includes(k));
      const areas = picked('area');
      if (!positions.length && !extra.length) { toast('Отметьте должность или права', 'error'); return; }
      try {
        if (user) {
          await api('/api/users/' + user.id, {
            method: 'PUT',
            body: { name: f.get('name'), positions, extra, areas, active: !!f.get('active'), password: f.get('password') || undefined },
          });
        } else {
          await api('/api/users', {
            method: 'POST',
            body: { login: f.get('login'), name: f.get('name'), positions, extra, areas, password: f.get('password') },
          });
        }
        m.close();
        await loadUsers(true);
        render();
        toast('Сохранено', 'ok');
      } catch (e) { toastErr(e); }
    }
    $('[data-act="cancel"]', m.foot).onclick = m.close;
    $('[data-act="save"]', m.foot).onclick = submit;
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  }

  async function renderUsers() {
    const users = await loadUsers(true);
    let areas = [];
    try { areas = (await api('/api/floor/areas')).areas; } catch { /* нет справочника */ }
    const areaName = (id) => (areas.find((a) => a.id === id) || {}).name || id;
    body.innerHTML = `
      <div class="page-head">
        <h2>Пользователи системы</h2>
        <button class="btn btn-primary" id="btn-new-user">+ Добавить пользователя</button>
      </div>
      <div class="panel tbl-wrap">
        <table class="tbl">
          <thead><tr><th>Имя</th><th>Логин</th><th>Должности</th><th>Участки</th><th>Статус</th><th></th></tr></thead>
          <tbody>
            ${users.map((u) => `
              <tr data-id="${u.id}" ${u.active ? '' : 'style="opacity:.55"'}>
                <td><b>${esc(u.name)}</b></td>
                <td class="mono">${esc(u.login)}</td>
                <td>${u.legacy ? `<span class="muted">по старой роли:</span> ${esc(roleLabel(u.role))}` : esc(u.title || '—')}
                  ${u.extra && u.extra.length ? `<div class="muted small">отдельно: ${esc(u.extra.map(permLabel).join(', '))}</div>` : ''}</td>
                <td class="small">${u.areas && u.areas.length ? esc(u.areas.map(areaName).join(', ')) : '<span class="muted">все</span>'}</td>
                <td>${u.active ? '<span class="badge st-ready">Активен</span>' : '<span class="badge st-cancelled">Отключён</span>'}</td>
                <td style="width:120px"><button class="btn btn-sm u-edit">Изменить</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="muted small" style="margin-top:10px">Права даются должностями (Настройки → «Должности и права»), одному человеку можно
        несколько. Участки ограничивают права цеха: сотрудник видит и отмечает задания только своих участков.</div>`;
    $('#btn-new-user', body).addEventListener('click', () => userDialog());
    $$('tbody tr', body).forEach((tr) => {
      $('.u-edit', tr).addEventListener('click', () =>
        userDialog(users.find((u) => String(u.id) === tr.dataset.id)));
    });
  }

  /* --- должности: шаблоны прав по документу типографии, свои должности --- */
  async function renderPositions() {
    const [cat, users] = await Promise.all([loadPositions(), loadUsers(true)]);
    let areas = [];
    try { areas = (await api('/api/floor/areas')).areas.filter((a) => a.kind !== 'outsource'); } catch { /* нет справочника */ }
    const areaName = (id) => (areas.find((a) => a.id === id) || {}).name || id;
    const who = (id) => users.filter((u) => (u.positions || []).includes(id) && u.active).map((u) => u.name);
    const ready = cat.filter((x) => !x.module).length;
    body.innerHTML = `
      <div class="page-head">
        <h2>Должности и права</h2>
        <button class="btn btn-primary" id="pos-new">+ Своя должность</button>
      </div>
      <p class="muted small prod-intro">Шаблоны по документу «Роли и права ERP типографии Радуга». Права в шаблоне можно поменять:
        изменения сразу действуют у всех, у кого эта должность. Одному человеку можно дать несколько должностей, права складываются.
        Готово к работе: <b>${ready} из ${cat.length}</b>. Остальные появятся вместе со своими разделами.</p>
      ${Perms.POS_GROUPS.map((g) => {
        const list = cat.filter((x) => x.group === g.id);
        if (!list.length) return '';
        return `<h3 class="pos-gh">${esc(g.name)}</h3><div class="pos-grid">${list.map((x) => {
          const names = who(x.id);
          return `<div class="pos-card${x.module ? ' pos-off' : ''}" data-id="${esc(x.id)}">
            <div class="pos-name">${esc(x.name)}${x.custom ? ' <span class="badge st-approval">своя</span>' : ''}${x.edited ? ' <span class="badge st-calc">изменена</span>' : ''}</div>
            ${x.module ? `<div class="pos-mod">Появится с разделом: ${esc(x.module)}</div>`
              : `<div class="pos-perms">${x.perms.length === Perms.KEYS.length ? '<span class="perm-chip perm-all">Все права системы</span>'
                : permChips(x.perms) || '<span class="muted small">прав нет</span>'}</div>
                 ${x.areas && x.areas.length ? `<div class="muted small">Участки: ${esc(x.areas.map(areaName).join(', '))}</div>` : ''}
                 ${x.note ? `<div class="muted small">${esc(x.note)}</div>` : ''}
                 <div class="pos-foot"><span class="small ${names.length ? '' : 'muted'}">${names.length ? esc(names.join(', ')) : 'пока никого'}</span>
                   <button class="btn btn-sm pos-edit">Изменить</button></div>`}
          </div>`;
        }).join('')}</div>`;
      }).join('')}`;

    async function save(next) {
      const r = await api('/api/positions', { method: 'PUT', body: { positions: next.filter((x) => !x.module) } });
      toast('Должности сохранены: права уже действуют', 'ok');
      return r;
    }
    function editDialog(pos) {
      const x = pos || { id: '', name: '', group: 'shop', perms: [], areas: [], custom: true };
      const m = openModal({
        title: pos ? 'Должность: ' + pos.name : 'Новая должность',
        wide: true,
        body: `<form id="pos-form" class="ud">
          ${x.custom ? `<div class="form-grid">
            <label class="fld"><span>Название *</span><input name="name" type="text" value="${esc(x.name)}" required></label>
            <label class="fld"><span>Раздел</span><select name="group">${Perms.POS_GROUPS.map((g) =>
              `<option value="${g.id}" ${g.id === x.group ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label></div>` : ''}
          ${Perms.GROUPS.map((g) => `<div class="ud-grp"><div class="ud-gname">${esc(g.name)}</div><div class="ud-perms">
            ${Perms.PERMS.filter((pp) => pp.group === g.id).map((pp) => `<label class="check-fld">
              <input type="checkbox" name="perm" value="${pp.key}" ${x.perms.includes(pp.key) ? 'checked' : ''}
                ${x.id === 'ceo' && pp.key === 'users' ? 'disabled title="У генерального директора это право остаётся всегда"' : ''}>
              <span>${esc(pp.label)}${pp.hint ? ` <span class="muted small">${esc(pp.hint)}</span>` : ''}${pp.area ? ' <span class="badge-approx">по участкам</span>' : ''}</span></label>`).join('')}
          </div></div>`).join('')}
          <div class="ud-sec"><div class="ud-h">Участки по умолчанию <span class="muted small">отмечаются сами, когда человеку дают эту должность</span></div>
            <div class="ud-pos">${areas.map((a) => `<label class="ud-chip"><input type="checkbox" name="area" value="${esc(a.id)}"
              ${(x.areas || []).includes(a.id) ? 'checked' : ''}><span>${esc(a.name)}</span></label>`).join('')}</div></div>
        </form>`,
        footer: `${pos && pos.custom ? '<button class="btn btn-danger" data-act="del" style="margin-right:auto">Удалить должность</button>' : ''}
          <button class="btn" data-act="cancel">Отмена</button><button class="btn btn-primary" data-act="save">Сохранить</button>`,
      });
      const form = $('#pos-form', m.body);
      $('[data-act="cancel"]', m.foot).onclick = m.close;
      const del = $('[data-act="del"]', m.foot);
      if (del) del.onclick = async () => {
        const names = who(x.id);
        if (!await confirmDlg(`Удалить должность «${x.name}»?${names.length ? ' Она есть у: ' + names.join(', ') + '. Эти права у них пропадут.' : ''}`)) return;
        try { await save(cat.filter((y) => y.id !== x.id)); m.close(); renderPositions(); } catch (e) { toastErr(e); }
      };
      $('[data-act="save"]', m.foot).onclick = async () => {
        if (!form.reportValidity()) return;
        const perms = $$('input[name="perm"]:checked', form).map((c) => c.value);
        if (x.id === 'ceo' && !perms.includes('users')) perms.push('users');
        const upd = { ...x, perms, areas: $$('input[name="area"]:checked', form).map((c) => c.value) };
        if (x.custom) { upd.name = form.elements.name.value.trim(); upd.group = form.elements.group.value; }
        const next = pos ? cat.map((y) => (y.id === x.id ? upd : y)) : [...cat, upd];
        try { await save(next); m.close(); renderPositions(); } catch (e) { toastErr(e); }
      };
    }
    $('#pos-new', body).addEventListener('click', () => editDialog(null));
    $$('.pos-edit', body).forEach((b) => b.addEventListener('click', () => {
      editDialog(cat.find((x) => x.id === b.closest('.pos-card').dataset.id));
    }));
  }

  /* --- журнал действий: кто что менял --- */
  async function renderAudit() {
    const users = await loadUsers(true);
    const d0 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    body.innerHTML = `
      <div class="page-head"><h2>Журнал действий</h2></div>
      <p class="muted small prod-intro">Права и пользователи, утверждённые цены, передача заказов, исправления отметок цеха, решения ОТК.
        Записи не удаляются и не правятся.</p>
      <div class="toolbar" style="margin-bottom:12px">
        <label class="small">с <input type="date" id="au-from" value="${d0}"></label>
        <label class="small">по <input type="date" id="au-to" value="${todayISO()}"></label>
        <select id="au-user"><option value="">Все пользователи</option>${users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select>
      </div>
      <div id="au-out"></div>`;
    const out = $('#au-out', body);
    async function load() {
      const qs = new URLSearchParams();
      if ($('#au-from', body).value) qs.set('from', $('#au-from', body).value);
      if ($('#au-to', body).value) qs.set('to', $('#au-to', body).value);
      if ($('#au-user', body).value) qs.set('user_id', $('#au-user', body).value);
      const rows = await api('/api/audit?' + qs);
      out.innerHTML = rows.length ? `<div class="panel tbl-wrap"><table class="tbl">
        <thead><tr><th>Когда</th><th>Кто</th><th>Действие</th><th>Подробно</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td style="white-space:nowrap">${fmtDateTime(r.created_at)}</td><td>${esc(r.user_name || '—')}</td>
          <td><b>${esc(r.action)}</b></td><td class="small">${esc(r.details)}</td></tr>`).join('')}</tbody></table></div>`
        : '<div class="panel empty-note">За этот период действий нет</div>';
    }
    $$('#au-from, #au-to, #au-user', body).forEach((el) => el.addEventListener('change', () => load().catch(toastErr)));
    await load();
  }


  /* Русские подписи для технических ключей конфигурации */
  const CFG_RU = {
    currency: 'Курс у.е., руб.', materials: 'на материалы', works: 'на работы',
    blockPapers: 'Бумага блока и вклейки', coverPapers: 'Бумага обложек (брошюры)',
    a2: 'Цена А2, у.е.', a3: 'Цена А3, у.е.', a1: 'Цена А1, у.е.', thickness: 'Толщина листа, мм',
    bindingMaterials: 'Переплётные материалы', price: 'Цена, у.е.', unit: 'Единица',
    binderBoard: 'Переплётный картон (по толщине, мм)',
    print: 'Печать', plate: 'Форма офсетная, у.е.', setupA2: 'Приладка на форму А2',
    setupA3: 'Приладка на форму А3', setupPerInk: 'Приладка на краску, листов',
    clickA2PerInk: 'Клик А2 за краску', clickBwA3: 'Клик ч/б А3', clickA3PerInk: 'Клик А3 за краску',
    pantone: 'Пантон, у.е.', offset: 'офсет', digital: 'цифра', inkjet: 'струйная',
    postpress: 'Постпечать', laminationSetup: 'Ламинация: приладка',
    laminationGlossSide: 'Ламинация: Г-сторона', laminationMatteSide: 'Ламинация: М-сторона',
    cutSetup: 'Резка: приладка', cutStrike: 'Резка: удар', foldSetup: 'Фальцовка: приладка',
    foldPerFold: 'Фальцовка: фальц', creaseSetup: 'Биговка: приладка', creasePerCrease: 'Биговка: биг',
    perforationSetup: 'Перфорация: приладка', perforationStrike: 'Перфорация: удар',
    lacquerSetup: 'Лак: приладка', lacquerPerSheet: 'Лак: покрытие, за лист',
    binding: 'Переплёт и брошюровка', collateSetup: 'Подборка: приладка',
    collateDifferent1000A3: 'Подборка разных, за 1000 л. А3', collateSame1000A3: 'Подборка одинаковых, за 1000 л. А3',
    saddleSetup: 'Скоба: приладка', saddlePer100Staples: 'Скоба: за 100 скоб',
    kbsSetup: 'КБС: приладка', kbsPerCopy: 'КБС: за экз.',
    sewSetup: 'Шитьё нитками: приладка', sewPerCopy: 'Шитьё: за экз.',
    blockProcessSetup: 'Обработка блока: приладка', blockProcessPerCopy: 'Обработка блока: за экз.',
    caseMakeSetup: 'Изготовление крышки: приладка', caseMakePerCopy: 'Крышка: за экз.',
    insertSetup: 'Вставка блока: приладка', insertPerCopy: 'Вставка: за экз.',
    stampingSetup: 'Тиснение: приладка', stampingStrike: 'Тиснение: удар', stampingDie: 'Штамп для тиснения',
    dieCutSetup: 'Вырубка: приладка', dieCutStrike: 'Вырубка: удар', dieCutDie: 'Штамп для вырубки',
    boxCutSetup: 'Резка коробочная: приладка', boxCutStrike: 'Резка коробочная: удар',
    wireSetup: 'Пружина: приладка', wirePerSheet: 'Пружина: укладка, за лист',
    wireSpoolPrice: 'Цена катушки пружины, у.е.', wireSpoolUseFactor: 'Коэф. использования катушки',
    reserves: 'Запасы и брак', bindingWasteFactor: 'Резерв перепл. материалов (доля)',
    bindingWasteCopies: 'Запас на брак, экз.', stampingWasteCopies: 'Запас при тиснении, экз.',
    gluePadVertical: 'Поле заклейки по вертикали, мм', gluePadHorizontal: 'Поле заклейки по горизонтали, мм',
    bookFormats: 'Форматы книг и брошюр', w: 'Ширина, мм', h: 'Высота, мм',
    sheetName: 'Типографский формат', perA3: 'Долей на листе А3', formatK: 'Коэф. формата',
    hooksShort: 'Крючков: короткая сторона', hooksLong: 'Крючков: длинная сторона',
    p31: 'шаг 3:1', p21: 'шаг 2:1',
    factors: 'Технологические коэффициенты',
    offsetPaperWasteBooks: 'Отход бумаги, офсет (книги/брошюры)',
    offsetPaperWasteSheets: 'Отход бумаги, офсет (листовая/блокноты)',
    digitalPaperWaste: 'Отход бумаги, цифра/струя', digitalPrintMarkup: 'Надбавка цифровой печати',
    setupSheetsPerInk: 'Приладка на краску, листов',
    bookBindingCeilRubPerCopy: 'Потолок переплёта (цифра), руб./экз.',
    brochurePostpressCeilRubPerCopy: 'Потолок постпечати брошюры (цифра), руб./экз.',
    bookCase: 'Геометрия переплётной крышки', boardSheet: 'Лист картона, мм', efalinSheet: 'Лист эфалина, мм',
    balacronRollWidth: 'Ширина рулона балакрона, мм', leatherRollWidth: 'Ширина рулона иск. кожи, мм',
    boardA1Price: 'Картон, у.е. за лист А1+', sideTrim: 'Сторонка: минус от ширины, мм',
    sideExtra: 'Сторонка: плюс к высоте, мм', spineExtra: 'Корешок: плюс к толщине, мм',
    spineGap: 'Шпация (отступ), мм', wrapMargin: 'Поле на загиб, мм',
    balacronK: 'Ширина балакрона, м', leatherK: 'Ширина иск. кожи, м', layoutWaste: 'Запас материала (×)',
    sheetFormats: 'Форматы листовой продукции', area: 'Площадь листа, м²', machines: 'Машины',
    press: 'Печатная машина (a3/a2)', kDigital: 'Коэф. цифровой печати', kLam: 'Коэф. ламинации',
    sheetPapers: 'Бумага листовой продукции', perKg: 'Цена за 1 кг, у.е.', fixed: 'Плёнки/самоклейка, за лист',
    notebooks: 'Блокноты', formats: 'Форматы', papers: 'Бумага',
    springSpoolPrice: 'Цена катушки, у.е.', hooksPerSide: 'Крючков на сторону (по длине, мм)',
    springs: 'Каталог пружин', name: 'Название', pitch: 'Шаг', hooks: 'Крючков в катушке',
    maxBlock: 'Макс. блок, мм', coilGap: 'Зазор обложек, мм', coilTolerance: 'Допуск подбора',
    uv: 'УФ-печать', groups: 'Группы сложности (цена стола, руб.)', colorFactors: 'Коэф. красочности',
    minBatch: 'Мин. партия, шт.', minBatchPerItem: 'Цена за шт. в мин. партии, руб.',
    setup: 'Приладка, руб.', layoutPerItem: 'Выкладка, руб./шт.', packPerItem: 'Упаковка, руб./шт.',
    plotter: 'Плоттерная резка', printedArea: 'Поле: запечатанный, мм', blankArea: 'Поле: без печати, мм',
    pass: 'Прогон, руб.', knifePrice: 'Нож: цена, руб.', knifeLife: 'Нож: ресурс, м',
    cleanPerA3: 'Чистка облоя, руб./лист', size: 'Размер листа',
    discounts: 'Скидки и наценки (коэффициент к работам)',
  };
  const cfgLabel = (k) => CFG_RU[k] || k;

  /* --- подсказки «?»: словарь CFG_HINTS в public/hints.js --- */
  const HINTS = window.CFG_HINTS || {};

  // Путь в конфиге → ключ словаря подсказок: точное совпадение либо
  // версия с * на месте одного из сегментов (элементы словарей: blockPapers.*.a3)
  function resolveHint(path) {
    const cand = [path.join('.')];
    for (let i = 1; i < path.length; i++) cand.push(path.map((s, j) => (j === i ? '*' : s)).join('.'));
    for (const c of cand) if (HINTS[c]) return c;
    return null;
  }

  function hintBtn(path) {
    const key = resolveHint(path);
    return key ? `<button type="button" class="hint-btn" data-hint="${esc(key)}" title="Что это и на что влияет">?</button>` : '';
  }

  function openHint(btn) {
    const h = HINTS[btn.dataset.hint];
    if (!h) return;
    const cell = btn.closest('td, h4');
    openModal({
      title: cell ? cell.textContent.replace(/\?\s*$/, '').trim() : 'Подсказка',
      body: `<div class="hint-body">
        ${h.d ? `<p>${esc(h.d)}</p>` : ''}
        ${h.x ? `<p class="hint-src"><b>Откуда взято:</b> ${esc(h.x)}</p>` : ''}
        ${h.a ? `<p class="hint-src"><b>На что влияет:</b> ${esc(h.a)}</p>` : ''}
      </div>`,
    });
  }

  /* --- рекурсивный редактор справочников --- */
  const isObj = (v) => v !== null && typeof v === 'object';

  function cfgInput(value, path) {
    const p = esc(JSON.stringify(path));
    if (typeof value === 'number') return `<input type="number" step="any" value="${value}" data-path="${p}" data-type="number">`;
    if (typeof value === 'boolean') return `<input type="checkbox" ${value ? 'checked' : ''} data-path="${p}" data-type="boolean">`;
    if (Array.isArray(value)) return `<input type="text" value="${esc(value.join(', '))}" data-path="${p}" data-type="strlist" title="значения через запятую">`;
    return `<input type="text" value="${esc(value)}" data-path="${p}" data-type="string">`;
  }

  const isStrArray = (v) => Array.isArray(v) && v.every((x) => typeof x !== 'object');
  const isFlat = (v) => Object.values(v).every((x) => !isObj(x) || isStrArray(x));

  // Подпись строки в матрице: для массивов (каталог пружин) — имя элемента или номер
  function rowLabel(obj, k, v) {
    if (Array.isArray(obj)) return (v && typeof v.name === 'string' && v.name) || '№ ' + (Number(k) + 1);
    return cfgLabel(k);
  }

  function cfgRender(obj, path, level) {
    const prims = [], objs = [];
    for (const [k, v] of Object.entries(obj)) ((isObj(v) && !isStrArray(v)) ? objs : prims).push([k, v]);

    let html = '';
    if (prims.length) {
      html += `<table class="cfg-table">${prims.map(([k, v]) =>
        `<tr><td class="k">${esc(cfgLabel(k))} ${hintBtn(path.concat(k))}</td><td>${cfgInput(v, path.concat(k))}</td></tr>`).join('')}</table>`;
    }

    const flatObjs = objs.filter(([, v]) => isFlat(v));
    const deepObjs = objs.filter(([, v]) => !isFlat(v));

    // Матрица (строки-ключи × колонки-поля) — только когда колонки у всех строк ОДИНАКОВЫЕ:
    // бумага (a2/a3/толщина), операции (офсет/цифра), каталог пружин и т.п.
    const refKeys = flatObjs.length > 1 ? JSON.stringify(Object.keys(flatObjs[0][1])) : null;
    const uniform = refKeys && flatObjs.every(([, v]) => JSON.stringify(Object.keys(v)) === refKeys) && !deepObjs.length;

    if (uniform) {
      const cols = Object.keys(flatObjs[0][1]);
      html += `<table class="cfg-table">
        <tr><td class="k"></td>${cols.map((c) => `<td class="k">${esc(cfgLabel(c))} ${hintBtn(path.concat('*', c))}</td>`).join('')}</tr>
        ${flatObjs.map(([k, v]) => `<tr><td class="k">${esc(rowLabel(obj, k, v))}</td>${cols.map((c) =>
          `<td>${c in v ? cfgInput(v[c], path.concat(k, c)) : ''}</td>`).join('')}</tr>`).join('')}
      </table>`;
    } else if (flatObjs.length) {
      // Разнородные плоские блоки — компактной строкой: подпись + пары «колонка: значение»
      html += `<table class="cfg-table">${flatObjs.map(([k, v]) => `
        <tr><td class="k">${esc(cfgLabel(k))} ${hintBtn(path.concat(k))}</td>
          <td class="pairs">${Object.entries(v).map(([ck, cv]) =>
            `<span class="pair"><span class="pl">${esc(cfgLabel(ck))}</span>${cfgInput(cv, path.concat(k, ck))}</span>`).join('')}</td></tr>`).join('')}
      </table>`;
    }

    for (const [k, v] of deepObjs) {
      html += `<div class="cfg-sub"><h4 style="font-size:12.5px;margin-bottom:6px">${esc(rowLabel(obj, k, v))} ${hintBtn(path.concat(k))}</h4>${cfgRender(v, path.concat(k), level + 1)}</div>`;
    }
    return html;
  }

  /* Вкладки настроек калькуляции: структура повторяет знакомый Excel */
  const PRICING_TABS = [
    { key: 'general', label: 'Общие: курсы и скидки', keys: ['currency', 'discounts'],
      note: 'Главные ручки цены: два курса у.е. и шкала скидки k. Скидка действует только на работы, материалы всегда по полной цене. В Excel: жёлтые ячейки Данные!B4 и C4, таблица k из «Наборов».' },
    { key: 'paper', label: 'Бумага и материалы', keys: ['blockPapers', 'coverPapers', 'bindingMaterials', 'binderBoard', 'sheetPapers'],
      note: 'Цены бумаги и переплётных материалов в у.е. за лист и толщины листа. В Excel: левая часть листа «Данные». В отличие от Excel здесь цена правится в одном месте и сразу действует во всех калькуляторах.' },
    { key: 'operations', label: 'Операции: печать и переплёт', keys: ['print', 'postpress', 'binding'],
      note: 'Расценки операций в у.е., отдельно для офсета и цифры, как две колонки зоны «Операция» листа «Данные».' },
    { key: 'books', label: 'Книги №7', keys: ['bookFormats', 'bookCase', 'reserves', 'factors'],
      note: 'Форматы книг, геометрия переплётной крышки, запасы и технологические нормы. Часть этих чисел в Excel была зашита внутри формул, здесь они вынесены в настройки и правятся без программиста.' },
    { key: 'sheets', label: 'Листовая', keys: ['sheetFormats'],
      note: 'Форматы листовой продукции: площадь листа, какая машина печатает (офсет/цифра) и коэффициенты формата.' },
    { key: 'notebooks', label: 'Блокноты', keys: ['notebooks'],
      note: 'Бумага блокнотов, форматы, крючки по сторонам и каталог пружин Wire-O.' },
    { key: 'uv', label: 'УФ печать', keys: ['uv'],
      note: 'Группы сложности (цена стола), коэффициенты красочности и тарифы. В Excel: зона УФ листа «Данные».' },
    { key: 'plotter', label: 'Плоттер', keys: ['plotter'],
      note: 'Рабочее поле, тарифы резки и чистки, нож и материалы плоттера.' },
  ];

  async function renderPricing() {
    const cfg = await api('/api/pricing/config');
    const covered = new Set(PRICING_TABS.flatMap((t) => t.keys));
    const rest = Object.keys(cfg).filter((k) => !covered.has(k));
    const tabsList = rest.length ? [...PRICING_TABS, { key: 'other', label: 'Прочее', keys: rest, note: '' }] : PRICING_TABS;
    const draft = structuredClone(cfg);
    let sub = tabsList[0].key;

    body.innerHTML = `
      <div class="page-head">
        <h2>Настройки калькуляции</h2>
        <div class="toolbar">
          <button class="btn btn-danger" id="btn-cfg-reset">Сбросить к исходным из Excel</button>
          <button class="btn btn-primary" id="btn-cfg-save">Сохранить</button>
        </div>
      </div>
      <div class="tabs cfg-subtabs" id="cfg-subtabs">
        ${tabsList.map((t) => `<button data-sub="${t.key}">${esc(t.label)}</button>`).join('')}
      </div>
      <div class="panel panel-pad" id="cfg-root"></div>`;

    const root = $('#cfg-root', body);

    // Считываем правки текущей подвкладки в draft (правки живут при переключении подвкладок)
    function harvest() {
      let bad = null;
      $$('[data-path]', root).forEach((inp) => {
        const path = JSON.parse(inp.dataset.path);
        let val;
        if (inp.dataset.type === 'number') {
          val = parseFloat(String(inp.value).replace(',', '.'));
          if (!isFinite(val)) { bad = path.join(' → '); return; }
        } else if (inp.dataset.type === 'boolean') val = inp.checked;
        else if (inp.dataset.type === 'strlist') val = inp.value.split(',').map((s) => s.trim()).filter(Boolean);
        else val = inp.value;
        let t = draft;
        for (let i = 0; i < path.length - 1; i++) t = t[path[i]];
        t[path[path.length - 1]] = val;
      });
      return bad;
    }

    // Материалы со склада: строка справочника → имя материала
    function materialRowInfo(path) {
      if (['blockPapers', 'coverPapers', 'bindingMaterials'].includes(path[0]) && path.length >= 3) return { name: path[1] };
      if (path[0] === 'plotter' && path[1] === 'materials' && path.length >= 4) return { name: path[2] };
      if (path[0] === 'notebooks' && path[1] === 'papers' && path.length >= 4) return { name: path[2] };
      if (path[0] === 'sheetPapers' && path[1] === 'fixed' && path.length === 3) return { name: path[2] };
      return null;
    }

    let stockRows = null;
    async function loadStockOnce() {
      if (!stockRows) stockRows = await api('/api/stock').catch(() => []);
      return stockRows;
    }

    // Бейджи «настроить» и подсказка цены из последней закупки
    async function annotateMaterials() {
      const stock = await loadStockOnce();
      $$('#cfg-root tr', body).forEach((tr) => {
        const inputs = $$('[data-path]', tr);
        if (!inputs.length) return;
        const info = materialRowInfo(JSON.parse(inputs[0].dataset.path));
        if (!info) return;
        const nums = inputs.filter((i) => i.dataset.type === 'number');
        const priceInputs = nums.filter((i) => {
          const p = JSON.parse(i.dataset.path);
          return ['a2', 'a3', 'price'].includes(p[p.length - 1]) || (p[0] === 'sheetPapers' && p[1] === 'fixed');
        });
        const allZero = priceInputs.length > 0 &&
          priceInputs.every((i) => !(parseFloat(String(i.value).replace(',', '.')) > 0));
        const labelTd = tr.querySelector('td.k');
        if (labelTd && allZero && !labelTd.querySelector('.chip-new')) {
          labelTd.insertAdjacentHTML('beforeend', ' <span class="chip-new">новое — настроить</span>');
        }
        const sm = stock.find((s) => s.name === info.name && s.last_price > 0);
        if (sm && priceInputs[0] && !tr.querySelector('.chip-buy')) {
          priceInputs[0].closest('td').insertAdjacentHTML('beforeend',
            ` <button type="button" class="chip-buy" data-rub="${sm.last_price}"
               title="Последняя закупка: ${fmtMoney(sm.last_price)} за ${esc(sm.unit)}. Нажмите, чтобы подставить цену в у.е. по курсу материалов">закупка ${fmtMoney(sm.last_price)} →</button>`);
        }
      });
    }

    // Счётчики «не настроено» на подвкладках
    function tabBadges() {
      const zero = (dict, f) => Object.values(dict || {}).filter((v) => !(f(v) > 0)).length;
      const counts = {
        paper: zero(draft.blockPapers, (v) => (v.a2 || 0) + (v.a3 || 0))
          + zero(draft.coverPapers, (v) => v.a3 || 0)
          + zero(draft.bindingMaterials, (v) => v.price || 0)
          + zero(draft.sheetPapers && draft.sheetPapers.fixed, (v) => Number(v) || 0),
        plotter: zero(draft.plotter && draft.plotter.materials, (v) => v.price || 0),
        notebooks: zero(draft.notebooks && draft.notebooks.papers, (v) => v.a3 || 0),
      };
      $$('#cfg-subtabs button', body).forEach((b) => {
        const n = counts[b.dataset.sub] || 0;
        let chip = b.querySelector('.tab-badge');
        if (n) {
          if (!chip) { chip = document.createElement('span'); chip.className = 'tab-badge'; b.appendChild(chip); }
          chip.textContent = n;
          chip.title = 'Материалов без цен: ' + n;
        } else if (chip) chip.remove();
      });
    }

    function renderSub() {
      const t = tabsList.find((x) => x.key === sub);
      $$('#cfg-subtabs button', body).forEach((b) => b.classList.toggle('active', b.dataset.sub === sub));
      root.innerHTML = `
        ${t.note ? `<p class="muted small cfg-note">${esc(t.note)}</p>` : ''}
        ${t.keys.filter((k) => k in draft).map((k) => `
          <div class="cfg-section">
            <h4>${esc(cfgLabel(k))} ${hintBtn([k])}</h4>
            ${isObj(draft[k]) ? cfgRender(draft[k], [k], 0) : `<table class="cfg-table"><tr><td class="k">${esc(cfgLabel(k))} ${hintBtn([k])}</td><td>${cfgInput(draft[k], [k])}</td></tr></table>`}
          </div>`).join('')}`;
      tabBadges();
      annotateMaterials().catch(() => {});
    }

    $$('#cfg-subtabs button', body).forEach((b) => b.addEventListener('click', () => {
      const bad = harvest();
      if (bad) { toast('Некорректное число: ' + bad, 'error'); return; }
      sub = b.dataset.sub;
      renderSub();
    }));

    root.addEventListener('click', (e) => {
      const btn = e.target.closest('.hint-btn');
      if (btn) { openHint(btn); return; }
      const buy = e.target.closest('.chip-buy');
      if (buy) {
        // Подставить цену из последней закупки: рубли → у.е. по курсу материалов
        const rub = Number(buy.dataset.rub) || 0;
        const rate = Number(draft.currency && draft.currency.materials) || 90;
        const ue = Math.round((rub / rate) * 1e6) / 1e6;
        const tr = buy.closest('tr');
        const byKey = {};
        $$('[data-path]', tr).forEach((i) => {
          const p = JSON.parse(i.dataset.path);
          byKey[p[p.length - 1]] = i;
        });
        let touched = false;
        if (byKey.a3) { byKey.a3.value = ue; touched = true; }
        if (byKey.a2) { byKey.a2.value = Math.round(ue * 2 * 1e6) / 1e6; touched = true; }
        if (byKey.price) { byKey.price.value = ue; touched = true; }
        if (!touched) {
          const first = $$('[data-path][data-type="number"]', tr)[0];
          if (first) first.value = ue;
        }
        toast('Цена из закупки подставлена в у.е. по курсу материалов. Проверьте и нажмите «Сохранить»', 'ok');
      }
    });

    $('#btn-cfg-save', body).addEventListener('click', async () => {
      const bad = harvest();
      if (bad) { toast('Некорректное число: ' + bad, 'error'); return; }
      try {
        await api('/api/pricing/config', { method: 'PUT', body: draft });
        state.schema = null;
        toast('Настройки сохранены', 'ok');
      } catch (e) { toastErr(e); }
    });

    $('#btn-cfg-reset', body).addEventListener('click', async () => {
      if (!await confirmDlg('Сбросить все настройки калькуляции к исходным значениям из Excel?', 'Сбросить')) return;
      try {
        await api('/api/pricing/config/reset', { method: 'POST' });
        state.schema = null;
        toast('Настройки сброшены', 'ok');
        renderPricing();
      } catch (e) { toastErr(e); }
    });

    renderSub();
  }

  /* --- конструктор дополнительных операций --- */
  async function renderOps() {
    const [ops, schema] = await Promise.all([api('/api/extra-ops'), loadSchema()]);
    const typeLabelOf = (k) => { const t = schema.types.find((x) => x.key === k); return t ? t.label : k; };
    const TAR = { perItem: 'за экземпляр', fixed: 'фиксированная', perUnit: 'за единицу' };
    body.innerHTML = `
      <div class="page-head">
        <h2>Дополнительные операции</h2>
        <button class="btn btn-primary" id="btn-new-op">+ Добавить операцию</button>
      </div>
      <p class="muted small" style="margin:-6px 0 12px;max-width:780px">
        Операции, которых нет в стандартном расчёте: упаковка в плёнку, дизайн-услуги, доставка, скругление углов и т.п.
        Добавленная операция появляется в выбранных калькуляторах: менеджер отмечает её галочкой, и сумма попадает
        в цену, КП и техзадание. Цена в у.е.: «работа» считается по курсу работ и участвует в скидке,
        «материал» по курсу материалов, без скидки.</p>
      ${ops.length ? `<div class="panel tbl-wrap"><table class="tbl">
        <thead><tr><th>Название</th><th>Где доступна</th><th>Тариф</th><th class="num">Цена, у.е.</th><th>Вид</th><th></th></tr></thead>
        <tbody>${ops.map((o, i) => `
          <tr data-i="${i}">
            <td><b>${esc(o.name)}</b></td>
            <td>${!o.calcs || !o.calcs.length ? 'Все калькуляторы' : o.calcs.map(typeLabelOf).map(esc).join(', ')}</td>
            <td>${esc(TAR[o.tariff] || o.tariff)}${o.tariff === 'perUnit' && o.unit ? ' (' + esc(o.unit) + ')' : ''}</td>
            <td class="num">${fmtNum(o.price)}</td>
            <td>${o.kind === 'material' ? 'Материал' : 'Работа'}</td>
            <td style="width:180px"><button class="btn btn-sm op-edit">Изменить</button>
                <button class="btn btn-sm btn-danger op-del">Удалить</button></td>
          </tr>`).join('')}</tbody>
      </table></div>` : '<div class="panel empty-note">Пока нет ни одной операции. Нажмите «+ Добавить операцию».</div>'}`;

    async function saveList(list) {
      await api('/api/extra-ops', { method: 'PUT', body: list });
      toast('Сохранено', 'ok');
      renderOps();
    }

    function opDialog(op, idx) {
      const o = op || { name: '', calcs: null, kind: 'work', tariff: 'perItem', price: 0, unit: '' };
      const m = openModal({
        title: op ? 'Операция: ' + op.name : 'Новая операция',
        body: `<form id="op-form" style="display:flex;flex-direction:column;gap:13px">
          <label class="fld"><span>Название *</span><input name="name" type="text" required value="${esc(o.name)}" placeholder="Например: Упаковка в плёнку"></label>
          <div class="fld"><span>Доступна в калькуляторах</span>
            <div class="op-calcs">
              <label class="check-fld"><input type="checkbox" name="all" ${!o.calcs || !o.calcs.length ? 'checked' : ''}><span><b>Во всех</b></span></label>
              ${schema.types.map((t) => `<label class="check-fld"><input type="checkbox" name="calc" value="${esc(t.key)}"
                ${o.calcs && o.calcs.includes(t.key) ? 'checked' : ''}><span>${esc(t.label)}</span></label>`).join('')}
            </div></div>
          <label class="fld"><span>Тариф</span><select name="tariff">
            <option value="perItem" ${o.tariff === 'perItem' ? 'selected' : ''}>За экземпляр (количество = тираж)</option>
            <option value="fixed" ${o.tariff === 'fixed' ? 'selected' : ''}>Фиксированная (один раз на заказ)</option>
            <option value="perUnit" ${o.tariff === 'perUnit' ? 'selected' : ''}>За единицу (количество вводит менеджер)</option>
          </select></label>
          <label class="fld" data-op-unit><span>Единица измерения</span>
            <input name="unit" type="text" value="${esc(o.unit || '')}" placeholder="например: угол, метр, коробка"></label>
          <label class="fld"><span>Цена, у.е. *</span><input name="price" type="number" min="0" step="any" required value="${esc(o.price)}"></label>
          <label class="fld"><span>Вид</span><select name="kind">
            <option value="work" ${o.kind !== 'material' ? 'selected' : ''}>Работа (курс работ, действует скидка)</option>
            <option value="material" ${o.kind === 'material' ? 'selected' : ''}>Материал (курс материалов, без скидки)</option>
          </select></label>
        </form>`,
        footer: `<button class="btn" data-act="cancel">Отмена</button>
                 <button class="btn btn-primary" data-act="save">${op ? 'Сохранить' : 'Добавить'}</button>`,
      });
      const form = $('#op-form', m.body);
      const unitFld = $('[data-op-unit]', m.body);
      const allCb = form.elements.all;
      const syncUnit = () => unitFld.classList.toggle('hidden', form.elements.tariff.value !== 'perUnit');
      const syncAll = (e) => {
        const calcCbs = $$('input[name="calc"]', form);
        if (e && e.target === allCb && allCb.checked) calcCbs.forEach((c) => { c.checked = false; });
        if (e && e.target && e.target.name === 'calc' && e.target.checked) allCb.checked = false;
        if (!calcCbs.some((c) => c.checked)) allCb.checked = true;
      };
      form.addEventListener('change', (e) => { syncUnit(); syncAll(e); });
      syncUnit();
      async function submit() {
        if (!form.reportValidity()) return;
        const f = new FormData(form);
        const calcs = allCb.checked ? null : $$('input[name="calc"]:checked', form).map((c) => c.value);
        const next = {
          id: op ? op.id : undefined,
          name: String(f.get('name')).trim(),
          calcs,
          tariff: f.get('tariff'),
          unit: String(f.get('unit') || '').trim(),
          price: parseFloat(String(f.get('price')).replace(',', '.')),
          kind: f.get('kind'),
        };
        m.close();
        const list = ops.slice();
        if (op) list[idx] = next; else list.push(next);
        try { await saveList(list); } catch (e) { toastErr(e); }
      }
      $('[data-act="cancel"]', m.foot).onclick = m.close;
      $('[data-act="save"]', m.foot).onclick = submit;
      form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    }

    $('#btn-new-op', body).addEventListener('click', () => opDialog());
    $$('tbody tr', body).forEach((tr) => {
      const i = Number(tr.dataset.i);
      $('.op-edit', tr).addEventListener('click', () => opDialog(ops[i], i));
      $('.op-del', tr).addEventListener('click', async () => {
        if (!await confirmDlg(`Удалить операцию «${ops[i].name}»?`)) return;
        const list = ops.slice();
        list.splice(i, 1);
        try { await saveList(list); } catch (e) { toastErr(e); }
      });
    });
  }

  async function renderIntegrations() {
    const cfg = await api('/api/integrations');
    const b = cfg.bitrix24 || {};
    const origin = location.origin;
    body.innerHTML = `
      <div class="page-head"><h2>Битрикс24</h2></div>
      <div class="panel panel-pad" style="max-width:820px">
        <h3>Отправка заказов в Битрикс24</h3>
        <p class="muted small" style="margin:6px 0 12px">
          Кнопка «В Битрикс24» в карточке заказа создаёт сделку на вашем портале.
          Создайте на портале входящий вебхук (Разработчикам → Другое → Входящий вебхук, права: CRM)
          и вставьте его адрес сюда.</p>
        <label class="fld"><span>Адрес входящего вебхука Битрикс24</span>
          <input id="b24-url" type="text" value="${esc(b.webhookUrl || '')}"
            placeholder="https://ваш-портал.bitrix24.ru/rest/1/abc123xyz/"></label>
        <div class="toolbar" style="margin-top:12px">
          <button class="btn btn-primary" id="b24-save">Сохранить</button>
          ${b.webhookUrl ? '<span class="badge st-ready">Настроено</span>' : '<span class="badge st-cancelled">Не настроено</span>'}
        </div>

        <h3 style="margin-top:26px">Приём лидов из Битрикс24</h3>
        ${b.inKey ? `
          <p class="muted small" style="margin:6px 0 10px">
            В Битрикс24 настройте робота или исходящий вебхук, который отправляет POST-запрос на адрес:</p>
          <div class="panel panel-pad" style="background:var(--accent-light);border-color:#F5BBD7;word-break:break-all">
            <code>${esc(origin)}/api/bitrix/lead?key=${esc(b.inKey)}</code>
          </div>
          <p class="muted small" style="margin-top:10px">
            Тело запроса (JSON): <code>{"title":"Название","client_name":"Клиент","phone":"…","email":"…","price":0,"quantity":0,"notes":"…"}</code>.
            В СРМ автоматически создаётся клиент (если его ещё нет) и заказ в статусе «Расчёт» на руководителя.</p>`
        : `<p class="muted small" style="margin:6px 0">Нажмите «Сохранить» — система сгенерирует секретный ключ,
            и здесь появится адрес для приёма лидов.</p>`}
      </div>`;

    $('#b24-save', body).addEventListener('click', async () => {
      try {
        await api('/api/integrations', { method: 'PUT', body: { bitrix24: { webhookUrl: $('#b24-url', body).value.trim() } } });
        toast('Настройки интеграции сохранены', 'ok');
        renderIntegrations();
      } catch (e) { toastErr(e); }
    });
  }

  /* --- конструктор калькуляторов --- */
  async function renderCalcs() {
    const list = await api('/api/custom-calcs');
    body.innerHTML = `
      <div class="page-head">
        <h2>Конструктор калькуляторов</h2>
        <button class="btn btn-primary" id="btn-new-calc">+ Новый калькулятор</button>
      </div>
      <p class="muted small" style="margin:-6px 0 12px;max-width:780px">
        Свои виды продукции: визитки, календари, наклейки, что угодно. Два режима.
        <b>Простой</b>: набор операций с тарифами (за экземпляр, фиксированно, за единицу из поля), суммы складываются.
        <b>С формулами</b>: пошаговый расчёт формулами как в Excel: поля и шаги по именам, функции
        ОКРВВЕРХ, ОКРУГЛ, МИН, МАКС, ЕСЛИ. Готовый калькулятор появляется отдельной вкладкой у всех менеджеров,
        считает по общим курсам у.е. и скидке, попадает в заказы, КП и техзадания.</p>
      ${list.length ? `<div class="panel tbl-wrap"><table class="tbl">
        <thead><tr><th>Название</th><th>Режим</th><th class="num">Полей</th><th class="num">Операций / шагов</th><th></th></tr></thead>
        <tbody>${list.map((c, i) => `
          <tr data-i="${i}">
            <td><b>${esc(c.label)}</b></td>
            <td>${c.mode === 'formula' ? 'С формулами' : 'Простой'}</td>
            <td class="num">${(c.fields || []).length}</td>
            <td class="num">${c.mode === 'formula' ? (c.vars || []).length : (c.ops || []).length}</td>
            <td style="width:180px"><button class="btn btn-sm c-edit">Изменить</button>
                <button class="btn btn-sm btn-danger c-del">Удалить</button></td>
          </tr>`).join('')}</tbody>
      </table></div>` : '<div class="panel empty-note">Пока нет своих калькуляторов. Нажмите «+ Новый калькулятор».</div>'}`;

    async function saveList(next) {
      await api('/api/custom-calcs', { method: 'PUT', body: next });
      state.schema = null;
      toast('Сохранено', 'ok');
      renderCalcs();
    }

    function calcDialog(def, idx) {
      // Черновик определения: правим локально, сохраняем целиком
      const d = def ? structuredClone(def) : {
        key: 'c' + Date.now().toString(36),
        label: '', mode: 'simple', discount: true, fields: [], ops: [], vars: [],
        outMaterials: '', outWorks: '',
      };
      let seq = 0;
      const nextKey = (prefix, arr) => {
        do { seq++; } while (arr.some((x) => x.key === prefix + seq));
        return prefix + seq;
      };

      const m = openModal({
        title: def ? 'Калькулятор: ' + def.label : 'Новый калькулятор',
        wide: true,
        body: '<div id="calcctor"></div>',
        footer: `<button class="btn" data-act="cancel">Отмена</button>
                 <button class="btn" data-act="try">Проверить расчёт</button>
                 <button class="btn btn-primary" data-act="save">${def ? 'Сохранить' : 'Добавить'}</button>`,
      });
      const root = $('#calcctor', m.body);

      function numFieldOptions(selected) {
        return d.fields.filter((f) => f.type !== 'select')
          .map((f) => `<option value="${esc(f.key)}" ${f.key === selected ? 'selected' : ''}>${esc(f.label || f.key)}</option>`).join('');
      }

      function render() {
        root.innerHTML = `
          <div style="display:flex;gap:14px;margin-bottom:13px">
            <label class="fld" style="flex:1"><span>Название *</span>
              <input id="cc-label" type="text" value="${esc(d.label)}" placeholder="Например: Визитки"></label>
            <label class="fld" style="width:190px"><span>Режим</span>
              <select id="cc-mode">
                <option value="simple" ${d.mode !== 'formula' ? 'selected' : ''}>Простой</option>
                <option value="formula" ${d.mode === 'formula' ? 'selected' : ''}>С формулами</option>
              </select></label>
          </div>

          <div class="cc-sect">
            <div class="cc-sect-head"><b>Поля ввода</b>
              <span class="muted small">тираж добавляется автоматически${d.mode === 'formula' ? '; в формулах поле доступно по имени-ключу' : ''}</span>
              <button class="btn btn-sm" id="cc-add-field">+ Поле</button></div>
            ${d.fields.map((f, i) => `
              <div class="cc-row" data-fi="${i}">
                <code class="cc-key">${esc(f.key)}</code>
                <input type="text" class="f-label" placeholder="Название поля" value="${esc(f.label || '')}" style="flex:2">
                <select class="f-type" style="width:110px">
                  <option value="number" ${f.type !== 'select' ? 'selected' : ''}>число</option>
                  <option value="select" ${f.type === 'select' ? 'selected' : ''}>выбор</option>
                </select>
                ${f.type === 'select'
                  ? `<input type="text" class="f-options" placeholder="варианты через запятую" value="${esc((f.options || []).join(', '))}" style="flex:2">`
                  : `<input type="text" class="f-unit" placeholder="ед." value="${esc(f.unit || '')}" style="width:70px">
                     <input type="number" step="any" class="f-default" placeholder="по умолч." value="${f.default ?? ''}" style="width:100px">`}
                <button class="btn btn-sm btn-danger f-del">✕</button>
              </div>`).join('') || '<div class="muted small" style="margin:6px 0">Полей пока нет (для простого режима они не обязательны)</div>'}
          </div>

          ${d.mode !== 'formula' ? `
          <div class="cc-sect">
            <div class="cc-sect-head"><b>Операции</b>
              <span class="muted small">цена = сумма операций; работы идут со скидкой по курсу работ, материалы без скидки</span>
              <button class="btn btn-sm" id="cc-add-op">+ Операция</button></div>
            ${d.ops.map((o, i) => `
              <div class="cc-row" data-oi="${i}">
                <input type="text" class="o-name" placeholder="Название операции" value="${esc(o.name || '')}" style="flex:2">
                <select class="o-kind" style="width:110px">
                  <option value="work" ${o.kind !== 'material' ? 'selected' : ''}>работа</option>
                  <option value="material" ${o.kind === 'material' ? 'selected' : ''}>материал</option>
                </select>
                <select class="o-tariff" style="width:150px">
                  <option value="perItem" ${o.tariff !== 'fixed' && o.tariff !== 'field' ? 'selected' : ''}>за экземпляр</option>
                  <option value="fixed" ${o.tariff === 'fixed' ? 'selected' : ''}>фиксированно</option>
                  <option value="field" ${o.tariff === 'field' ? 'selected' : ''}>за единицу поля</option>
                </select>
                ${o.tariff === 'field' ? `<select class="o-qtyfield" style="width:140px">${numFieldOptions(o.qtyField)}</select>` : ''}
                <input type="number" step="any" min="0" class="o-price" placeholder="цена у.е." value="${o.price ?? ''}" style="width:100px">
                <button class="btn btn-sm btn-danger o-del">✕</button>
              </div>`).join('') || '<div class="muted small" style="margin:6px 0">Добавьте хотя бы одну операцию</div>'}
          </div>` : `
          <div class="cc-sect">
            <div class="cc-sect-head"><b>Шаги расчёта (формулы)</b>
              <span class="muted small">считаются по порядку; доступны tiraj, числовые поля и предыдущие шаги</span>
              <button class="btn btn-sm" id="cc-add-var">+ Шаг</button></div>
            ${d.vars.map((v, i) => `
              <div class="cc-row" data-vi="${i}">
                <code class="cc-key">${esc(v.key)}</code>
                <input type="text" class="v-label" placeholder="Что считаем" value="${esc(v.label || '')}" style="flex:1">
                <input type="text" class="v-expr mono" placeholder="формула, например: ОКРВВЕРХ(tiraj / 24)" value="${esc(v.expr || '')}" style="flex:2">
                <button class="btn btn-sm btn-danger v-del">✕</button>
              </div>`).join('') || '<div class="muted small" style="margin:6px 0">Например: листы = ОКРВВЕРХ(tiraj / 24), потом печать = 20 + листы * 0.4</div>'}
            <div style="display:flex;gap:10px;margin-top:10px">
              <label class="fld" style="flex:1"><span>Итог: материалы, у.е. (курс материалов, без скидки)</span>
                <input type="text" id="cc-outm" class="mono" value="${esc(d.outMaterials || '')}" placeholder="например: бумага"></label>
              <label class="fld" style="flex:1"><span>Итог: работы, у.е. (курс работ, скидка k)</span>
                <input type="text" id="cc-outw" class="mono" value="${esc(d.outWorks || '')}" placeholder="например: печать + резка"></label>
            </div>
            <p class="muted small" style="margin-top:8px">Функции: ОКРВВЕРХ(x), ОКРВНИЗ(x), ОКРУГЛ(x; знаков), МИН(...), МАКС(...), ЕСЛИ(условие; тогда; иначе), КОРЕНЬ(x). Числа можно с запятой.</p>
          </div>`}
          <div id="cc-test-result"></div>`;

        // один написанный черновик: считываем поля при любом изменении
        root.oninput = harvest;
        root.onchange = (e) => { harvest(); if (e.target.matches('.f-type, .o-tariff, #cc-mode')) render(); };
        $('#cc-add-field', root)?.addEventListener('click', () => { harvest(); d.fields.push({ key: nextKey('p', d.fields), label: '', type: 'number', unit: '', default: '' }); render(); });
        $('#cc-add-op', root)?.addEventListener('click', () => { harvest(); d.ops.push({ name: '', kind: 'work', tariff: 'perItem', price: '' }); render(); });
        $('#cc-add-var', root)?.addEventListener('click', () => { harvest(); d.vars.push({ key: nextKey('v', d.vars), label: '', expr: '' }); render(); });
        $$('.f-del', root).forEach((b) => b.addEventListener('click', () => { harvest(); d.fields.splice(Number(b.closest('[data-fi]').dataset.fi), 1); render(); }));
        $$('.o-del', root).forEach((b) => b.addEventListener('click', () => { harvest(); d.ops.splice(Number(b.closest('[data-oi]').dataset.oi), 1); render(); }));
        $$('.v-del', root).forEach((b) => b.addEventListener('click', () => { harvest(); d.vars.splice(Number(b.closest('[data-vi]').dataset.vi), 1); render(); }));
      }

      function harvest() {
        d.label = $('#cc-label', root).value;
        d.mode = $('#cc-mode', root).value;
        $$('[data-fi]', root).forEach((row) => {
          const f = d.fields[Number(row.dataset.fi)];
          f.label = $('.f-label', row).value;
          f.type = $('.f-type', row).value;
          if (f.type === 'select') {
            const opts = $('.f-options', row);
            if (opts) f.options = opts.value.split(',').map((s) => s.trim()).filter(Boolean);
          } else {
            const u = $('.f-unit', row), dv = $('.f-default', row);
            if (u) f.unit = u.value;
            if (dv) f.default = dv.value === '' ? '' : Number(dv.value);
          }
        });
        $$('[data-oi]', root).forEach((row) => {
          const o = d.ops[Number(row.dataset.oi)];
          o.name = $('.o-name', row).value;
          o.kind = $('.o-kind', row).value;
          o.tariff = $('.o-tariff', row).value;
          const qf = $('.o-qtyfield', row);
          if (qf) o.qtyField = qf.value;
          o.price = Number($('.o-price', row).value) || 0;
        });
        $$('[data-vi]', root).forEach((row) => {
          const v = d.vars[Number(row.dataset.vi)];
          v.label = $('.v-label', row).value;
          v.expr = $('.v-expr', row).value;
        });
        const om = $('#cc-outm', root), ow = $('#cc-outw', root);
        if (om) d.outMaterials = om.value;
        if (ow) d.outWorks = ow.value;
      }

      async function tryCalc() {
        harvest();
        const params = { tiraj: 100, discount: 'k=0' };
        for (const f of d.fields) {
          params[f.key] = f.type === 'select' ? (f.options || [])[0] : (f.default !== '' && f.default != null ? Number(f.default) : 0);
        }
        const boxR = $('#cc-test-result', root);
        try {
          const r = await api('/api/custom-calcs/test', { method: 'POST', body: { def: d, params } });
          boxR.innerHTML = `<div class="panel panel-pad" style="margin-top:10px;background:var(--accent-light);border-color:#F5BBD7">
            Пробный расчёт (тираж 100, поля по умолчанию): <b>${fmtMoney(r.priceTotal)}</b> за тираж,
            ${fmtMoney(r.pricePerItem)} за экземпляр. Материалы ${fmtMoney(r.breakdown.materials)}, работы ${fmtMoney(r.breakdown.postpress)}.</div>`;
        } catch (e) {
          boxR.innerHTML = `<div class="form-error" style="margin-top:10px">${esc(e.message)}</div>`;
        }
      }

      async function submit() {
        harvest();
        if (!d.label.trim()) { toast('Укажите название калькулятора', 'error'); return; }
        const next = list.slice();
        if (def) next[idx] = d; else next.push(d);
        try { m.close(); await saveList(next); } catch (e) { toastErr(e); }
      }

      $('[data-act="cancel"]', m.foot).onclick = m.close;
      $('[data-act="try"]', m.foot).onclick = tryCalc;
      $('[data-act="save"]', m.foot).onclick = submit;
      render();
    }

    $('#btn-new-calc', body).addEventListener('click', () => calcDialog());
    $$('tbody tr', body).forEach((tr) => {
      const i = Number(tr.dataset.i);
      $('.c-edit', tr).addEventListener('click', () => calcDialog(list[i], i));
      $('.c-del', tr).addEventListener('click', async () => {
        if (!await confirmDlg(`Удалить калькулятор «${list[i].label}»? Старые заказы этого вида останутся, но пересчитать их будет нельзя.`)) return;
        const next = list.slice();
        next.splice(i, 1);
        try { await saveList(next); } catch (e) { toastErr(e); }
      });
    });
  }

  /* --- Производство: участки, оборудование, операции и нормы (из них строится техкарта) --- */
  async function renderProduction() {
    let P = await api('/api/production');
    const KIND = { own: 'Свой участок', outsource: 'Подряд (на стороне)' };
    const PK = { '': '—', offset: 'Офсет', toner: 'Цифра цветная', inkjet: 'Струйная', bw: 'Цифра ч/б' };
    const NUM = {
      areas: ['manHour'],
      machines: ['a3PerSheet', 'setupMin', 'perHour', 'hourRate'],
      ops: ['setupMin', 'perHour', 'people'],
    };
    const NULLABLE = { ops: ['setupMin', 'perHour'] }; // пусто = нормы машины
    const approx = (r) => (r.approx ? ' <span class="badge-approx" title="Примерная норма для старта: замените на свою">примерно</span>' : '');
    const val = (v) => (v === null || v === undefined ? '' : esc(v));
    const areaOpts = (sel) => P.areas.map((a) =>
      `<option value="${esc(a.id)}" ${a.id === sel ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
    const machineOpts = (areaId, sel) => `<option value="">— вручную, без машины —</option>` +
      P.machines.filter((m) => m.areaId === areaId).map((m) =>
        `<option value="${esc(m.id)}" ${m.id === sel ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
    const inp = (k, i, f, v, cls = 'pr-in', attrs = '') =>
      `<input type="${NUM[k] && NUM[k].includes(f) ? 'number' : 'text'}" step="any" min="0" class="${cls}"
        data-k="${k}" data-i="${i}" data-f="${f}" value="${val(v)}" ${attrs}>`;
    const sel = (k, i, f, opts) => `<select class="pr-sel" data-k="${k}" data-i="${i}" data-f="${f}">${opts}</select>`;

    function draw() {
      const ops = P.ops.map((o, i) => {
        const m = P.machines.find((x) => x.id === o.machineId);
        return `<tr>
          <td>${inp('ops', i, 'name', o.name, 'pr-name')}</td>
          <td>${sel('ops', i, 'areaId', areaOpts(o.areaId))}</td>
          <td>${sel('ops', i, 'machineId', machineOpts(o.areaId, o.machineId))}</td>
          <td class="muted">${esc(o.unit)}</td>
          <td>${inp('ops', i, 'setupMin', o.setupMin, 'pr-in', `placeholder="${m ? 'машина: ' + esc(m.setupMin) : '0'}"`)}</td>
          <td>${inp('ops', i, 'perHour', o.perHour, 'pr-in', `placeholder="${m ? 'машина: ' + esc(m.perHour) : '0'}"`)}</td>
          <td>${m ? '<span class="muted small">—</span>' : inp('ops', i, 'people', o.people, 'pr-in pr-xs')}</td>
          <td>${o.optional ? `<label class="check-fld"><input type="checkbox" data-k="ops" data-i="${i}" data-f="active" ${o.active !== false ? 'checked' : ''}><span></span></label>` : '<span class="muted small" title="У операции своя цена в прайсе, выключать нельзя">всегда</span>'}</td>
          <td><label class="check-fld" title="После этой операции работу принимает ОТК"><input type="checkbox" data-k="ops" data-i="${i}" data-f="qc" ${o.qc ? 'checked' : ''}><span></span></label></td>
          <td>${approx(o)}</td>
        </tr>`;
      }).join('');

      body.innerHTML = `<div id="pr-root">
        <div class="page-head">
          <h2>Производство: участки, оборудование, нормы</h2>
          <div class="toolbar">
            <button class="btn" id="pr-reset">Вернуть начальные</button>
            <button class="btn btn-primary" id="pr-save">Сохранить</button>
          </div>
        </div>
        <p class="muted small prod-intro">Из этого справочника строится техкарта заказа: какие операции, на каком участке
          и машине, сколько времени. <b>Время операции = приладка × число приладок + объём / выработка в час.</b>
          Нормы с пометкой «примерно» заполнены для старта, замените их на свои. Плановая себестоимость считается,
          когда указана стоимость машино-часа (для машин) или человеко-часа (для ручных участков).</p>

        <div class="panel panel-pad cfg-section">
          <h4>Участки</h4>
          <div class="tbl-wrap"><table class="tbl pr-tbl">
            <thead><tr><th>Участок</th><th>Тип</th><th>Очередь заданий</th><th>Человеко-час, ₽</th><th>Примечание</th><th></th></tr></thead>
            <tbody>${P.areas.map((a, i) => `<tr>
              <td>${inp('areas', i, 'name', a.name, 'pr-name')}</td>
              <td>${sel('areas', i, 'kind', Object.entries(KIND).map(([k, l]) => `<option value="${k}" ${a.kind === k ? 'selected' : ''}>${l}</option>`).join(''))}</td>
              <td>${sel('areas', i, 'queue', [['manual', 'ставит мастер'], ['auto', 'по сроку сдачи']].map(([k, l]) => `<option value="${k}" ${(a.queue || 'manual') === k ? 'selected' : ''}>${l}</option>`).join(''))}</td>
              <td>${inp('areas', i, 'manHour', a.manHour)}</td>
              <td>${inp('areas', i, 'note', a.note || '', 'pr-note')}</td>
              <td><button class="btn btn-ghost btn-sm" data-del="areas:${i}" title="Удалить участок">✕</button></td>
            </tr>`).join('')}</tbody>
          </table></div>
          <button class="btn btn-sm" id="pr-add-area" style="margin-top:10px">+ Участок</button>
        </div>

        <div class="panel panel-pad cfg-section">
          <h4>Оборудование</h4>
          <p class="muted small" style="margin-bottom:8px">«А3 на листе»: сколько условных листов А3 (от А3 до 330×487) помещается на печатный
            лист машины; калькуляция ведётся в условных А3, для офсета обычно 2. Выработка: в единицах операции в час
            (для печати: прогонов печатного листа в час).</p>
          <div class="tbl-wrap"><table class="tbl pr-tbl">
            <thead><tr><th>Машина</th><th>Участок</th><th>Вид печати</th><th>А3 на листе</th><th>Мин. формат</th><th>Макс. формат</th>
              <th>Приладка, мин</th><th>Выработка в час</th><th>Машино-час, ₽</th><th></th><th></th></tr></thead>
            <tbody>${P.machines.map((m, i) => `<tr>
              <td>${inp('machines', i, 'name', m.name, 'pr-name')}</td>
              <td>${sel('machines', i, 'areaId', areaOpts(m.areaId))}</td>
              <td>${sel('machines', i, 'printKind', Object.entries(PK).map(([k, l]) => `<option value="${k}" ${(m.printKind || '') === k ? 'selected' : ''}>${l}</option>`).join(''))}</td>
              <td>${inp('machines', i, 'a3PerSheet', m.a3PerSheet, 'pr-in pr-xs')}</td>
              <td>${inp('machines', i, 'minFormat', m.minFormat, 'pr-in pr-fmt', 'placeholder="мм×мм"')}</td>
              <td>${inp('machines', i, 'maxFormat', m.maxFormat, 'pr-in pr-fmt', 'placeholder="мм×мм"')}</td>
              <td>${inp('machines', i, 'setupMin', m.setupMin)}</td>
              <td>${inp('machines', i, 'perHour', m.perHour)}</td>
              <td>${inp('machines', i, 'hourRate', m.hourRate)}</td>
              <td>${approx(m)}</td>
              <td><button class="btn btn-ghost btn-sm" data-del="machines:${i}" title="Удалить машину">✕</button></td>
            </tr>`).join('')}</tbody>
          </table></div>
          <button class="btn btn-sm" id="pr-add-machine" style="margin-top:10px">+ Машина</button>
        </div>

        <div class="panel panel-pad cfg-section">
          <h4>Операции и нормы</h4>
          <p class="muted small" style="margin-bottom:8px">Если у операции выбрана машина и нормы оставлены пустыми, берутся нормы машины.
            Операции с галочкой «вкл.» можно выключить: в прайсе у них нет своей цены, и они пропадут из техкарты.
            Галочка «ОТК»: после операции работу принимает контролёр, следующие операции ждут приёмки.</p>
          <div class="tbl-wrap"><table class="tbl pr-tbl">
            <thead><tr><th>Операция</th><th>Участок</th><th>Машина</th><th>Ед.</th><th>Приладка, мин</th>
              <th>Выработка в час</th><th>Людей</th><th>Вкл.</th><th title="После операции работу принимает ОТК: следующие операции ждут приёмки">ОТК</th><th></th></tr></thead>
            <tbody>${ops}</tbody>
          </table></div>
        </div>

        <div class="panel panel-pad cfg-section">
          <h4>Причины паузы</h4>
          <p class="muted small" style="margin-bottom:8px">Сотрудник выбирает причину, когда ставит задание на паузу. По ним в отчёте «План и факт»
            видно, сколько стояла работа и почему. Одна причина на строку.</p>
          <textarea id="pr-reasons" rows="6" style="width:100%;max-width:520px">${esc((P.pauseReasons || []).join('\n'))}</textarea>
        </div>

        <div class="panel panel-pad cfg-section">
          <h4>Технологический отход бумаги</h4>
          <table class="cfg-table"><tbody>
            <tr><td class="k">Цифра и струя, % к чистому тиражу</td>
              <td><input type="number" step="any" min="0" max="100" id="pr-waste" value="${val(P.waste && P.waste.digitalPct)}">${approx(P.waste || {})}</td></tr>
            <tr><td class="k">Офсет</td><td class="muted small">как в прайсе: приладка 80 листов на краску + 2% (Настройки калькуляции → Коэффициенты)</td></tr>
          </tbody></table>
          <p class="muted small" style="margin-top:6px">В прайсе цифры заложен запас бумаги 30%. Это наценка, поэтому в цех он не передаётся:
            техкарта и ТЗ показывают чистый тираж плюс этот процент, а разница видна в техкарте строкой «наценка».</p>
        </div></div>`;
      bind($('#pr-root', body));
    }

    function bind(root) {
      root.oninput = root.onchange = (e) => {
        const el = e.target;
        if (el.id === 'pr-reasons') {
          P.pauseReasons = el.value.split('\n').map((x) => x.trim()).filter(Boolean);
          return;
        }
        if (el.id === 'pr-waste') {
          P.waste = { ...(P.waste || {}), digitalPct: el.value === '' ? 0 : Number(el.value), approx: false };
          return;
        }
        const k = el.dataset.k, f = el.dataset.f, i = Number(el.dataset.i);
        if (!k || !P[k] || !P[k][i]) return;
        const row = P[k][i];
        if (el.type === 'checkbox') row[f] = el.checked;
        else if (NUM[k] && NUM[k].includes(f)) {
          const s = String(el.value).replace(',', '.').trim();
          row[f] = s === '' ? (NULLABLE[k] && NULLABLE[k].includes(f) ? null : 0) : Number(s);
        } else row[f] = el.value;
        if (f === 'setupMin' || f === 'perHour') row.approx = false;
        // смена участка: у операции сбрасываем машину чужого участка, перерисовываем списки машин
        if (e.type === 'change' && f === 'areaId') {
          if (k === 'ops') {
            const m = P.machines.find((x) => x.id === row.machineId);
            if (m && m.areaId !== row.areaId) row.machineId = '';
          }
          draw();
        }
        if (e.type === 'change' && k === 'ops' && f === 'machineId') draw();
      };

      $$('[data-del]', body).forEach((btn) => btn.addEventListener('click', async () => {
        const [k, iStr] = btn.dataset.del.split(':');
        const i = Number(iStr);
        if (k === 'areas') {
          const a = P.areas[i];
          const busy = P.machines.filter((m) => m.areaId === a.id).length + P.ops.filter((o) => o.areaId === a.id).length;
          if (busy) { toast(`На участке «${a.name}» есть машины или операции: сначала перенесите их на другой участок`, 'error'); return; }
          if (!await confirmDlg(`Удалить участок «${a.name}»?`)) return;
        }
        if (k === 'machines') {
          const m = P.machines[i];
          const used = P.ops.filter((o) => o.machineId === m.id);
          if (used.length) { toast(`Машина «${m.name}» назначена операциям: ${used.map((o) => o.name).join(', ')}. Сначала выберите им другую машину`, 'error'); return; }
          if (!await confirmDlg(`Удалить машину «${m.name}»?`)) return;
        }
        P[k].splice(i, 1);
        draw();
      }));

      $('#pr-add-area', body).addEventListener('click', () => {
        P.areas.push({ id: '', name: 'Новый участок', kind: 'own', queue: 'manual', manHour: 0, note: '' });
        draw();
      });
      $('#pr-add-machine', body).addEventListener('click', () => {
        P.machines.push({ id: '', name: 'Новая машина', areaId: P.areas[0] ? P.areas[0].id : '', printKind: '',
          a3PerSheet: 1, minFormat: '', maxFormat: '', setupMin: 0, perHour: 0, hourRate: 0 });
        draw();
      });

      $('#pr-save', body).addEventListener('click', async () => {
        try {
          const r = await api('/api/production', { method: 'PUT', body: P });
          P = r.production;
          draw();
          toast('Справочник производства сохранён. Новые расчёты строят техкарту по нему.', 'ok');
        } catch (e) { toastErr(e); }
      });
      $('#pr-reset', body).addEventListener('click', async () => {
        if (!await confirmDlg('Вернуть начальный справочник производства? Ваши нормы и ставки будут заменены примерными.', 'Вернуть')) return;
        try {
          await api('/api/production/reset', { method: 'POST' });
          P = await api('/api/production');
          draw();
          toast('Справочник возвращён к начальному', 'ok');
        } catch (e) { toastErr(e); }
      });
    }

    draw();
  }

  function render() {
    if (!tab) { body.innerHTML = '<div class="panel empty-note">Настроек для вашей должности нет</div>'; return; }
    const fn = tab === 'users' ? renderUsers
      : tab === 'positions' ? renderPositions
      : tab === 'audit' ? renderAudit
      : tab === 'pricing' ? renderPricing
      : tab === 'ops' ? renderOps
      : tab === 'calcs' ? renderCalcs
      : tab === 'production' ? renderProduction
      : renderIntegrations;
    fn().catch((e) => { body.innerHTML = `<div class="form-error">${esc(e.message)}</div>`; });
  }
  render();
};

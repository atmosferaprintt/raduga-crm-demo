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
          <select name="manager_id">${managerOptions(preset.manager_id ?? state.user.id)}</select>
        </label>
        <label class="fld"><span>Статус</span>
          <select name="status">${STATUSES.map((s) => `<option value="${s.key}">${s.label}</option>`).join('')}</select>
        </label>
        <label class="fld"><span>Срок сдачи</span><input name="due_date" type="date"></label>
        <label class="fld"><span>Тираж, экз.</span><input name="quantity" type="number" min="0" value="0"></label>
        <label class="fld"><span>Цена за тираж, ₽</span><input name="price" type="number" min="0" step="0.01" value="0"></label>
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
          manager_id: Number(f.get('manager_id')) || null, status: f.get('status'),
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
        <select id="ord-manager">
          <option value="">Все менеджеры</option>
          ${managerOptions()}
        </select>
      </div>
      <button class="btn btn-primary" id="btn-new-order">+ Новый заказ</button>
    </div>
    <div id="orders-body"><div class="empty-note">Загрузка…</div></div>`;

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
      <div class="kb-card" draggable="true" data-id="${o.id}">
        <div class="kb-num"><span>№ ${esc(o.number)}</span><span>${orderDueHTML(o.due_date)}</span></div>
        <div class="kb-title">${esc(o.title || typeLabel(o.product_type))}</div>
        <div class="kb-client">${esc(o.client_name || 'Без клиента')}</div>
        <div class="kb-foot">
          <span class="kb-price">${o.price ? fmtMoney(o.price) : '—'}</span>
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
          await api('/api/orders/' + id, { method: 'PUT', body: { status: col.dataset.status } });
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
            <th class="num">Тираж</th><th class="num">Сумма</th><th>Срок</th><th>Создан</th>
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
                <td class="num">${o.price ? fmtMoney(o.price) : '—'}</td>
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


/* ================= ПРОИЗВОДСТВО: очередь заданий ================= */

views.production = async function (box) {
  await Promise.all([loadUsers(), loadSchema().catch(() => null)]);
  const STAGES = [
    { key: 'print', label: 'Печать' },
    { key: 'postpress', label: 'Постпечать' },
    { key: 'binding', label: 'Переплёт / отделка' },
    { key: 'done', label: 'Выполнено' },
  ];

  box.innerHTML = `
    <div class="page-head">
      <span class="muted small">Заказы в статусе «Производство». Перетаскивайте карточки по участкам;
        из «Выполнено» заказ переводится в «Готов» одной кнопкой.</span>
    </div>
    <div id="prod-body"><div class="empty-note">Загрузка…</div></div>`;
  const body = $('#prod-body', box);

  function cardHTML(o) {
    return `
      <div class="kb-card" draggable="true" data-id="${o.id}">
        <div class="kb-num"><span>№ ${esc(o.number)}</span><span>${orderDueHTML(o.due_date)}</span></div>
        <div class="kb-title">${esc(o.title || typeLabel(o.product_type))}</div>
        <div class="kb-client">${esc(typeLabel(o.product_type) || '')} · ${fmtNum(o.quantity || 0)} экз.</div>
        <div class="kb-foot">
          <span>${esc(o.manager_name || '')}</span>
          <button class="btn btn-sm prod-tz" data-id="${o.id}" title="Распечатать техзадание">ТЗ</button>
        </div>
      </div>`;
  }

  async function refresh() {
    const orders = (await api('/api/orders?status=production'))
      .sort((a, b) => (a.due_date || '9999') < (b.due_date || '9999') ? -1 : 1);
    const cols = STAGES.map((st) => {
      const list = orders.filter((o) => (o.prod_stage || 'print') === st.key);
      return `
        <div class="kb-col" data-stage="${st.key}">
          <div class="kb-col-head"><span>${st.label}</span><span class="cnt">${list.length}</span></div>
          <div class="kb-cards">${list.map(cardHTML).join('')}
            ${st.key === 'done' && list.length ? `<button class="btn btn-sm btn-block" id="btn-all-ready">Все выполненные → «Готов»</button>` : ''}
          </div>
        </div>`;
    }).join('');
    body.innerHTML = orders.length
      ? `<div class="kanban prod-board">${cols}</div>`
      : '<div class="panel empty-note">Нет заказов в производстве. Переведите заказ в статус «Производство» — он появится в очереди печати.</div>';

    $$('.kb-card', body).forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.prod-tz')) return;
        navigate('#/orders/' + card.dataset.id);
      });
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', card.dataset.id);
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
    });
    $$('.prod-tz', body).forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const o = orders.find((x) => String(x.id) === btn.dataset.id);
        if (o) printTechTask(o);
      });
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
          await api('/api/orders/' + id, { method: 'PUT', body: { prod_stage: col.dataset.stage } });
          await refresh();
        } catch (err) { toastErr(err); }
      });
    });
    const allReady = $('#btn-all-ready', body);
    if (allReady) allReady.addEventListener('click', async () => {
      const done = orders.filter((o) => o.prod_stage === 'done');
      try {
        for (const o of done) await api('/api/orders/' + o.id, { method: 'PUT', body: { status: 'ready' } });
        toast(`Переведено в «Готов»: ${done.length}`, 'ok');
        await refresh();
      } catch (err) { toastErr(err); }
    });
  }

  await refresh();
};

/* ================= КАРТОЧКА ЗАКАЗА ================= */

views.order = async function (box, id) {
  const [order] = await Promise.all([api('/api/orders/' + id), loadUsers(), loadClients(), loadSchema().catch(() => null)]);
  $('#page-title').textContent = `Заказ № ${order.number}`;
  const calc = safeParse(order.calc_json);
  const params = safeParse(order.params_json);
  const isAdmin = state.user.role === 'admin';
  let b24 = null;
  try { const ig = await api('/api/integrations'); b24 = ig && ig.bitrix24; } catch { /* не критично */ }
  const b24on = !!(b24 && (b24.configured || b24.webhookUrl));

  box.innerHTML = `
    <div class="page-head">
      <h2>№ ${esc(order.number)} · ${esc(order.title || typeLabel(order.product_type))} &nbsp;${statusBadge(order.status)}</h2>
      <div class="toolbar">
        <button class="btn" id="btn-kp" ${calc && calc.priceTotal != null || order.price ? '' : 'disabled title="Нет данных для КП"'}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
          Коммерческое предложение</button>
        <button class="btn" id="btn-tz" ${order.product_type ? '' : 'disabled title="Нет калькуляции"'}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          Техзадание</button>
        <button class="btn" id="btn-recalc">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          ${order.product_type ? 'Пересчитать / изменить калькуляцию' : 'Создать калькуляцию'}</button>
        ${calc && calc.materials && calc.materials.length ? `<button class="btn" id="btn-writeoff" title="Списать материалы тиража со склада">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
          Списать материалы</button>` : ''}
        ${b24on ? `<button class="btn" id="btn-b24" title="Создать сделку в Битрикс24">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          В Битрикс24</button>` : ''}
        ${isAdmin ? '<button class="btn btn-danger" id="btn-del-order">Удалить</button>' : ''}
      </div>
    </div>
    <div class="order-grid">
      <div>
        <div class="panel panel-pad">
          <h3>Данные заказа</h3>
          <form id="order-form" class="form-grid">
            <label class="fld span2"><span>Название</span><input name="title" type="text" value="${esc(order.title)}"></label>
            <label class="fld"><span>Клиент</span>
              <select name="client_id"><option value="">— не выбран —</option>${clientOptions(order.client_id)}</select></label>
            <label class="fld"><span>Менеджер</span>
              <select name="manager_id"><option value="">—</option>${managerOptions(order.manager_id)}</select></label>
            <label class="fld"><span>Статус</span>
              <select name="status">${STATUSES.map((s) => `<option value="${s.key}" ${s.key === order.status ? 'selected' : ''}>${s.label}</option>`).join('')}</select></label>
            <label class="fld"><span>Этап производства</span>
              <select name="prod_stage">${PROD_STAGES.map((s) => `<option value="${s.key}" ${s.key === (order.prod_stage || '') ? 'selected' : ''}>${s.label}</option>`).join('')}</select></label>
            <label class="fld"><span>Срок сдачи</span><input name="due_date" type="date" value="${esc(order.due_date)}"></label>
            <label class="fld"><span>Тираж, экз.</span><input name="quantity" type="number" min="0" value="${order.quantity || 0}"></label>
            <label class="fld"><span>Цена за тираж, ₽</span><input name="price" type="number" min="0" step="0.01" value="${order.price || 0}"></label>
            <label class="fld"><span>Себестоимость, ₽</span><input name="cost" type="number" min="0" step="0.01" value="${order.cost || 0}"></label>
            <label class="fld"><span>Вид продукции</span><input type="text" value="${esc(typeLabel(order.product_type))}" disabled></label>
            <label class="fld span2"><span>Заметки</span><textarea name="notes" rows="3">${esc(order.notes)}</textarea></label>
          </form>
          <div class="toolbar" style="margin-top:14px;justify-content:space-between">
            <span class="muted small">Клиент: ${order.client_id ? `<a href="#/clients/${order.client_id}">${esc(order.client_name || '')}</a>` : '—'}
              · Создан ${fmtDateTime(order.created_at)} · Обновлён ${fmtDateTime(order.updated_at)}</span>
            <button class="btn btn-primary" id="btn-save-order">Сохранить</button>
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
    </div>`;

  // калькуляция
  const calcBox = $('#calc-content', box);
  if (calc && (calc.priceTotal != null || calc.ok)) {
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
    try {
      await api('/api/orders/' + id, {
        method: 'PUT',
        body: {
          title: f.get('title'), client_id: Number(f.get('client_id')) || null,
          manager_id: Number(f.get('manager_id')) || null, status: f.get('status'),
          due_date: f.get('due_date') || '', quantity: Number(f.get('quantity')) || 0,
          price: Number(f.get('price')) || 0, cost: Number(f.get('cost')) || 0,
          notes: f.get('notes') || '', prod_stage: f.get('prod_stage') ?? undefined,
        },
      });
      toast('Заказ сохранён', 'ok');
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
      const rows = (calc.materials || []).map((mt) => ({
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
            Списание попадёт в историю заказа и в движения склада. Отрицательный остаток допускается —
            это сигнал, что материал надо оприходовать.</div>`,
        footer: `<button class="btn" data-act="cancel">Отмена</button>
                 <button class="btn btn-primary" data-act="save">Списать</button>`,
      });
      $('[data-act="cancel"]', m.foot).onclick = m.close;
      $('[data-act="save"]', m.foot).onclick = async () => {
        let done = 0;
        try {
          for (const inp of $$('input[data-i]', m.body)) {
            const r = rows[Number(inp.dataset.i)];
            const q = Number(String(inp.value).replace(',', '.'));
            if (!r.s || !q || q <= 0) continue;
            await api(`/api/stock/${r.s.id}/move`, {
              method: 'POST',
              body: { qty: -q, order_id: order.id, reason: `Заказ № ${order.number}` },
            });
            done++;
          }
          m.close();
          if (done) { toast(`Списано позиций: ${done}`, 'ok'); renderRoute(); }
          else toast('Нечего списывать', 'error');
        } catch (e) { toastErr(e); }
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

function stockMoveDialog(mat, dir, onDone) {
  const m = openModal({
    title: (dir > 0 ? 'Приход: ' : 'Списание: ') + mat.name,
    body: `
      <form id="stock-move-form" style="display:flex;flex-direction:column;gap:13px">
        <div class="muted">Остаток сейчас: <b>${fmtNum(mat.qty)} ${esc(mat.unit)}</b></div>
        <label class="fld"><span>Количество, ${esc(mat.unit)} *</span>
          <input name="qty" type="number" step="any" min="0" required></label>
        <label class="fld"><span>Комментарий</span>
          <input name="reason" type="text" placeholder="${dir > 0 ? 'Например: поставка бумаги' : 'Например: заказ № 2026-0012'}"></label>
      </form>`,
    footer: `<button class="btn" data-act="cancel">Отмена</button>
             <button class="btn btn-primary" data-act="save">${dir > 0 ? 'Оприходовать' : 'Списать'}</button>`,
  });
  const form = $('#stock-move-form', m.body);
  async function submit() {
    if (!form.reportValidity()) return;
    const f = new FormData(form);
    const qty = Number(String(f.get('qty')).replace(',', '.'));
    if (!qty || qty <= 0) { toast('Укажите количество больше нуля', 'error'); return; }
    try {
      await api(`/api/stock/${mat.id}/move`, { method: 'POST', body: { qty: dir * qty, reason: f.get('reason') || '' } });
      m.close();
      toast(dir > 0 ? 'Приход оформлен' : 'Списано', 'ok');
      onDone && onDone();
    } catch (e) { toastErr(e); }
  }
  $('[data-act="cancel"]', m.foot).onclick = m.close;
  $('[data-act="save"]', m.foot).onclick = submit;
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
}

function stockMaterialDialog(mat, onDone) {
  const v = mat || {};
  const m = openModal({
    title: mat ? 'Материал: ' + mat.name : 'Новый материал',
    body: `
      <form id="stock-mat-form" style="display:flex;flex-direction:column;gap:13px">
        <label class="fld"><span>Название *</span><input name="name" type="text" value="${esc(v.name || '')}" required></label>
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
    };
    try {
      if (mat) await api('/api/stock/' + mat.id, { method: 'PUT', body });
      else await api('/api/stock', { method: 'POST', body: { ...body, qty: Number(f.get('qty')) || 0 } });
      m.close();
      toast('Сохранено', 'ok');
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
        <thead><tr><th>Когда</th><th class="num">Кол-во</th><th>Заказ</th><th>Кто</th><th>Комментарий</th></tr></thead>
        <tbody>
          ${moves.map((mv) => `
            <tr>
              <td class="muted small">${fmtDateTime(mv.created_at)}</td>
              <td class="num" style="color:${mv.qty > 0 ? '#0a7d34' : '#C4156A'};font-weight:600">${mv.qty > 0 ? '+' : ''}${fmtNum(mv.qty)} ${esc(mat.unit)}</td>
              <td>${mv.order_id ? `<a href="#/orders/${mv.order_id}">№ ${esc(mv.order_number || mv.order_id)}</a>` : '—'}</td>
              <td>${esc(mv.user_name || '—')}</td>
              <td class="muted">${esc(mv.reason || '')}</td>
            </tr>`).join('')}
        </tbody>
      </table></div>` : '<div class="muted">Движений ещё не было</div>',
  });
}

views.stock = async function (box) {
  const isAdmin = state.user.role === 'admin';
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
    const lowCount = rows.filter(stockLow).length;
    if (filters.q) {
      const q = filters.q.toLowerCase();
      rows = rows.filter((r) => r.name.toLowerCase().includes(q));
    }
    if (filters.low) rows = rows.filter(stockLow);
    body.innerHTML = `
      ${lowCount ? `<div class="warn-box" style="margin-bottom:12px"><b>Заканчивается:</b> позиций с остатком ниже минимума — ${lowCount}</div>` : ''}
      <div class="panel tbl-wrap">
        <table class="tbl">
          <thead><tr>
            <th>Материал</th><th>Ед. учёта</th><th class="num">Остаток</th><th class="num">Минимум</th>
            <th>Движение</th><th style="width:${isAdmin ? 300 : 230}px"></th>
          </tr></thead>
          <tbody>
            ${rows.length ? rows.map((r) => `
              <tr data-id="${r.id}">
                <td><b>${esc(r.name)}</b>${r.notes ? `<div class="muted small">${esc(r.notes)}</div>` : ''}</td>
                <td class="muted">${esc(r.unit)}</td>
                <td class="num" style="font-weight:700;${r.qty < 0 || stockLow(r) ? 'color:#C4156A' : ''}">
                  ${fmtNum(r.qty)}${stockLow(r) ? ' <span class="badge st-cancelled">мало</span>' : ''}</td>
                <td class="num muted">${r.min_qty ? fmtNum(r.min_qty) : '—'}</td>
                <td class="muted small">${r.last_move ? fmtDateTime(r.last_move) : '—'}</td>
                <td>
                  <div class="toolbar" style="justify-content:flex-end">
                    <button class="btn btn-sm st-in">+ Приход</button>
                    <button class="btn btn-sm st-out">− Списать</button>
                    <button class="btn btn-sm btn-ghost st-hist" title="История движений">История</button>
                    ${isAdmin ? '<button class="btn btn-sm btn-ghost st-edit" title="Изменить">✎</button><button class="btn btn-sm btn-ghost st-del" title="Удалить">✕</button>' : ''}
                  </div>
                </td>
              </tr>`).join('') : '<tr><td colspan="6" class="empty-note">Материалов не найдено</td></tr>'}
          </tbody>
        </table>
      </div>`;

    $$('tbody tr[data-id]', body).forEach((tr) => {
      const mat = rows.find((r) => String(r.id) === tr.dataset.id);
      if (!mat) return;
      $('.st-in', tr).addEventListener('click', () => stockMoveDialog(mat, +1, refresh));
      $('.st-out', tr).addEventListener('click', () => stockMoveDialog(mat, -1, refresh));
      $('.st-hist', tr).addEventListener('click', () => stockHistoryDialog(mat).catch(toastErr));
      const ed = $('.st-edit', tr);
      if (ed) ed.addEventListener('click', () => stockMaterialDialog(mat, refresh));
      const del = $('.st-del', tr);
      if (del) del.addEventListener('click', async () => {
        if (!await confirmDlg(`Удалить материал «${mat.name}» вместе с историей движений?`)) return;
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
      <button class="btn btn-primary" id="btn-new-client">+ Новый клиент</button>
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
            <th class="num">Заказов</th><th class="num">Сумма заказов</th>
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
                <td class="num">${c.orders_total ? fmtMoney(c.orders_total) : '—'}</td>
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
        <button class="btn" id="btn-edit-client">Редактировать</button>
        <button class="btn btn-primary" id="btn-client-order">+ Новый заказ</button>
        ${client.orders_count === 0 ? '<button class="btn btn-danger" id="btn-del-client">Удалить</button>' : ''}
      </div>
    </div>
    <div class="order-grid">
      <div>
        <div class="panel tbl-wrap">
          <table class="tbl">
            <thead><tr><th>№</th><th>Название</th><th>Статус</th><th class="num">Сумма</th><th>Срок</th></tr></thead>
            <tbody>
              ${orders.length ? orders.map((o) => `
                <tr class="clickable" data-id="${o.id}">
                  <td class="mono">${esc(o.number)}</td>
                  <td><b>${esc(o.title || typeLabel(o.product_type))}</b></td>
                  <td>${statusBadge(o.status)}</td>
                  <td class="num">${o.price ? fmtMoney(o.price) : '—'}</td>
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
            <dt>Заказов</dt><dd>${client.orders_count} на ${fmtMoney(client.orders_total)}</dd>
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

views.settings = async function (box) {
  box.innerHTML = `
    <div class="tabs settings-tabs">
      <button data-tab="users" class="active">Пользователи</button>
      <button data-tab="pricing">Справочники цен</button>
      <button data-tab="integrations">Интеграции</button>
    </div>
    <div id="settings-body"></div>`;
  const body = $('#settings-body', box);
  let tab = 'users';

  $$('.settings-tabs button', box).forEach((b) => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    $$('.settings-tabs button', box).forEach((x) => x.classList.toggle('active', x === b));
    render();
  }));

  function userDialog(user) {
    const u = user || {};
    const m = openModal({
      title: user ? 'Пользователь: ' + user.name : 'Новый пользователь',
      body: `
        <form id="user-form" style="display:flex;flex-direction:column;gap:13px">
          ${user ? '' : '<label class="fld"><span>Логин *</span><input name="login" type="text" required autocomplete="off"></label>'}
          <label class="fld"><span>Имя *</span><input name="name" type="text" value="${esc(u.name || '')}" required></label>
          <label class="fld"><span>Роль</span>
            <select name="role">
              <option value="manager" ${u.role !== 'admin' ? 'selected' : ''}>Менеджер</option>
              <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Руководитель</option>
            </select></label>
          ${user ? `
            <label class="check-fld"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}><span>Активен (может входить в систему)</span></label>
            <label class="fld"><span>Новый пароль (оставьте пустым — без изменений)</span><input name="password" type="password" autocomplete="new-password"></label>`
          : '<label class="fld"><span>Пароль *</span><input name="password" type="password" required autocomplete="new-password"></label>'}
        </form>`,
      footer: `<button class="btn" data-act="cancel">Отмена</button>
               <button class="btn btn-primary" data-act="save">${user ? 'Сохранить' : 'Добавить'}</button>`,
    });
    const form = $('#user-form', m.body);
    async function submit() {
      if (!form.reportValidity()) return;
      const f = new FormData(form);
      try {
        if (user) {
          await api('/api/users/' + user.id, {
            method: 'PUT',
            body: { name: f.get('name'), role: f.get('role'), active: !!f.get('active'), password: f.get('password') || undefined },
          });
        } else {
          await api('/api/users', {
            method: 'POST',
            body: { login: f.get('login'), name: f.get('name'), role: f.get('role'), password: f.get('password') },
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
    body.innerHTML = `
      <div class="page-head">
        <h2>Пользователи системы</h2>
        <button class="btn btn-primary" id="btn-new-user">+ Добавить пользователя</button>
      </div>
      <div class="panel tbl-wrap">
        <table class="tbl">
          <thead><tr><th>Имя</th><th>Логин</th><th>Роль</th><th>Статус</th><th></th></tr></thead>
          <tbody>
            ${users.map((u) => `
              <tr data-id="${u.id}" ${u.active ? '' : 'style="opacity:.55"'}>
                <td><b>${esc(u.name)}</b></td>
                <td class="mono">${esc(u.login)}</td>
                <td>${u.role === 'admin' ? 'Руководитель' : 'Менеджер'}</td>
                <td>${u.active ? '<span class="badge st-ready">Активен</span>' : '<span class="badge st-cancelled">Отключён</span>'}</td>
                <td style="width:120px"><button class="btn btn-sm u-edit">Изменить</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    $('#btn-new-user', body).addEventListener('click', () => userDialog());
    $$('tbody tr', body).forEach((tr) => {
      $('.u-edit', tr).addEventListener('click', () =>
        userDialog(users.find((u) => String(u.id) === tr.dataset.id)));
    });
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
    coverExtraSheets: 'Доп. листы на обложку, шт.', setupSheetsPerInk: 'Приладка на краску, листов',
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

  /* --- рекурсивный редактор справочников --- */
  const isObj = (v) => v !== null && typeof v === 'object';

  function cfgInput(value, path) {
    const p = esc(JSON.stringify(path));
    if (typeof value === 'number') return `<input type="number" step="any" value="${value}" data-path="${p}" data-type="number">`;
    if (typeof value === 'boolean') return `<input type="checkbox" ${value ? 'checked' : ''} data-path="${p}" data-type="boolean">`;
    return `<input type="text" value="${esc(value)}" data-path="${p}" data-type="string">`;
  }

  function cfgRender(obj, path, level) {
    const prims = [], objs = [];
    for (const [k, v] of Object.entries(obj)) (isObj(v) ? objs : prims).push([k, v]);

    let html = '';
    if (prims.length) {
      html += `<table class="cfg-table">${prims.map(([k, v]) =>
        `<tr><td class="k">${esc(cfgLabel(k))}</td><td>${cfgInput(v, path.concat(k))}</td></tr>`).join('')}</table>`;
    }

    // если все вложенные объекты «плоские» — рисуем матрицей: строки-ключи, колонки-поля
    const flatChildren = objs.length > 1 && objs.every(([, v]) => Object.values(v).every((x) => !isObj(x)));
    if (flatChildren) {
      const cols = [...new Set(objs.flatMap(([, v]) => Object.keys(v)))];
      html += `<table class="cfg-table">
        <tr><td class="k"></td>${cols.map((c) => `<td class="k">${esc(cfgLabel(c))}</td>`).join('')}</tr>
        ${objs.map(([k, v]) => `<tr><td class="k">${esc(cfgLabel(k))}</td>${cols.map((c) =>
          `<td>${c in v ? cfgInput(v[c], path.concat(k, c)) : ''}</td>`).join('')}</tr>`).join('')}
      </table>`;
    } else {
      for (const [k, v] of objs) {
        html += `<div class="cfg-sub"><h4 style="font-size:12.5px;margin-bottom:6px">${esc(cfgLabel(k))}</h4>${cfgRender(v, path.concat(k), level + 1)}</div>`;
      }
    }
    return html;
  }

  async function renderPricing() {
    const cfg = await api('/api/pricing/config');
    body.innerHTML = `
      <div class="page-head">
        <h2>Справочники цен (у.е., перенос из Excel)</h2>
        <div class="toolbar">
          <button class="btn btn-danger" id="btn-cfg-reset">Сбросить к исходным из Excel</button>
          <button class="btn btn-primary" id="btn-cfg-save">Сохранить</button>
        </div>
      </div>
      <div class="panel panel-pad" id="cfg-root">
        ${Object.entries(cfg).map(([k, v]) => `
          <div class="cfg-section">
            <h4>${esc(cfgLabel(k))}</h4>
            ${isObj(v) ? cfgRender(v, [k], 0) : `<table class="cfg-table"><tr><td class="k">${esc(cfgLabel(k))}</td><td>${cfgInput(v, [k])}</td></tr></table>`}
          </div>`).join('')}
      </div>`;

    $('#btn-cfg-save', body).addEventListener('click', async () => {
      const next = structuredClone(cfg);
      let bad = null;
      $$('#cfg-root [data-path]', body).forEach((inp) => {
        const path = JSON.parse(inp.dataset.path);
        let val;
        if (inp.dataset.type === 'number') {
          val = parseFloat(String(inp.value).replace(',', '.'));
          if (!isFinite(val)) { bad = path.join(' → '); return; }
        } else if (inp.dataset.type === 'boolean') val = inp.checked;
        else val = inp.value;
        let t = next;
        for (let i = 0; i < path.length - 1; i++) t = t[path[i]];
        t[path[path.length - 1]] = val;
      });
      if (bad) { toast('Некорректное число: ' + bad, 'error'); return; }
      try {
        await api('/api/pricing/config', { method: 'PUT', body: next });
        state.schema = null;
        toast('Справочники сохранены', 'ok');
      } catch (e) { toastErr(e); }
    });

    $('#btn-cfg-reset', body).addEventListener('click', async () => {
      if (!await confirmDlg('Сбросить все справочники к исходным значениям из Excel?', 'Сбросить')) return;
      try {
        await api('/api/pricing/config/reset', { method: 'POST' });
        state.schema = null;
        toast('Справочники сброшены', 'ok');
        renderPricing();
      } catch (e) { toastErr(e); }
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

  function render() {
    const fn = tab === 'users' ? renderUsers : tab === 'pricing' ? renderPricing : renderIntegrations;
    fn().catch((e) => { body.innerHTML = `<div class="form-error">${esc(e.message)}</div>`; });
  }
  render();
};

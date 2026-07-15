'use strict';
/* Калькулятор продукции (форма строится по /api/pricing/schema) и печать КП */

const BREAKDOWN_LABELS = { materials: 'Материалы', print: 'Печать', binding: 'Переплёт', postpress: 'Постпечать', total: 'Итого' };
const VARIANT_LABELS = { offset: 'Офсет', digital: 'Цифра', inkjet: 'Струйная' };

/* Итог расчёта → HTML (используется и в калькуляторе, и в карточке заказа) */
function calcResultHTML(calc) {
  if (!calc) return '';
  let html = `
    <div class="result-tiles">
      <div class="tile t-main"><div class="t-label">Цена за тираж</div><div class="t-value">${fmtMoney(calc.priceTotal)}</div></div>
      <div class="tile"><div class="t-label">Цена за экземпляр</div><div class="t-value">${fmtMoney(calc.pricePerItem)}</div></div>
      <div class="tile"><div class="t-label">Себестоимость</div><div class="t-value">${fmtMoney(calc.cost)}</div></div>
      <div class="tile"><div class="t-label">Тираж</div><div class="t-value">${fmtNum(calc.quantity)} экз.</div></div>
    </div>`;

  if (calc.discountFactor != null && Number(calc.discountFactor) !== 1) {
    html += `<div class="muted small" style="margin-bottom:10px">Коэффициент скидки/наценки: ${fmtNum(calc.discountFactor)}</div>`;
  }

  if (calc.warnings && calc.warnings.length) {
    html += `<div class="warn-box"><b>Внимание:</b><ul>${calc.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`;
  }

  if (calc.breakdown && Object.keys(calc.breakdown).length) {
    html += `
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>Составляющая</th><th class="num">Сумма</th></tr></thead>
        <tbody>
          ${Object.entries(calc.breakdown).map(([k, v]) => `
            <tr><td>${esc(BREAKDOWN_LABELS[k] || k)}</td><td class="num">${fmtMoney(v)}</td></tr>`).join('')}
        </tbody>
      </table></div>`;
  }

  if (calc.variants && Object.keys(calc.variants).length) {
    const keys = Object.keys(calc.variants);
    const rows = [['priceTotal', 'Цена за тираж'], ['pricePerItem', 'За экземпляр'], ['cost', 'Себестоимость']]
      .filter(([f]) => keys.some((k) => calc.variants[k] && calc.variants[k][f] != null));
    html += `
      <h3 style="margin:16px 0 10px">Сравнение способов печати</h3>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th></th>${keys.map((k) => `<th class="num">${esc(VARIANT_LABELS[k] || k)}</th>`).join('')}</tr></thead>
        <tbody>
          ${rows.map(([f, label]) => `
            <tr><td>${label}</td>${keys.map((k) => {
              const v = calc.variants[k] && calc.variants[k][f];
              return `<td class="num">${v != null ? fmtMoney(v) : '—'}</td>`;
            }).join('')}</tr>`).join('')}
        </tbody>
      </table></div>`;
  }

  if (calc.materials && calc.materials.length) {
    html += `
      <h3 style="margin:16px 0 10px">Материалы на тираж</h3>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>Материал</th><th class="num">Кол-во</th><th>Ед.</th><th>Назначение</th></tr></thead>
        <tbody>
          ${calc.materials.map((m) => `
            <tr><td>${esc(m.name)}</td><td class="num">${fmtNum(Math.ceil(m.qty * 100) / 100)}</td>
                <td>${esc(m.unit)}</td><td class="muted">${esc(m.what || '')}</td></tr>`).join('')}
        </tbody>
      </table></div>`;
  }

  if (calc.details && calc.details.length) {
    html += `
      <h3 style="margin:16px 0 10px">Детали расчёта</h3>
      <div class="tbl-wrap"><table class="tbl">
        <tbody>
          ${calc.details.map((d) => `
            <tr><td>${esc(d.label)}</td>
                <td class="num">${typeof d.value === 'number' ? fmtNum(d.value) : esc(d.value)}${d.unit ? ' ' + esc(d.unit) : ''}</td></tr>`).join('')}
        </tbody>
      </table></div>`;
  }
  return html;
}

/* Параметры заказа → читабельный список по schema */
function paramsListHTML(type, params) {
  const entries = Object.entries(params || {});
  if (!entries.length) return '<div class="muted">Нет параметров</div>';
  const t = state.schema && state.schema.types.find((x) => x.key === type);
  const rows = entries.map(([k, v]) => {
    const f = t && t.fields.find((x) => x.key === k);
    const label = f ? f.label : k;
    let val;
    if (typeof v === 'boolean') val = v ? 'Да' : 'Нет';
    else if (typeof v === 'number') val = fmtNum(v) + (f && f.unit ? ' ' + f.unit : '');
    else val = String(v);
    return `<dt>${esc(label)}</dt><dd>${esc(val)}</dd>`;
  });
  return `<dl class="info-list">${rows.join('')}</dl>`;
}

/* ================= КАЛЬКУЛЯТОР ================= */

views.calc = async function (box, arg, query) {
  const schema = await loadSchema();
  const cfg = await api('/api/pricing/config');
  await Promise.all([loadClients(), loadUsers()]);
  if (!schema.types.length) { box.innerHTML = '<div class="form-error">Схема калькуляторов пуста</div>'; return; }

  const orderId = query.get('order');
  let order = null, orderParams = null;
  if (orderId) {
    order = await api('/api/orders/' + orderId);
    orderParams = safeParse(order.params_json);
  }
  let type = query.get('type') || (order && order.product_type) || schema.types[0].key;
  if (!schema.types.find((t) => t.key === type)) type = schema.types[0].key;
  let lastResult = null;
  let lastParams = null;

  box.innerHTML = `
    ${order ? `<div class="panel panel-pad" style="margin-bottom:14px;background:var(--accent-light);border-color:#F5BBD7">
        Калькуляция для заказа <a href="#/orders/${order.id}"><b>№ ${esc(order.number)}</b></a> — ${esc(order.title || '')}.
        После расчёта нажмите «Обновить заказ».</div>` : ''}
    <div class="tabs" id="calc-tabs">
      ${schema.types.map((t) => `<button data-type="${t.key}" class="${t.key === type ? 'active' : ''}">${esc(typeLabel(t.key))}</button>`).join('')}
    </div>
    <div class="muted small" style="margin:-8px 0 14px">
      Курс у.е.: материалы <b>${fmtMoney(cfg.currency.materials)}</b> · работы <b>${fmtMoney(cfg.currency.works)}</b>
      ${state.user && state.user.role === 'admin' ? ' — <a href="#/settings?tab=pricing">изменить в настройках</a>' : ''}
    </div>
    <div class="calc-grid">
      <div class="panel panel-pad">
        <h3>Параметры</h3>
        <form id="calc-form" class="calc-form"></form>
        <div class="calc-actions">
          <button class="btn btn-primary" id="btn-calc">Рассчитать</button>
        </div>
      </div>
      <div class="panel panel-pad">
        <h3>Результат</h3>
        <div id="calc-result"><div class="muted">Заполните параметры и нажмите «Рассчитать»</div></div>
        <div class="calc-actions">
          <button class="btn btn-primary" id="btn-kp-calc" disabled title="Распечатать или сохранить в PDF без создания заказа">Коммерческое предложение</button>
          <button class="btn" id="btn-save-new" disabled>Сохранить в новый заказ</button>
          ${order ? `<button class="btn btn-primary" id="btn-save-order" disabled>Обновить заказ № ${esc(order.number)}</button>` : ''}
        </div>
      </div>
    </div>`;

  const form = $('#calc-form', box);
  const resultBox = $('#calc-result', box);

  function currentFields() {
    return schema.types.find((t) => t.key === type).fields || [];
  }

  function fieldHTML(f, preset) {
    const val = preset !== undefined ? preset : f.default;
    const unit = f.unit ? ` <span class="unit">(${esc(f.unit)})</span>` : '';
    if (f.type === 'checkbox') {
      return `<label class="check-fld" data-field="${esc(f.key)}">
        <input type="checkbox" name="${esc(f.key)}" ${val ? 'checked' : ''}>
        <span>${esc(f.label)}${unit}</span></label>`;
    }
    if (f.type === 'select') {
      const opts = (f.options || []).map((o) =>
        `<option value="${esc(o)}" ${String(o) === String(val ?? '') ? 'selected' : ''}>${esc(o)}</option>`).join('');
      return `<label class="fld" data-field="${esc(f.key)}"><span>${esc(f.label)}${unit}</span>
        <select name="${esc(f.key)}">${opts}</select></label>`;
    }
    // number по умолчанию
    return `<label class="fld" data-field="${esc(f.key)}"><span>${esc(f.label)}${unit}</span>
      <input type="number" name="${esc(f.key)}"
        ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''}
        step="${f.step != null ? f.step : 'any'}" value="${val != null ? esc(val) : ''}"></label>`;
  }

  function renderForm() {
    const fields = currentFields();
    const usePreset = order && order.product_type === type && orderParams && Object.keys(orderParams).length;
    let html = '', group = null;
    for (const f of fields) {
      if (f.group && f.group !== group) { html += `<div class="calc-group-title">${esc(f.group)}</div>`; group = f.group; }
      html += fieldHTML(f, usePreset ? orderParams[f.key] : undefined);
    }
    form.innerHTML = html || '<div class="muted">Для этого вида продукции нет параметров</div>';
    form.addEventListener('input', applyShowIf);
    form.addEventListener('change', applyShowIf);
    applyShowIf();
  }

  function rawValue(f) {
    const el = form.elements[f.key];
    if (!el) return undefined;
    if (f.type === 'checkbox') return el.checked;
    if (f.type === 'number') return el.value === '' ? null : Number(el.value);
    return el.value;
  }

  function matches(cond, val) {
    const eq = (a, b) => a === b || String(a) === String(b);
    return Array.isArray(cond) ? cond.some((c) => eq(c, val)) : eq(cond, val);
  }

  function isVisible(f, fields) {
    if (!f.showIf) return true;
    return Object.entries(f.showIf).every(([depKey, cond]) => {
      const dep = fields.find((x) => x.key === depKey);
      if (!dep) return true;
      if (!isVisible(dep, fields)) return false; // скрытый управляющий скрывает зависимые
      return matches(cond, rawValue(dep));
    });
  }

  function applyShowIf() {
    const fields = currentFields();
    for (const f of fields) {
      const wrap = $(`[data-field="${CSS.escape(f.key)}"]`, form);
      if (wrap) wrap.classList.toggle('hidden', !isVisible(f, fields));
    }
    // заголовки групп без видимых полей прячем
    $$('.calc-group-title', form).forEach((g) => {
      let el = g.nextElementSibling, any = false;
      while (el && !el.classList.contains('calc-group-title')) {
        if (el.dataset && el.dataset.field && !el.classList.contains('hidden')) { any = true; break; }
        el = el.nextElementSibling;
      }
      g.classList.toggle('hidden', !any);
    });
  }

  function collectParams() {
    const fields = currentFields();
    const out = {};
    for (const f of fields) {
      if (!isVisible(f, fields)) continue;
      const v = rawValue(f);
      if (v !== undefined && v !== null && v !== '') out[f.key] = v;
      else if (f.type === 'checkbox') out[f.key] = false;
    }
    return out;
  }

  function setSaveEnabled(on) {
    $('#btn-save-new', box).disabled = !on;
    $('#btn-kp-calc', box).disabled = !on;
    const b = $('#btn-save-order', box);
    if (b) b.disabled = !on;
  }

  async function calculate() {
    const params = collectParams();
    const btn = $('#btn-calc', box);
    btn.disabled = true;
    try {
      lastResult = await api('/api/calc/' + type, { method: 'POST', body: params });
      lastParams = params;
      resultBox.innerHTML = calcResultHTML(lastResult);
      setSaveEnabled(true);
    } catch (e) {
      lastResult = lastParams = null;
      resultBox.innerHTML = `<div class="form-error">${esc(e.message)}</div>`;
      setSaveEnabled(false);
    } finally {
      btn.disabled = false;
    }
  }

  function orderPayload() {
    return {
      product_type: type,
      params: lastParams,
      calc: lastResult,
      price: lastResult.priceTotal || 0,
      cost: lastResult.cost || 0,
      quantity: lastResult.quantity || Number(lastParams.tiraj) || 0,
    };
  }

  function saveNewDialog() {
    if (!lastResult) return;
    const defTitle = `${typeLabel(type)}, тираж ${fmtNum(lastResult.quantity || lastParams.tiraj || 0)} экз.`;
    const m = openModal({
      title: 'Сохранить расчёт в новый заказ',
      body: `
        <form id="calc-save-form" style="display:flex;flex-direction:column;gap:13px">
          <label class="fld"><span>Клиент *</span>
            <select name="client_id" required><option value="">— выберите —</option>${clientOptions()}</select></label>
          <label class="fld"><span>Название заказа</span><input name="title" type="text" value="${esc(defTitle)}"></label>
          <label class="fld"><span>Срок сдачи</span><input name="due_date" type="date"></label>
          <label class="fld"><span>Менеджер</span><select name="manager_id">${managerOptions(state.user.id)}</select></label>
          <div class="tile t-main"><div class="t-label">Цена за тираж</div><div class="t-value">${fmtMoney(lastResult.priceTotal)}</div></div>
        </form>`,
      footer: `<button class="btn" data-act="cancel">Отмена</button>
               <button class="btn btn-primary" data-act="save">Создать заказ</button>`,
    });
    const form2 = $('#calc-save-form', m.body);
    async function submit() {
      if (!form2.reportValidity()) return;
      const f = new FormData(form2);
      try {
        const r = await api('/api/orders', {
          method: 'POST',
          body: {
            ...orderPayload(),
            client_id: Number(f.get('client_id')) || null,
            manager_id: Number(f.get('manager_id')) || null,
            title: f.get('title') || defTitle,
            due_date: f.get('due_date') || '',
            status: 'calc',
          },
        });
        m.close();
        toast(`Заказ №${r.number} создан`, 'ok');
        navigate('#/orders/' + r.id);
      } catch (e) { toastErr(e); }
    }
    $('[data-act="cancel"]', m.foot).onclick = m.close;
    $('[data-act="save"]', m.foot).onclick = submit;
    form2.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  }

  // Быстрое КП из калькулятора: без создания заказа
  function quickKpDialog() {
    if (!lastResult) return;
    const defTitle = `${typeLabel(type)}, тираж ${fmtNum(lastResult.quantity || lastParams.tiraj || 0)} экз.`;
    const m = openModal({
      title: 'Коммерческое предложение',
      body: `
        <form id="calc-kp-form" style="display:flex;flex-direction:column;gap:13px">
          <label class="fld"><span>Заказчик (как указать в КП)</span>
            <input name="client" type="text" placeholder="Например: ООО «Издательство»"></label>
          <label class="fld"><span>Наименование изделия</span><input name="title" type="text" value="${esc(defTitle)}"></label>
          <div class="tile t-main"><div class="t-label">Цена за тираж</div><div class="t-value">${fmtMoney(lastResult.priceTotal)}</div></div>
          <div class="muted small">Откроется окно печати — выберите принтер или «Сохранить как PDF».
            Заказ при этом не создаётся.</div>
        </form>`,
      footer: `<button class="btn" data-act="cancel">Отмена</button>
               <button class="btn btn-primary" data-act="print">Печать / PDF</button>`,
    });
    $('[data-act="cancel"]', m.foot).onclick = m.close;
    $('[data-act="print"]', m.foot).onclick = () => {
      const f = new FormData($('#calc-kp-form', m.body));
      const d = new Date();
      const num = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
      const pseudo = {
        number: num,
        client_name: f.get('client') || '',
        title: f.get('title') || defTitle,
        product_type: type,
        due_date: '',
        manager_name: state.user.name,
        quantity: lastResult.quantity || Number(lastParams.tiraj) || 0,
        price: lastResult.priceTotal || 0,
      };
      m.close();
      printKP(pseudo, lastResult, lastParams);
    };
  }

  $$('#calc-tabs button', box).forEach((b) => b.addEventListener('click', () => {
    type = b.dataset.type;
    $$('#calc-tabs button', box).forEach((x) => x.classList.toggle('active', x === b));
    lastResult = lastParams = null;
    setSaveEnabled(false);
    resultBox.innerHTML = '<div class="muted">Заполните параметры и нажмите «Рассчитать»</div>';
    renderForm();
  }));

  $('#btn-calc', box).addEventListener('click', (e) => { e.preventDefault(); calculate(); });
  form.addEventListener('submit', (e) => { e.preventDefault(); calculate(); });
  $('#btn-save-new', box).addEventListener('click', saveNewDialog);
  $('#btn-kp-calc', box).addEventListener('click', quickKpDialog);

  const btnUpd = $('#btn-save-order', box);
  if (btnUpd) btnUpd.addEventListener('click', async () => {
    if (!lastResult) return;
    try {
      await api('/api/orders/' + order.id, { method: 'PUT', body: orderPayload() });
      toast(`Заказ № ${order.number} обновлён`, 'ok');
      navigate('#/orders/' + order.id);
    } catch (e) { toastErr(e); }
  });

  renderForm();
};

/* ================= КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ (печать) ================= */

const COMPANY = {
  legal: 'ООО «Радугапринт»',
  brand: 'Типография «Радуга»',
  slogan: 'Печатаем книги и не только уже 25 лет',
  address: 'Москва, Варшавское шоссе, д. 28А (технопарк «Нагатино»)',
  phone: '+7 (495) 161-77-78',
  email: 'mail@raduga-print.ru',
  inn: 'ИНН 7734636152',
};

function printKP(order, calc, params) {
  calc = calc && Object.keys(calc).length ? calc : safeParse(order.calc_json);
  params = params || safeParse(order.params_json);
  const qty = order.quantity || calc.quantity || 0;
  const total = order.price || calc.priceTotal || 0;
  const perItem = calc.pricePerItem || (qty ? total / qty : 0);
  const d = new Date();
  const dateStr = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;

  const t = state.schema && state.schema.types.find((x) => x.key === order.product_type);
  const paramRows = Object.entries(params || {}).map(([k, v]) => {
    const f = t && t.fields.find((x) => x.key === k);
    const label = f ? f.label : k;
    let val;
    if (typeof v === 'boolean') val = v ? 'да' : 'нет';
    else if (typeof v === 'number') val = fmtNum(v) + (f && f.unit ? ' ' + f.unit : '');
    else val = String(v);
    return `<div><span class="pk">${esc(label)}:</span> ${esc(val)}</div>`;
  }).join('');

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

      <h1>Коммерческое предложение № КП-${esc(order.number)}</h1>
      <div class="kp-date">от ${dateStr}</div>

      <div class="kp-block">
        <b class="kp-cap">Заказчик</b>
        ${esc(order.client_name || '—')}
      </div>

      <div class="kp-block">
        <b class="kp-cap">Изделие</b>
        ${esc(order.title || typeLabel(order.product_type))}
        ${order.product_type ? `<span style="color:#666"> — ${esc(typeLabel(order.product_type))}</span>` : ''}
      </div>

      ${paramRows ? `<div class="kp-block"><b class="kp-cap">Параметры изделия</b><div class="kp-params">${paramRows}</div></div>` : ''}

      <table>
        <thead><tr><th>Наименование</th><th>Тираж, экз.</th><th>Цена за экз.</th><th>Сумма</th></tr></thead>
        <tbody>
          <tr>
            <td>${esc(order.title || typeLabel(order.product_type))}</td>
            <td class="num">${fmtNum(qty)}</td>
            <td class="num">${fmtMoney(perItem)}</td>
            <td class="num">${fmtMoney(total)}</td>
          </tr>
        </tbody>
      </table>

      <div class="kp-total">Итого: ${fmtMoney(total)}</div>
      ${order.due_date ? `<div>Ориентировочный срок готовности: ${fmtDate(order.due_date)}</div>` : ''}

      <div class="kp-note">
        Предложение действительно в течение 14 дней с даты выставления.
        Цены указаны в рублях. Окончательная стоимость подтверждается после согласования оригинал-макета.
      </div>

      <div class="kp-sign">
        <div>Менеджер: ${esc(order.manager_name || state.user.name)}<br>
          <span class="kp-slogan">${esc(COMPANY.phone)} · ${esc(COMPANY.email)}</span></div>
        <div>Подпись: <span class="line"></span></div>
      </div>
    </div>`;

  setTimeout(() => window.print(), 60);
}

/* ================= ТЕХЗАДАНИЕ ДЛЯ ПРОИЗВОДСТВА ================= */
/* Печатный наряд без цен: параметры по участкам + данные расчёта + чек-лист этапов */
function printTechTask(order, calc, params) {
  calc = calc && Object.keys(calc).length ? calc : safeParse(order.calc_json);
  params = params || safeParse(order.params_json);
  const d = new Date();
  const dateStr = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  const t = state.schema && state.schema.types.find((x) => x.key === order.product_type);

  // Параметры, сгруппированные по разделам схемы калькулятора (Блок, Обложка, Скрепление…)
  const groups = new Map();
  for (const [k, v] of Object.entries(params || {})) {
    const f = t && t.fields.find((x) => x.key === k);
    if (!f) continue;
    let val;
    if (typeof v === 'boolean') val = v ? 'да' : 'нет';
    else if (typeof v === 'number') val = fmtNum(v) + (f.unit ? ' ' + f.unit : '');
    else val = String(v);
    if (f.key === 'discount') continue; // скидка производству не нужна
    const g = f.group || 'Параметры';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(`<div><span class="pk">${esc(f.label)}:</span> <b>${esc(val)}</b></div>`);
  }
  const groupsHTML = [...groups.entries()].map(([g, rows]) =>
    `<div class="tz-group"><div class="tz-group-title">${esc(g)}</div>${rows.join('')}</div>`).join('');

  // Технологические данные из расчёта (толщина блока, корешок, листы, пружина…)
  // Денежные строки (у.е./руб.) производству не показываем
  const details = (calc.details || []).filter((x) => x.unit !== 'у.е.' && x.unit !== 'руб.').map((x) =>
    `<div><span class="pk">${esc(x.label)}:</span> <b>${typeof x.value === 'number' ? fmtNum(x.value) : esc(x.value)}${x.unit ? ' ' + esc(x.unit) : ''}</b></div>`).join('');

  const warns = (calc.warnings || []).filter((w) => !w.startsWith('Макеты с деталями'));

  $('#print-area').innerHTML = `
    <div class="kp tz">
      <div class="kp-head">
        <div>
          <img src="./logo.webp" alt="raduga">
        </div>
        <div class="kp-requisites">
          <b>ТЕХНИЧЕСКОЕ ЗАДАНИЕ</b><br>
          Заказ № ${esc(order.number)} · от ${dateStr}<br>
          Менеджер: ${esc(order.manager_name || state.user.name)}
        </div>
      </div>
      <div class="kp-rainbow"></div>

      <table class="tz-head-tbl">
        <tr>
          <td><b>Изделие</b><br>${esc(order.title || typeLabel(order.product_type))}</td>
          <td><b>Вид продукции</b><br>${esc(typeLabel(order.product_type) || '—')}</td>
          <td><b>Тираж</b><br><span class="tz-big">${fmtNum(order.quantity || calc.quantity || 0)} экз.</span></td>
          <td><b>Срок сдачи</b><br><span class="tz-big">${order.due_date ? fmtDate(order.due_date) : '—'}</span></td>
        </tr>
      </table>

      <div class="kp-block"><b class="kp-cap">Параметры изделия</b>
        <div class="tz-groups">${groupsHTML || '<div class="pk">нет данных</div>'}</div>
      </div>

      ${details ? `<div class="kp-block"><b class="kp-cap">Технологические данные расчёта</b><div class="kp-params">${details}</div></div>` : ''}

      ${calc.materials && calc.materials.length ? `
        <div class="kp-block"><b class="kp-cap">Материалы на тираж</b>
          <table class="tz-stages">
            <tr><th>Материал</th><th>Кол-во</th><th>Ед.</th><th>Назначение</th></tr>
            ${calc.materials.map((mt) => `
              <tr><td>${esc(mt.name)}</td><td>${fmtNum(Math.ceil(mt.qty * 100) / 100)}</td>
                  <td>${esc(mt.unit)}</td><td>${esc(mt.what || '')}</td></tr>`).join('')}
          </table>
        </div>` : ''}

      ${warns.length ? `<div class="tz-warn"><b>Внимание:</b> ${warns.map(esc).join('; ')}</div>` : ''}

      ${order.notes ? `<div class="kp-block"><b class="kp-cap">Заметки менеджера</b>${esc(order.notes)}</div>` : ''}

      <div class="kp-block"><b class="kp-cap">Отметки о выполнении</b>
        <table class="tz-stages">
          <tr><th>Участок</th><th>Дата</th><th>Исполнитель</th><th>Подпись</th></tr>
          <tr><td>Печать</td><td></td><td></td><td></td></tr>
          <tr><td>Постпечать</td><td></td><td></td><td></td></tr>
          <tr><td>Переплёт / отделка</td><td></td><td></td><td></td></tr>
          <tr><td>Упаковка / ОТК</td><td></td><td></td><td></td></tr>
        </table>
      </div>

      <div class="kp-sign">
        <div>Задание выдал: ${esc(order.manager_name || state.user.name)}</div>
        <div>Подпись: <span class="line"></span></div>
      </div>
    </div>`;

  setTimeout(() => window.print(), 60);
}

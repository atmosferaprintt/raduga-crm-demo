'use strict';
/* Техкарта заказа: маршрут изделия по участкам (схема веток + таблица по участкам).
   Данные приходят готовыми из расчёта (result.techcard), см. pricing/techcard.js */

// Мягкие цвета участков: левая полоса карточки операции и метка участка
const TC_COLORS = ['#E31C79', '#2563eb', '#16a34a', '#ca8a04', '#7c3aed', '#0891b2',
  '#ea580c', '#4f46e5', '#059669', '#db2777', '#65a30d', '#0d9488', '#9333ea', '#b45309'];

function tcAreaColor(tc, areaId) {
  const i = (tc.areas || []).findIndex((a) => a.id === areaId);
  return i < 0 ? '#9ca3af' : TC_COLORS[i % TC_COLORS.length];
}

// 75 → «1 ч 15 мин», 40 → «40 мин»
function fmtMinutes(min) {
  if (min == null || !isFinite(min)) return '—';
  const m = Math.round(min);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60), r = m % 60;
  return `${fmtNum(h)} ч${r ? ` ${r} мин` : ''}`;
}

function tcOpTime(o) {
  if (o.timeMin == null) return '—';
  if (o.noNorm) return 'нет нормы';
  return (o.approx ? '≈ ' : '') + fmtMinutes(o.timeMin);
}

/* Полная техкарта для калькулятора и карточки заказа.
   opts.subtitle — пояснение под заголовком (например, «построена по текущим настройкам») */
function techcardHTML(tc, opts = {}) {
  if (!tc) return '';
  if (tc.ok === false) return `<div class="form-error">${esc(tc.error || 'Техкарта не построена')}</div>`;
  const byId = new Map(tc.ops.map((o) => [o.id, o]));
  const T = tc.totals || {};
  const isAdmin = state.user && state.user.role === 'admin';

  const ST = { done: '✓ готово', work: '● в работе', paused: 'пауза', todo: '' };
  const chip = (o) => `
    <div class="tc-op${o.warn ? ' tc-op-warn' : ''}${opts.status && opts.status[o.id] ? ' tc-st-' + opts.status[o.id] : ''}" style="--c:${tcAreaColor(tc, o.areaId)}" title="${esc(
      [o.name, o.machineName && 'машина: ' + o.machineName, o.qtyNote, o.note, o.warn && '⚠ ' + o.warn].filter(Boolean).join('\n'))}">
      <div class="tc-op-area">${esc(o.areaName)}</div>
      <div class="tc-op-name">${esc(o.name)}</div>
      ${o.machineName ? `<div class="tc-op-machine">${esc(o.machineName)}</div>` : ''}
      <div class="tc-op-meta">${fmtNum(o.qty)} ${esc(o.unit)} · ${tcOpTime(o)}</div>
      ${opts.status && ST[opts.status[o.id]] ? `<div class="tc-op-st">${ST[opts.status[o.id]]}</div>` : ''}
    </div>`;

  const lanes = (tc.lanes || []).map((l) => `
    <div class="tc-lane">
      <div class="tc-lane-title">${esc(l.title)}</div>
      <div class="tc-chain">
        ${l.ops.map((id) => chip(byId.get(id))).join('<span class="tc-arrow">→</span>')}
        ${l.intoLabel ? `<span class="tc-into">⇒ ${esc(l.intoLabel)}</span>` : ''}
      </div>
    </div>`).join('');

  // Таблица по участкам: что, сколько, сколько времени, доля цены
  const rows = (tc.areas || []).map((a) => {
    const ops = tc.ops.filter((o) => (o.areaId || '') === (a.id || ''));
    return `
      <tr class="tc-area-row">
        <td colspan="4"><span class="tc-dot" style="background:${tcAreaColor(tc, a.id)}"></span>
          <b>${esc(a.name)}</b>${a.kind === 'outsource' ? ' <span class="muted small">подряд</span>' : ''}
          <span class="muted small">· ${a.ops} опер.</span></td>
        <td class="num"><b>${fmtMinutes(a.timeMin)}</b></td>
        <td></td>
        <td class="num">${a.planCost ? fmtMoney(a.planCost) : ''}</td>
      </tr>
      ${ops.map((o) => `
        <tr>
          <td>${esc(o.name)}${o.note ? `<div class="tc-sub tc-sub-left">${esc(o.note)}</div>` : ''}${o.warn ? `<div class="tc-note-inline">⚠ ${esc(o.warn)}</div>` : ''}</td>
          <td class="muted">${esc(o.part)}</td>
          <td>${esc(o.machineName || (o.areaKind === 'outsource' ? 'подрядчик' : 'вручную'))}</td>
          <td class="num">${fmtNum(o.qty)} ${esc(o.unit)}${o.qtyNote ? `<div class="tc-sub">${esc(o.qtyNote)}</div>` : ''}</td>
          <td class="num">${tcOpTime(o)}</td>
          <td class="num">${o.priceRub != null ? fmtMoney(o.priceRub) : ''}${o.priceNote ? `<div class="tc-sub">${esc(o.priceNote)}</div>` : ''}</td>
          <td class="num">${o.planCost != null ? fmtMoney(o.planCost) : '<span class="muted">—</span>'}</td>
        </tr>`).join('')}`;
  }).join('');

  const paper = (tc.paper || []).length ? `
    <h4 class="tc-h4">Бумага: по прайсу и в производство</h4>
    <div class="tbl-wrap"><table class="tbl tc-paper">
      <thead><tr><th>Часть</th><th>Бумага</th><th class="num">По прайсу, л. А3</th><th class="num">В цех, л. А3</th><th class="num">≈ кг</th><th class="num">Разница</th></tr></thead>
      <tbody>${tc.paper.map((r) => `
        <tr><td>${esc(r.part)}</td><td>${esc(r.paper)}</td><td class="num">${fmtNum(r.priceSheets)}</td>
          <td class="num"><b>${fmtNum(r.prodSheets)}</b></td><td class="num">${r.prodKg ? fmtNum(r.prodKg) : ''}</td>
          <td class="num">${r.diff > 0 ? `${fmtNum(r.diff)} <span class="muted small">наценка</span>` : '—'}</td></tr>`).join('')}
      </tbody></table></div>` : '';

  const check = Math.abs(T.diff || 0) < 0.05
    ? `<span class="tc-ok">✓ сходится с ценой расчёта</span>`
    : `<span class="overdue">расхождение ${fmtMoney(T.diff)}</span>`;

  return `
    <div class="tc">
      ${opts.subtitle ? `<div class="muted small" style="margin:-6px 0 10px">${esc(opts.subtitle)}</div>` : ''}
      <div class="tc-tiles">
        <div class="tile"><div class="t-label">Операций</div><div class="t-value">${fmtNum(T.ops)}</div></div>
        <div class="tile"><div class="t-label">Участков</div><div class="t-value">${fmtNum((tc.areas || []).length)}</div></div>
        <div class="tile"><div class="t-label">Работы по плану</div><div class="t-value">${fmtMinutes(T.timeMin)}</div></div>
        <div class="tile" title="Самая длинная цепочка операций, если участки заняты только этим заказом">
          <div class="t-label">Срок по маршруту</div><div class="t-value">≈ ${fmtMinutes(T.criticalMin)}</div></div>
        <div class="tile"><div class="t-label">Себестоимость (план)</div>
          <div class="t-value">${T.planCost > 0 ? fmtMoney(T.planCost) : '—'}</div></div>
      </div>
      ${(tc.notes || []).length ? `<div class="warn-box"><ul>${tc.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
        ${isAdmin ? '<div style="margin-top:6px"><a href="#/settings?tab=production">Открыть справочник производства →</a></div>' : ''}</div>` : ''}
      <h4 class="tc-h4">Маршрут</h4>
      <div class="tc-lanes">${lanes}</div>
      <h4 class="tc-h4">По участкам</h4>
      <div class="tbl-wrap"><table class="tbl tc-table">
        <thead><tr><th>Операция</th><th>Часть</th><th>Машина</th><th class="num">Объём</th>
          <th class="num">Время</th><th class="num">Цена по прайсу</th><th class="num">Себест. план</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr>
          <td colspan="5">Работы ${fmtMoney(T.priceOps)} + материалы ${fmtMoney(T.priceMaterials)} = ${fmtMoney(T.priceTotal)} · ${check}</td>
          <td class="num">${fmtMoney(T.priceOps)}</td>
          <td class="num">${T.planCost > 0 ? fmtMoney(T.planCost) + (T.planCostComplete ? '' : ' *') : '—'}</td>
        </tr></tfoot>
      </table></div>
      ${T.planCost > 0 && !T.planCostComplete ? '<div class="muted small">* не по всем участкам заданы ставки</div>' : ''}
      ${paper}
    </div>`;
}

/* Техкарта в печатном ТЗ: без цен, по участкам, с графами для отметок цеха */
function techcardPrintHTML(tc) {
  if (!tc || tc.ok === false || !tc.ops) return '';
  const byId = new Map(tc.ops.map((o) => [o.id, o]));
  const route = (tc.lanes || []).map((l) => `
    <div class="tz-route-row"><b>${esc(l.title)}:</b> ${l.ops.map((id) => esc(byId.get(id).name)).join(' → ')}${
      l.intoLabel ? ` <i>⇒ ${esc(l.intoLabel)}</i>` : ''}</div>`).join('');
  const sections = (tc.areas || []).map((a) => {
    const ops = tc.ops.filter((o) => (o.areaId || '') === (a.id || ''));
    return `
      <tr class="tz-area"><td colspan="8"><b>${esc(a.name)}</b>${a.kind === 'outsource' ? ' (подряд)' : ''} · план ${fmtMinutes(a.timeMin)}</td></tr>
      ${ops.map((o) => `
        <tr>
          <td>${esc(o.name)}${o.note ? `<br><small>${esc(o.note)}</small>` : ''}${o.warn ? `<br><small>⚠ ${esc(o.warn)}</small>` : ''}</td>
          <td>${esc(o.part)}</td>
          <td>${esc(o.machineName || '')}</td>
          <td class="num">${fmtNum(o.qty)} ${esc(o.unit)}${o.materials.length ? `<br><small>${o.materials.map((m) =>
            `${esc(m.name)}: ${fmtNum(m.qty)} ${esc(m.unit)}`).join('; ')}</small>` : ''}</td>
          <td class="num">${o.noNorm ? '' : fmtMinutes(o.timeMin)}</td>
          <td></td><td></td><td></td>
        </tr>`).join('')}`;
  }).join('');
  return `
    <div class="kp-block"><b class="kp-cap">Маршрут изделия</b>${route}</div>
    <div class="kp-block"><b class="kp-cap">Операции по участкам</b>
      <table class="tz-stages tz-ops">
        <tr><th>Операция</th><th>Часть</th><th>Машина</th><th>Объём</th><th>План</th>
          <th>Начало</th><th>Окончание</th><th>Исполнитель</th></tr>
        ${sections}
      </table>
      <div class="tz-foot-note">План по нормам из справочника производства${tc.ops.some((o) => o.approx) ? ' (часть норм примерные)' : ''}.
        Срок по маршруту ≈ ${fmtMinutes(tc.totals.criticalMin)} без учёта очередей.</div>
    </div>`;
}

/* Материалы по операциям техкарты, сложенные по наименованию (реальный расход для цеха и склада) */
function techcardMaterials(tc) {
  const out = [];
  for (const o of (tc && tc.ops) || []) {
    for (const m of o.materials || []) {
      const same = out.find((x) => x.name === m.name && x.unit === m.unit);
      if (same) {
        same.qty += m.qty;
        if (m.kg) same.kg = Math.round(((same.kg || 0) + m.kg) * 10) / 10;
        if (!same.what.includes(o.part.toLowerCase())) same.what += ', ' + o.part.toLowerCase();
      } else out.push({ name: m.name, qty: m.qty, unit: m.unit, kg: m.kg || null, what: o.part.toLowerCase() });
    }
  }
  return out;
}

// Виды продукции, для которых строится техкарта
const TC_TYPES = ['books7', 'brochures'];

/* Для заказов, рассчитанных до появления техкарты: строим её по сохранённым параметрам */
async function techcardForOrder(order, calc, params) {
  if (calc && calc.techcard) return { tc: calc.techcard, fresh: false };
  if (!order || !TC_TYPES.includes(order.product_type) || !params || !Object.keys(params).length) return null;
  try {
    const r = await api('/api/calc/' + encodeURIComponent(order.product_type), { method: 'POST', body: params });
    return r && r.techcard ? { tc: r.techcard, fresh: true } : null;
  } catch { return null; }
}

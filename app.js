'use strict';
/* Ядро SPA: утилиты, API, роутер, вход, каркас. Виды регистрируются в window.views */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const _moneyFmt = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const _numFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
function fmtMoney(n) { return _moneyFmt.format(Number(n) || 0) + ' ₽'; }
function fmtNum(n) { return _numFmt.format(Number(n) || 0); }

function fmtDate(s) {
  if (!s) return '';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(s);
}
function fmtDateTime(s) {
  if (!s) return '';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}` : fmtDate(s);
}
function todayISO() { return new Date().toISOString().slice(0, 10); }
function isOverdue(due) { return !!due && due < todayISO(); }

const STATUSES = [
  { key: 'calc', label: 'Расчёт' },
  { key: 'approval', label: 'Согласование' },
  { key: 'production', label: 'Производство' },
  { key: 'ready', label: 'Готов' },
  { key: 'shipped', label: 'Отгружен' },
  { key: 'cancelled', label: 'Отменён' },
];
function statusLabel(key) { return (STATUSES.find((s) => s.key === key) || {}).label || key; }
const PROD_STAGES = [
  { key: '', label: '— вне производства —' },
  { key: 'print', label: 'Печать' },
  { key: 'postpress', label: 'Постпечать' },
  { key: 'binding', label: 'Переплёт / отделка' },
  { key: 'done', label: 'Выполнено' },
];
function prodStageLabel(key) { const s = PROD_STAGES.find((x) => x.key === key); return s ? s.label : key; }

function statusBadge(key) { return `<span class="badge st-${esc(key)}">${esc(statusLabel(key))}</span>`; }

const PURCH_STATUSES = [
  { key: 'draft', label: 'Черновик', badge: 'st-calc' },
  { key: 'ordered', label: 'Заказано', badge: 'st-approval' },
  { key: 'partial', label: 'Частично получено', badge: 'st-production' },
  { key: 'received', label: 'Получено', badge: 'st-ready' },
  { key: 'cancelled', label: 'Отменена', badge: 'st-cancelled' },
];
function purchStatusLabel(key) { return (PURCH_STATUSES.find((s) => s.key === key) || {}).label || key; }
function purchStatusBadge(key) {
  const s = PURCH_STATUSES.find((x) => x.key === key);
  return `<span class="badge ${s ? s.badge : ''}">${esc(s ? s.label : key)}</span>`;
}

// Русские названия видов продукции (fallback, если schema отдаёт технический ключ)
const TYPE_NAMES = {
  books7: 'Книги 7БЦ',
  brochures: 'Брошюры',
  sheets: 'Листовая продукция',
  notebooks: 'Блокноты',
  uv: 'УФ-печать',
  plotter: 'Плоттерная резка',
};
function typeLabel(key) {
  const t = state.schema && state.schema.types.find((x) => x.key === key);
  if (t && t.label && t.label !== key) return t.label;
  return TYPE_NAMES[key] || key || '—';
}

/* ---------- API ---------- */
class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* пустой ответ */ }
  if (res.status === 401 && path !== '/api/login') {
    state.user = null;
    showLogin();
    throw new ApiError('Требуется вход', 401);
  }
  if (!res.ok) throw new ApiError((data && data.error) || `Ошибка запроса (${res.status})`, res.status);
  return data;
}

/* ---------- Состояние и кэши справочников ---------- */
const state = {
  user: null,
  users: null,
  clients: null,
  schema: null,
  suppliers: null,
};

async function loadUsers(force) {
  if (!state.users || force) state.users = await api('/api/users');
  return state.users;
}
async function loadClients(force) {
  if (!state.clients || force) state.clients = await api('/api/clients');
  return state.clients;
}
async function loadSchema(force) {
  if (!state.schema || force) state.schema = await api('/api/pricing/schema');
  return state.schema;
}
async function loadSuppliers(force) {
  if (!state.suppliers || force) state.suppliers = await api('/api/suppliers');
  return state.suppliers;
}

/* ---------- Тосты ---------- */
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' err' : type === 'ok' ? ' ok' : '');
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 3200);
  setTimeout(() => el.remove(), 3600);
}
function toastErr(e) { toast(e && e.message ? e.message : String(e), 'error'); }

/* ---------- Модальные окна ---------- */
function openModal({ title, body, footer, wide }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal${wide ? ' wide' : ''}">
      <div class="modal-head">
        <h3>${esc(title)}</h3>
        <button class="modal-close" title="Закрыть">×</button>
      </div>
      <div class="modal-body"></div>
      <div class="modal-foot"></div>
    </div>`;
  const bodyEl = $('.modal-body', overlay);
  const footEl = $('.modal-foot', overlay);
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
  if (typeof footer === 'string') footEl.innerHTML = footer; else if (footer) footEl.appendChild(footer);
  if (!footer) footEl.remove();

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  $('.modal-close', overlay).addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  $('#modal-root').appendChild(overlay);
  const first = $('input, select, textarea', bodyEl);
  if (first) setTimeout(() => first.focus(), 30);
  return { overlay, body: bodyEl, foot: footEl, close };
}

function confirmDlg(message, okLabel = 'Удалить') {
  return new Promise((resolve) => {
    const m = openModal({
      title: 'Подтверждение',
      body: `<p>${esc(message)}</p>`,
      footer: `<button class="btn" data-act="cancel">Отмена</button>
               <button class="btn btn-danger" data-act="ok">${esc(okLabel)}</button>`,
    });
    $('[data-act="cancel"]', m.foot).onclick = () => { m.close(); resolve(false); };
    $('[data-act="ok"]', m.foot).onclick = () => { m.close(); resolve(true); };
  });
}

/* Селекты справочников */
function clientOptions(selectedId) {
  return (state.clients || []).map((c) =>
    `<option value="${c.id}" ${String(c.id) === String(selectedId ?? '') ? 'selected' : ''}>${esc(c.name)}</option>`
  ).join('');
}
function managerOptions(selectedId) {
  return (state.users || []).filter((u) => u.active).map((u) =>
    `<option value="${u.id}" ${String(u.id) === String(selectedId ?? '') ? 'selected' : ''}>${esc(u.name)}</option>`
  ).join('');
}

function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ---------- Роутер ---------- */
window.views = window.views || {};

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  return { parts, query: new URLSearchParams(queryPart || '') };
}

function navigate(hash) { location.hash = hash; }

const PAGE_TITLES = {
  orders: 'Заказы', order: 'Заказ', calc: 'Калькулятор', production: 'Производство', stock: 'Склад',
  purchases: 'Закупки', purchase: 'Закупка',
  clients: 'Клиенты', client: 'Клиент', tasks: 'Задачи', analytics: 'Аналитика', settings: 'Настройки',
};

let routeSeq = 0;
async function renderRoute() {
  if (!state.user) return;
  const { parts, query } = parseHash();
  let name = parts[0] || 'orders';
  let arg = parts[1] || null;

  let viewName = name;
  if (name === 'orders' && arg) viewName = 'order';
  if (name === 'clients' && arg) viewName = 'client';
  if (name === 'purchases' && arg) viewName = 'purchase';
  if (name === 'settings' && state.user.role !== 'admin') { navigate('#/orders'); return; }
  const view = window.views[viewName];
  if (!view) { navigate('#/orders'); return; }

  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  $('#page-title').textContent = PAGE_TITLES[viewName] || '';

  const main = $('#main');
  const seq = ++routeSeq;
  main.innerHTML = '<div class="empty-note">Загрузка…</div>';
  try {
    const box = document.createElement('div');
    await view(box, arg, query);
    if (seq === routeSeq) { main.innerHTML = ''; main.appendChild(box); }
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return;
    if (seq === routeSeq) main.innerHTML = `<div class="form-error">Ошибка: ${esc(e.message)}</div>`;
    console.error(e);
  }
}

/* ---------- Вход / выход ---------- */
function showLogin() {
  $('#app').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');
  const inp = $('#login-form input[name="login"]');
  if (inp) setTimeout(() => inp.focus(), 50);
}

function showApp() {
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  const u = state.user;
  $('#user-name').textContent = u.name;
  const roleLabel = u.role === 'admin' ? 'Руководитель' : 'Менеджер';
  $('#user-role').textContent = roleLabel === u.name ? '' : roleLabel;
  $('#user-avatar').textContent = (u.name || '?').trim().charAt(0).toUpperCase();
  $('#nav-settings').classList.toggle('hidden', u.role !== 'admin');
  if (!location.hash || location.hash === '#' || location.hash === '#/') location.hash = '#/orders';
  renderRoute();
}

function changePasswordDialog() {
  const m = openModal({
    title: 'Смена пароля',
    body: `
      <form id="pw-form" style="display:flex;flex-direction:column;gap:13px">
        <label class="fld"><span>Старый пароль</span><input type="password" name="old" required autocomplete="current-password"></label>
        <label class="fld"><span>Новый пароль</span><input type="password" name="new1" required minlength="4" autocomplete="new-password"></label>
        <label class="fld"><span>Новый пароль ещё раз</span><input type="password" name="new2" required minlength="4" autocomplete="new-password"></label>
        <div class="form-error hidden" id="pw-error"></div>
      </form>`,
    footer: `<button class="btn" data-act="cancel">Отмена</button>
             <button class="btn btn-primary" data-act="save">Сменить пароль</button>`,
  });
  const form = $('#pw-form', m.body);
  const errEl = $('#pw-error', m.body);
  async function submit() {
    errEl.classList.add('hidden');
    const f = new FormData(form);
    if (f.get('new1') !== f.get('new2')) {
      errEl.textContent = 'Новые пароли не совпадают';
      errEl.classList.remove('hidden');
      return;
    }
    try {
      await api('/api/me/password', { method: 'POST', body: { oldPassword: f.get('old'), newPassword: f.get('new1') } });
      m.close();
      toast('Пароль изменён', 'ok');
    } catch (e) {
      errEl.textContent = e.message;
      errEl.classList.remove('hidden');
    }
  }
  $('[data-act="cancel"]', m.foot).onclick = m.close;
  $('[data-act="save"]', m.foot).onclick = submit;
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
}

async function boot() {
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('#login-error');
    errEl.classList.add('hidden');
    const f = new FormData(e.target);
    try {
      const { user } = await api('/api/login', { method: 'POST', body: { login: f.get('login'), password: f.get('password') } });
      state.user = user;
      state.users = state.clients = state.schema = state.suppliers = null;
      e.target.reset();
      showApp();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });

  $('#btn-logout').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* не критично */ }
    state.user = null;
    location.hash = '';
    showLogin();
  });

  $('#btn-password').addEventListener('click', changePasswordDialog);
  window.addEventListener('hashchange', renderRoute);

  try {
    const { user } = await api('/api/me');
    state.user = user;
    showApp();
  } catch {
    showLogin();
  }
}

document.addEventListener('DOMContentLoaded', boot);

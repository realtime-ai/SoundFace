// SoundFace admin console. Plain JS, no build step. Every number comes from
// /admin/v1/..., which checks the admin allowlist on each request; this page
// only decides what to show. All user-supplied text is set via textContent.
const TOKEN_KEY = 'soundface-admin-token';
const $ = id => document.getElementById(id);
let token = localStorage.getItem(TOKEN_KEY) || '';

// ---------- helpers ----------
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'text') node.textContent = value;
    else if (key === 'style') node.style.cssText = value; // CSSOM: allowed by the page's CSP, unlike style attributes
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child != null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
const TZ = { timeZone: 'Asia/Shanghai' };
const pad = n => String(n).padStart(2, '0');
function parts(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { ...TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(ms).map(x => [x.type, x.value]));
  return p;
}
const fmtTime = ms => { if (!ms) return '—'; const p = parts(ms); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`; };
const fmtDate = ms => { if (!ms) return '—'; const p = parts(ms); return `${p.year}-${p.month}-${p.day}`; };
const today = () => fmtDate(Date.now());
const addDays = (day, n) => fmtDate(Date.parse(day + 'T12:00:00+08:00') + n * 86400000);
const int = n => Number(n || 0).toLocaleString('zh-CN');
// Minutes with at most one decimal; no rounding up of partial minutes in totals.
const minutes = seconds => { const m = Math.round((seconds || 0) / 6) / 10; return m.toLocaleString('zh-CN', { maximumFractionDigits: 1 }); };
const duration = seconds => { seconds = Math.round(seconds || 0); if (seconds < 60) return `${seconds} 秒`; const h_ = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60; return (h_ ? `${h_} 小时 ` : '') + `${m} 分` + (s && !h_ ? ` ${s} 秒` : ''); };
const accountText = id => id?.startsWith('email:') ? id.slice(6) : id?.startsWith('phone:') ? id.slice(6) : id?.startsWith('dev:') ? `开发账号 ${id.slice(4)}` : id || '—';
const accountKind = id => id?.startsWith('email:') ? '邮箱' : id?.startsWith('phone:') ? '手机号' : '开发';
const STATUS = { unused: '未使用', redeemed: '已兑换', expired: '已过期', voided: '已作废' };
const KIND = { trial: '新用户赠送', redeem: '兑换码', admin: '后台调整', usage: '使用扣除' };
const END = { user_hangup: '自己停止', client_lost: '断线后自动停止', quota_reached: '分钟用完自动停止', create_failed: '启动失败' };
const ACTION = { batch_create: '生成兑换码', code_void: '作废单个兑换码', batch_void: '整批作废', adjust: '手动加减分钟', backfill: '重新汇总用户数据' };
const DATE_RULE = '日期按北京时间零点切分。一次使用算在它开始的那一天（包括次数和时长），例如 23:50 开始、第二天 00:10 结束，整次都算前一天。时长从出现第一帧画面开始算，没出画面的那次不计时长。';

async function api(method, path, body) {
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  let data = {}; try { data = await response.json(); } catch { /* empty */ }
  if (response.status === 401 && path.startsWith('/admin/')) { logout('登录已失效，请重新登录。'); throw Object.assign(new Error(data.message || '请先登录'), { quiet: true }); }
  if (!response.ok) throw Object.assign(new Error(data.message || `出错了（${response.status}）`), { status: response.status, code: data.code });
  return data;
}
function toast(text, error = false) {
  const node = $('toast'); node.textContent = text; node.className = 'toast' + (error ? ' error' : ''); node.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { node.hidden = true; }, error ? 5000 : 2500);
}
// In-page confirm (native confirm() would block automation and screenshots).
function confirmBox(title, text, okText = '确定', danger = true) {
  const dialog = $('confirm');
  $('confirm-title').textContent = title; $('confirm-text').textContent = text;
  $('confirm-ok').textContent = okText; $('confirm-ok').className = danger ? 'danger' : '';
  dialog.returnValue = ''; dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true }));
}
function downloadCsv(name, rows) {
  const csv = '﻿' + rows.map(row => row.map(cell => { const s = String(cell ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const area = h('textarea', { style: 'position:fixed;opacity:0' }); area.value = text; document.body.append(area); area.select();
    const done = document.execCommand('copy'); area.remove(); return done;
  }
}
const table = (headers, rows, empty = '暂无数据', foot) => h('div', { class: 'table-wrap' }, h('table', {},
  h('thead', {}, h('tr', {}, headers.map(item => typeof item === 'string' ? h('th', {}, item) : h('th', { class: item.class }, item.text)))),
  h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { class: 'empty', colspan: headers.length }, empty))),
  foot ? h('tfoot', {}, foot) : null));
const statusPill = status => h('span', { class: 'pill ' + status }, STATUS[status] || status);
const signed = seconds => h('span', { class: seconds < 0 ? 'minus' : 'plus' }, (seconds < 0 ? '−' : '+') + minutes(Math.abs(seconds)) + ' 分钟');

// ---------- login ----------
function showLogin(message = '', error = false) {
  $('app-view').hidden = true; $('login-view').hidden = false;
  $('login-message').textContent = message; $('login-message').className = 'message' + (error ? ' error' : '');
}
function logout(message = '') { token = ''; localStorage.removeItem(TOKEN_KEY); showLogin(message, !!message); }
$('login-send').addEventListener('click', async () => {
  const email = $('login-email').value.trim();
  if (!email) { showLogin('请先填写邮箱。', true); return; }
  $('login-send').disabled = true;
  try {
    const sent = await api('POST', '/v1/auth/email/code', { email });
    showLogin(sent.devHint || '验证码已发送，请查看邮箱。');
    let left = sent.resendAfterSeconds || 60;
    const timer = setInterval(() => { left--; $('login-send').textContent = left > 0 ? `${left} 秒后可重发` : '获取验证码'; if (left <= 0) { clearInterval(timer); $('login-send').disabled = false; } }, 1000);
    $('login-code').focus();
  } catch (error) { showLogin(error.message, true); $('login-send').disabled = false; }
});
$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const email = $('login-email').value.trim(), code = $('login-code').value.trim();
  if (!email || !code) { showLogin('请填写邮箱和验证码。', true); return; }
  $('login-submit').disabled = true;
  try {
    const result = await api('POST', '/v1/auth/email/login', { email, code });
    token = result.token;
    try { await api('GET', '/admin/v1/me'); }
    catch (error) { token = ''; showLogin(error.status === 403 ? '这个邮箱没有管理后台的权限。' : error.message, true); return; }
    localStorage.setItem(TOKEN_KEY, token);
    await start();
  } catch (error) { if (!error.quiet) showLogin(error.message, true); }
  finally { $('login-submit').disabled = false; }
});
$('logout').addEventListener('click', () => logout());

// ---------- pages ----------
const page = () => $('page');
function head(title, ...extra) { return h('div', { class: 'page-head' }, h('h1', {}, title), ...extra); }

async function overviewPage() {
  const data = await api('GET', '/admin/v1/overview');
  const names = { today: '今天', yesterday: '昨天', days7: '近 7 天', days30: '近 30 天' };
  const range = p => p.from === p.to ? p.from.slice(5) : `${p.from.slice(5)} 至 ${p.to.slice(5)}`;
  const stat = (label, value, unit, key) => h('div', { class: 'stat' }, h('span', { class: 'label' }, label), h('span', { class: 'value', 'data-stat': key }, value, unit ? h('small', {}, unit) : null));
  const cards = Object.entries(names).map(([key, name]) => {
    const p = data.periods[key];
    return h('div', { class: 'card period', 'data-period': key }, h('h3', {}, name, h('span', {}, range(p))),
      stat('新注册用户', int(p.newUsers), '人', 'newUsers'), stat('用过数字人的用户', int(p.activeUsers), '人', 'activeUsers'),
      stat('用掉的时长', minutes(p.usedSeconds), '分钟', 'usedMinutes'), stat('兑换进来的时长', minutes(p.redeemedSeconds), '分钟', 'redeemedMinutes'));
  });
  page().replaceChildren(head('概览', h('span', { class: 'muted small' }, `北京时间 ${fmtTime(data.now)}`)),
    h('div', { class: 'stack' }, h('div', { class: 'periods' }, cards),
      h('div', { class: 'card' }, h('h3', {}, '近 30 天每天用掉的分钟数'), barChart(data.daily))),
    h('p', { class: 'footnote' }, DATE_RULE));
}
function barChart(days) {
  const values = days.map(day => day.usedSeconds / 60), max = Math.max(...values, 0);
  const step = niceStep(max / 4), top = Math.max(step * 4, 1);
  const axis = h('div', { class: 'axis' }, [4, 3, 2, 1, 0].map(i => h('span', {}, int(Math.round(step * i * 10) / 10))));
  const plot = h('div', { class: 'plot', id: 'daily-chart' }, days.map((day, i) => h('div', {
    class: 'bar' + (values[i] ? '' : ' zero'), style: `height:${(values[i] / top) * 100}%`, 'data-day': day.day, 'data-minutes': minutes(day.usedSeconds)
  }, h('span', { class: 'tip' }, `${day.day.slice(5)}：${minutes(day.usedSeconds)} 分钟，${day.sessions} 次`))));
  const labels = h('div', { class: 'labels' }, days.map((day, i) => h('span', {}, i % 5 === 4 || i === days.length - 1 ? day.day.slice(5).replace('-', '/') : '')));
  return h('div', { class: 'chart' }, axis, plot, labels);
}
function niceStep(raw) {
  if (raw <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(raw)), n = raw / power;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * power;
}

// ----- redeem codes -----
let plansCache = null;
async function codesPage() {
  plansCache ||= await api('GET', '/admin/v1/plans');
  const { batches } = await api('GET', '/admin/v1/batches');
  const plans = h('div', { class: 'plans', id: 'gen-plans' },
    plansCache.plans.map((plan, i) => h('label', {}, h('input', { type: 'radio', name: 'plan', value: plan.id, checked: i === 0 }), `${plan.name} ${int(plan.credits)} 分钟`)),
    h('label', {}, h('input', { type: 'radio', name: 'plan', value: 'custom' }), '自己填', h('input', { type: 'number', id: 'gen-minutes', min: 1, max: 100000, placeholder: '分钟' }), '分钟'));
  const form = h('form', { class: 'card stack', id: 'gen-form' },
    h('h2', {}, '生成一批兑换码'),
    h('div', {}, h('div', { class: 'muted small', style: 'margin-bottom:6px' }, '每个码多少分钟'), plans),
    h('div', { class: 'form-grid' },
      h('label', {}, `数量（一次最多 ${plansCache.maxBatch} 个）`, h('input', { type: 'number', id: 'gen-count', min: 1, max: plansCache.maxBatch, value: 10, required: true })),
      h('label', {}, '有效期至（不填就是一直有效）', h('input', { type: 'date', id: 'gen-expires', min: today() })),
      h('label', {}, '备注（比如“给某某主播”“11 月内测”）', h('input', { id: 'gen-note', maxlength: 100 })),
      h('div', {}, h('button', { type: 'submit', id: 'gen-submit' }, '生成'))),
    h('div', { id: 'gen-result' }));
  form.querySelector('#gen-minutes').addEventListener('focus', () => { form.querySelector('input[value=custom]').checked = true; });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const plan = form.querySelector('input[name=plan]:checked').value;
    const body = { count: Number($('gen-count').value), note: $('gen-note').value.trim(), expiresOn: $('gen-expires').value || undefined };
    if (plan === 'custom') body.minutes = Number($('gen-minutes').value); else body.plan = plan;
    $('gen-submit').disabled = true;
    try { showGenerated(await api('POST', '/admin/v1/batches', body)); refreshBatchList(); }
    catch (error) { if (!error.quiet) toast(error.message, true); }
    finally { $('gen-submit').disabled = false; }
  });

  const lookup = h('form', { class: 'card stack', id: 'lookup-form' }, h('h2', {}, '按码查'),
    h('div', { class: 'row' }, h('label', { class: 'grow' }, '完整的兑换码，或者最后 4 位', h('input', { id: 'lookup-q', placeholder: 'SF-XXXX-XXXX-XXXX-XXXX 或 XXXX' })), h('button', { type: 'submit' }, '查询')),
    h('div', { id: 'lookup-result' }));
  lookup.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const { codes } = await api('GET', '/admin/v1/codes?q=' + encodeURIComponent($('lookup-q').value));
      $('lookup-result').replaceChildren(codes.length ? codeTable(codes, true) : h('p', { class: 'muted' }, '没有找到这个兑换码。'));
    } catch (error) { if (!error.quiet) $('lookup-result').replaceChildren(h('p', { class: 'message error' }, error.message)); }
  });

  page().replaceChildren(head('兑换码'), h('div', { class: 'stack' }, form, lookup,
    h('div', { class: 'card stack' }, h('h2', {}, '全部批次'), h('div', { id: 'batch-list' }, batchTable(batches)))));
}
async function refreshBatchList() { const { batches } = await api('GET', '/admin/v1/batches'); $('batch-list')?.replaceChildren(batchTable(batches)); }
function batchTable(batches) {
  return table(['生成时间', '备注', { text: '每个分钟', class: 'r' }, { text: '一共', class: 'r' }, { text: '已兑换', class: 'r' }, { text: '已作废', class: 'r' }, { text: '已过期', class: 'r' }, { text: '未使用', class: 'r' }, '有效期至', ''],
    batches.map(batch => h('tr', { 'data-batch': batch.id },
      h('td', {}, fmtTime(batch.createdAt)), h('td', { class: 'wrap' }, batch.note || '—'), h('td', { class: 'r' }, int(batch.minutes)), h('td', { class: 'r' }, int(batch.total)),
      h('td', { class: 'r' }, int(batch.redeemed)), h('td', { class: 'r' }, int(batch.voided)), h('td', { class: 'r' }, int(batch.expired)), h('td', { class: 'r' }, int(batch.unused)),
      h('td', {}, batch.expiresAt ? fmtDate(batch.expiresAt - 1) : '一直有效'), h('td', {}, h('a', { href: '#/codes/' + encodeURIComponent(batch.id) }, '查看')))),
    '还没有生成过兑换码');
}
function showGenerated({ batch, codes }) {
  const text = codes.join('\n');
  const csv = () => downloadCsv(`兑换码-${batch.note || batch.id}-${codes.length}个.csv`, [['兑换码', '每个分钟', '有效期至', '备注', '批次'], ...codes.map(code => [code, batch.minutes, batch.expiresAt ? fmtDate(batch.expiresAt - 1) : '一直有效', batch.note, batch.id])]);
  $('gen-result').replaceChildren(h('div', { class: 'stack', id: 'gen-output' },
    h('div', { class: 'notice' }, `已生成 ${codes.length} 个，每个 ${int(batch.minutes)} 分钟。这些码只显示这一次，离开这个页面后就再也看不到完整的码了，请马上复制或下载保存。`),
    h('div', { class: 'codes-out', id: 'gen-codes' }, text),
    h('div', { class: 'row' },
      h('button', { type: 'button', id: 'gen-copy', onclick: async () => toast(await copyText(text) ? `已复制 ${codes.length} 个兑换码` : '复制失败，请手动选中复制', false) }, '复制全部'),
      h('button', { type: 'button', class: 'secondary', id: 'gen-csv', onclick: csv }, '下载表格'),
      h('a', { href: '#/codes/' + encodeURIComponent(batch.id) }, '查看这一批'))));
}
function codeTable(codes, withBatch = false, onVoid) {
  return table(['末 4 位', '状态', ...(withBatch ? ['批次', '备注', { text: '分钟', class: 'r' }] : []), '兑换人', '兑换时间', '作废时间', ...(onVoid ? [''] : [])],
    codes.map(code => h('tr', { 'data-code': code.hint },
      h('td', { class: 'mono' }, '…' + code.hint), h('td', {}, statusPill(code.status)),
      ...(withBatch ? [h('td', {}, h('a', { href: '#/codes/' + encodeURIComponent(code.batch) }, fmtTime(code.createdAt))), h('td', {}, code.note || '—'), h('td', { class: 'r' }, int(code.minutes))] : []),
      h('td', {}, code.redeemedBy ? h('a', { href: '#/users/' + encodeURIComponent(code.redeemedBy) }, accountText(code.redeemedBy)) : '—'),
      h('td', {}, fmtTime(code.redeemedAt)), h('td', {}, fmtTime(code.voidedAt)),
      ...(onVoid ? [h('td', {}, ['unused', 'expired'].includes(code.status) ? h('button', { class: 'secondary small', onclick: () => onVoid(code) }, '作废') : '')] : []))),
    '这一批没有兑换码');
}
async function batchPage(id) {
  const { batch, codes } = await api('GET', '/admin/v1/batches/' + encodeURIComponent(id));
  const voidOne = async code => {
    if (!await confirmBox('作废这个兑换码？', `末 4 位 …${code.hint}，${int(batch.minutes)} 分钟。\n作废后这个码不能再兑换，这个操作不能撤回。`, '作废')) return;
    try { await api('POST', `/admin/v1/codes/${code.id}/void`, {}); toast('已作废'); batchPage(id); } catch (error) { if (!error.quiet) toast(error.message, true); }
  };
  const voidAll = async () => {
    const left = batch.unused + batch.expired;
    if (!await confirmBox('作废这一批里还没用的码？', `一共会作废 ${left} 个（未使用 ${batch.unused} 个、已过期 ${batch.expired} 个）。\n已经兑换的 ${batch.redeemed} 个不受影响。这个操作不能撤回。`, `作废 ${left} 个`)) return;
    try { const result = await api('POST', `/admin/v1/batches/${encodeURIComponent(id)}/void`, {}); toast(`已作废 ${result.voided} 个`); batchPage(id); } catch (error) { if (!error.quiet) toast(error.message, true); }
  };
  const tile = (label, value, unit) => h('div', { class: 'card tile' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value, unit ? h('small', {}, unit) : null));
  page().replaceChildren(head('兑换码批次', h('a', { href: '#/codes' }, '← 返回全部批次')),
    h('div', { class: 'stack' },
      h('div', { class: 'tiles' }, tile('生成时间', fmtTime(batch.createdAt)), tile('备注', batch.note || '—'), tile('每个', int(batch.minutes), '分钟'), tile('有效期至', batch.expiresAt ? fmtDate(batch.expiresAt - 1) : '一直有效'),
        tile('一共', int(batch.total), '个'), tile('已兑换', int(batch.redeemed), '个'), tile('已作废 / 已过期', `${int(batch.voided)} / ${int(batch.expired)}`), tile('未使用', int(batch.unused), '个')),
      h('div', { class: 'row' }, h('span', { class: 'muted small grow' }, `批次编号 ${batch.id}。完整的码只在生成时显示一次，这里只显示末 4 位。`),
        h('button', { class: 'danger', id: 'void-batch', disabled: batch.unused + batch.expired === 0, onclick: voidAll }, '作废这批里还没用的码')),
      codeTable(codes, false, voidOne)));
}

// ----- users -----
const userState = { q: '', sort: 'created', dir: 'desc', offset: 0 };
async function usersPage() {
  const params = new URLSearchParams({ q: userState.q, sort: userState.sort, dir: userState.dir, offset: userState.offset });
  const data = await api('GET', '/admin/v1/users?' + params);
  const search = h('form', { class: 'row', id: 'user-search' },
    h('label', { class: 'grow' }, '按邮箱或手机号搜索', h('input', { id: 'user-q', value: userState.q, placeholder: '输入邮箱或手机号的一部分' })),
    h('label', {}, '排序', h('select', { id: 'user-sort' }, [['created', '注册时间'], ['balance', '剩余分钟'], ['used', '累计使用']].map(([value, text]) => h('option', { value, selected: userState.sort === value }, text)))),
    h('label', {}, '顺序', h('select', { id: 'user-dir' }, [['desc', '从多到少 / 从新到旧'], ['asc', '从少到多 / 从旧到新']].map(([value, text]) => h('option', { value, selected: userState.dir === value }, text)))),
    h('button', { type: 'submit' }, '查询'));
  search.addEventListener('submit', event => { event.preventDefault(); Object.assign(userState, { q: $('user-q').value.trim(), sort: $('user-sort').value, dir: $('user-dir').value, offset: 0 }); usersPage(); });
  search.querySelectorAll('select').forEach(select => select.addEventListener('change', () => search.requestSubmit()));
  const rows = data.users.map(user => h('tr', { 'data-user': user.id },
    h('td', {}, fmtTime(user.createdAt)), h('td', {}, h('a', { href: '#/users/' + encodeURIComponent(user.id) }, accountText(user.id)), h('span', { class: 'muted small' }, ' ' + accountKind(user.id))),
    h('td', { class: 'r' }, user.synced ? minutes(user.balanceSeconds) : '待汇总'), h('td', { class: 'r' }, user.synced ? minutes(user.rechargedSeconds) : '—'),
    h('td', { class: 'r' }, user.synced ? minutes(user.usedSeconds) : '—'), h('td', {}, fmtTime(user.lastUsedAt))));
  const pager = h('div', { class: 'pager' }, `共 ${int(data.total)} 人，第 ${data.total ? data.offset + 1 : 0}–${data.offset + data.users.length} 个`,
    h('button', { class: 'secondary small', disabled: data.offset === 0, onclick: () => { userState.offset = Math.max(0, data.offset - data.pageSize); usersPage(); } }, '上一页'),
    h('button', { class: 'secondary small', disabled: data.offset + data.users.length >= data.total, onclick: () => { userState.offset = data.offset + data.pageSize; usersPage(); } }, '下一页'));
  const backfill = h('button', { class: 'secondary small', id: 'backfill', onclick: async () => {
    if (!await confirmBox('重新汇总全部用户？', '从每个账户重新读取充值和使用记录，补齐这里的数字。适合第一次上线后执行一次，数据多时需要一点时间。', '开始汇总', false)) return;
    try { const result = await api('POST', '/admin/v1/backfill'); toast(`已汇总 ${result.accounts} 个账户`); usersPage(); } catch (error) { if (!error.quiet) toast(error.message, true); }
  } }, '重新汇总全部用户');
  page().replaceChildren(head('用户'), h('div', { class: 'stack' }, h('div', { class: 'card' }, search),
    table(['注册时间', '账号', { text: '剩余分钟', class: 'r' }, { text: '累计充值分钟', class: 'r' }, { text: '累计使用分钟', class: 'r' }, '最近一次使用'], rows, '没有找到用户'),
    pager, h('p', { class: 'footnote' }, '“累计充值”包括新用户赠送、兑换码和后台调整（减少的也算在内），所以 剩余 = 累计充值 − 累计使用。显示“待汇总”的老账户，用户下次打开应用时会自动补齐，也可以点 ', backfill, '。')));
}
async function userPage(id) {
  const data = await api('GET', '/admin/v1/users/' + encodeURIComponent(id)), user = data.user;
  const tile = (label, value, unit, key) => h('div', { class: 'card tile' }, h('div', { class: 'label' }, label), h('div', { class: 'value', 'data-stat': key }, value, unit ? h('small', {}, unit) : null));
  const adjust = h('form', { class: 'card stack', id: 'adjust-form' }, h('h2', {}, '手动加减分钟'),
    h('div', { class: 'form-grid' },
      h('label', {}, '加还是减', h('select', { id: 'adjust-sign' }, h('option', { value: '1' }, '加分钟'), h('option', { value: '-1' }, '减分钟'))),
      h('label', {}, '分钟数', h('input', { type: 'number', id: 'adjust-minutes', min: 1, max: 100000, required: true })),
      h('label', {}, '原因（必填，比如补偿、赠送、纠错）', h('input', { id: 'adjust-reason', maxlength: 200, required: true })),
      h('div', {}, h('button', { type: 'submit', id: 'adjust-submit' }, '提交'))),
    h('p', { class: 'muted small' }, '会记在这个用户的充值记录里，来源是“后台调整”。不能减到 0 以下。'));
  adjust.addEventListener('submit', async event => {
    event.preventDefault();
    const amount = Number($('adjust-minutes').value), sign = Number($('adjust-sign').value), reason = $('adjust-reason').value.trim();
    if (!Number.isInteger(amount) || amount <= 0) { toast('分钟数要填正整数', true); return; }
    if (!reason) { toast('请填写原因', true); return; }
    const after = user.balanceSeconds / 60 + sign * amount;
    if (!await confirmBox(sign > 0 ? '给这个用户加分钟？' : '从这个用户减分钟？', `${accountText(user.id)}\n${sign > 0 ? '加' : '减'} ${int(amount)} 分钟，原因：${reason}\n现在剩 ${minutes(user.balanceSeconds)} 分钟，调整后约 ${Math.round(after * 10) / 10} 分钟。`, '确定' + (sign > 0 ? '加' : '减'), sign < 0)) return;
    $('adjust-submit').disabled = true;
    try {
      const result = await api('POST', `/admin/v1/users/${encodeURIComponent(user.id)}/adjust`, { minutes: sign * amount, reason });
      toast(result.pendingMirror ? '已生效。统计数字稍后更新。' : '已调整'); userPage(id);
    } catch (error) { if (!error.quiet) toast(error.message, true); }
    finally { $('adjust-submit') && ($('adjust-submit').disabled = false); }
  });
  const recharges = data.recharges.map(item => h('tr', {},
    h('td', {}, fmtTime(item.at)), h('td', {}, KIND[item.kind] || item.kind), h('td', { class: 'r' }, signed(item.seconds)),
    h('td', {}, item.kind === 'redeem' ? h('span', {}, h('span', { class: 'mono' }, '…' + (item.codeHint || '')), item.batch ? h('span', {}, ' ', h('a', { href: '#/codes/' + encodeURIComponent(item.batch) }, '看批次')) : null) : item.kind === 'admin' ? item.reason || '—' : '—'),
    h('td', {}, item.actor || '—')));
  const sessions = data.sessions.map(item => h('tr', {},
    h('td', {}, fmtTime(item.startedAt)), h('td', {}, fmtTime(item.endedAt)), h('td', { class: 'r' }, item.hadFrame ? duration(item.billedSeconds) : '—'),
    h('td', { class: 'r' }, item.billedSeconds ? minutes(item.billedSeconds) + ' 分钟' : '0'), h('td', {}, item.hadFrame ? '出了' : '没出画面，未扣'), h('td', {}, END[item.endReason] || item.endReason || '—')));
  page().replaceChildren(head(accountText(user.id), h('span', { class: 'muted' }, accountKind(user.id) + '账号'), h('a', { href: '#/users' }, '← 返回用户列表')),
    h('div', { class: 'stack' },
      h('div', { class: 'tiles' }, tile('剩余', minutes(user.balanceSeconds), '分钟', 'balance'), tile('累计充值', minutes(user.rechargedSeconds), '分钟', 'recharged'),
        tile('累计使用', minutes(user.usedSeconds), '分钟', 'used'), tile('注册时间', fmtTime(user.createdAt)), tile('最近一次使用', fmtTime(user.lastUsedAt))),
      user.synced ? null : h('div', { class: 'notice' }, '这个账户的数字还没汇总过来，用户下次打开应用时会自动补齐，或在用户列表底部点“重新汇总全部用户”。'),
      adjust,
      h('div', { class: 'card stack' }, h('h2', {}, '充值记录'), table(['时间', '来源', { text: '分钟', class: 'r' }, '兑换码 / 原因', '操作人'], recharges, '还没有充值记录')),
      h('div', { class: 'card stack' }, h('h2', {}, '使用记录'), table(['开始时间', '结束时间', { text: '时长', class: 'r' }, { text: '扣了', class: 'r' }, '画面', '怎么结束的'], sessions, '还没有使用记录'))),
    h('p', { class: 'footnote' }, `账号完整编号：${user.id}。时间都是北京时间。`));
}

// ----- usage -----
const usageState = { from: '', to: '' };
async function usagePage() {
  usageState.to ||= today(); usageState.from ||= addDays(usageState.to, -29);
  const data = await api('GET', `/admin/v1/usage?from=${usageState.from}&to=${usageState.to}`);
  const form = h('form', { class: 'row', id: 'usage-form' },
    h('label', {}, '从', h('input', { type: 'date', id: 'usage-from', value: data.from, max: today() })),
    h('label', {}, '到', h('input', { type: 'date', id: 'usage-to', value: data.to, max: today() })),
    h('button', { type: 'submit' }, '查询'),
    h('button', { type: 'button', class: 'secondary', id: 'usage-csv', onclick: () => downloadCsv(`使用统计-${data.from}至${data.to}.csv`,
      [['日期', '开过数字人的人数', '次数', '总时长（分钟）', '平均每次（分钟）', '没出画面的次数'], ...data.days.map(day => [day.day, day.users, day.sessions, minutes(day.totalSeconds), minutes(day.averageSeconds), day.noFrameSessions]),
        ['合计', data.total.users, data.total.sessions, minutes(data.total.totalSeconds), minutes(data.total.averageSeconds), data.total.noFrameSessions]]) }, '下载表格'));
  form.addEventListener('submit', event => { event.preventDefault(); usageState.from = $('usage-from').value; usageState.to = $('usage-to').value; usagePage().catch(error => { if (!error.quiet) toast(error.message, true); }); });
  const row = (label, item, attrs = {}) => h('tr', attrs, h('td', {}, label), h('td', { class: 'r' }, int(item.users)), h('td', { class: 'r' }, int(item.sessions)),
    h('td', { class: 'r' }, item.totalSeconds ? duration(item.totalSeconds) : '0'), h('td', { class: 'r' }, item.averageSeconds ? duration(item.averageSeconds) : '—'), h('td', { class: 'r' }, int(item.noFrameSessions)));
  page().replaceChildren(head('使用统计'), h('div', { class: 'stack' }, h('div', { class: 'card' }, form),
    table(['日期', { text: '开过数字人的人数', class: 'r' }, { text: '次数', class: 'r' }, { text: '总时长', class: 'r' }, { text: '平均每次', class: 'r' }, { text: '没出画面的次数', class: 'r' }],
      data.days.map(day => row(day.day, day, { 'data-day': day.day })), '这段时间没有使用', row('合计', data.total, { id: 'usage-total' }))),
    h('p', { class: 'footnote' }, DATE_RULE, h('br'), '平均每次 = 总时长 ÷ 出了画面的次数。合计一行里的人数按人去重（同一个人用了几天也只算一次）。'));
}

// ----- audit -----
async function auditPage() {
  const { entries } = await api('GET', '/admin/v1/audit');
  const detail = entry => {
    const d = entry.detail || {};
    if (entry.action === 'batch_create') return `${int(d.count)} 个 × ${int(d.minutes)} 分钟${d.expiresAt ? `，有效期至 ${fmtDate(d.expiresAt - 1)}` : ''}${d.note ? `，备注：${d.note}` : ''}`;
    if (entry.action === 'batch_void') return `作废了 ${int(d.count)} 个未使用的码`;
    if (entry.action === 'code_void') return `${int(d.minutes)} 分钟的码`;
    if (entry.action === 'adjust') return `${d.minutes > 0 ? '加' : '减'} ${int(Math.abs(d.minutes))} 分钟，调整后剩 ${minutes(d.balanceAfterSeconds)} 分钟`;
    if (entry.action === 'backfill') return `汇总了 ${int(d.accounts)} 个账户`;
    return JSON.stringify(d);
  };
  const target = entry => entry.action === 'adjust' ? h('a', { href: '#/users/' + encodeURIComponent(entry.target) }, accountText(entry.target))
    : entry.action === 'batch_create' || entry.action === 'batch_void' ? h('a', { href: '#/codes/' + encodeURIComponent(entry.target) }, entry.target)
    : entry.action === 'code_void' && entry.detail?.batch ? h('a', { href: '#/codes/' + encodeURIComponent(entry.detail.batch) }, entry.target) : entry.target;
  page().replaceChildren(head('操作记录', h('span', { class: 'muted small' }, '只能查看，不能修改或删除。最近 100 条。')),
    table(['时间', '操作人', '做了什么', '对象', '内容', '原因'], entries.map(entry => h('tr', { 'data-action': entry.action },
      h('td', {}, fmtTime(entry.at)), h('td', {}, entry.actor), h('td', {}, ACTION[entry.action] || entry.action), h('td', {}, target(entry)), h('td', { class: 'wrap' }, detail(entry)), h('td', { class: 'wrap' }, entry.reason || '—'))), '还没有操作记录'));
}

// ---------- router ----------
async function render() {
  const [, section = '', ...rest] = location.hash.replace(/^#/, '').split('/');
  const id = rest.length ? decodeURIComponent(rest.join('/')) : null;
  document.querySelectorAll('[data-nav]').forEach(link => link.classList.toggle('active', link.dataset.nav === (section || 'overview')));
  page().replaceChildren(h('p', { class: 'muted' }, '加载中…'));
  try {
    if (section === 'codes') await (id ? batchPage(id) : codesPage());
    else if (section === 'users') await (id ? userPage(id) : usersPage());
    else if (section === 'usage') await usagePage();
    else if (section === 'audit') await auditPage();
    else await overviewPage();
    window.scrollTo(0, 0);
  } catch (error) { if (!error.quiet) page().replaceChildren(h('p', { class: 'message error' }, '没有加载出来：' + error.message)); }
}
async function start() {
  try {
    const me = await api('GET', '/admin/v1/me');
    $('who').textContent = me.email; $('login-view').hidden = true; $('app-view').hidden = false;
    await render();
  } catch (error) {
    if (error.status === 403) logout('这个邮箱没有管理后台的权限。');
    else if (!error.quiet) showLogin(error.message, true);
  }
}
window.addEventListener('hashchange', () => { if (token) render(); });
if (token) start(); else showLogin();

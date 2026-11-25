'use strict';
// Credits: recharge with redeem codes, low-balance reminders, purchase and usage
// history. 1 credit = 1 minute; the server keeps seconds. Depends on globals:
// $, api, cloudState, message.
const minutesLeft = () => Math.floor((cloudState.account?.remainingSeconds || 0) / 60);
let planCache = null;
function openRecharge(note = '') {
  $('recharge-balance').textContent = cloudState.account ? `还剩 ${minutesLeft()} 分钟。` : '请先登录。';
  $('redeem-code').value = ''; redeemHint(note, Boolean(note));
  if (!$('recharge-dialog').open) $('recharge-dialog').showModal();
  $('redeem-code').focus();
  if (!planCache) api.accountPlans().then(result => { planCache = result; drawPlans(); }).catch(() => {}); else drawPlans();
}
function redeemHint(text, error = false, ok = false) {
  $('redeem-hint').textContent = text;
  $('redeem-hint').classList.toggle('field-error', error && Boolean(text));
  $('redeem-hint').classList.toggle('field-ok', ok && Boolean(text));
}
function drawPlans() {
  const list = $('plan-list'); list.replaceChildren();
  for (const plan of planCache?.plans || []) {
    const item = document.createElement('div'); item.className = 'plan'; item.setAttribute('role', 'listitem');
    const name = document.createElement('strong'); name.textContent = plan.name;
    const price = document.createElement('span'); price.textContent = `¥${plan.priceYuan}`;
    const credits = document.createElement('small'); credits.textContent = `${plan.credits} 分钟`;
    item.append(name, price, credits); list.append(item);
  }
  if (planCache?.purchaseHint) $('purchase-hint').textContent = '如何购买：' + planCache.purchaseHint + '。购买后会收到兑换码，在下面输入即可到账。';
}
(() => {
  $('recharge-open').onclick = () => openRecharge();
  $('balance-warning-recharge').onclick = () => openRecharge();
  $('history-recharge').onclick = () => { $('cloud-dialog').close(); openRecharge(); };
  $('close-recharge').onclick = () => $('recharge-dialog').close();
  $('redeem-code').addEventListener('input', () => { if ($('redeem-hint').classList.contains('field-error')) redeemHint(''); });
  $('recharge-form').onsubmit = async event => {
    event.preventDefault();
    const code = $('redeem-code').value.trim();
    if (code.replace(/[^0-9a-z]/gi, '').length < 12) { redeemHint('请输入完整的兑换码，例如 SF-XXXX-XXXX-XXXX-XXXX', true); $('redeem-code').focus(); return; }
    $('redeem-submit').disabled = true;
    try {
      const { credits } = await api.redeemCode(code);
      redeemHint(`兑换成功，已到账 ${credits} 分钟。`, false, true);
      $('redeem-code').value = '';
      setTimeout(() => { $('recharge-balance').textContent = `还剩 ${minutesLeft()} 分钟。`; }, 300);
    } catch (error) { redeemHint(error.message, true); $('redeem-code').select(); }
    finally { $('redeem-submit').disabled = false; }
  };
  // "怎么用、怎么收费": purchase and usage history when logged in.
  const time = ms => new Date(ms).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const duration = seconds => seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
  const sources = { trial: '新用户赠送', redeem: '兑换码充值' };
  function fill(id, rows, empty) {
    const body = $(id).querySelector('tbody'); body.replaceChildren();
    if (!rows.length) { const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 3; td.className = 'empty'; td.textContent = empty; tr.append(td); body.append(tr); return; }
    for (const cells of rows) { const tr = document.createElement('tr'); for (const text of cells) { const td = document.createElement('td'); td.textContent = text; tr.append(td); } body.append(tr); }
  }
  $('cloud-flow').addEventListener('click', async () => {
    $('billing-history').hidden = !cloudState.account;
    if (!cloudState.account) return;
    try {
      const history = await api.accountHistory();
      fill('purchase-history', history.purchases.map(item => [time(item.at), sources[item.source] || item.source, `+${item.credits}`]), '还没有充值记录');
      fill('usage-history', history.sessions.map(item => [time(item.startedAt), item.seconds ? duration(item.seconds) : '没出画面，未扣', item.seconds ? `−${item.credits} 分钟` : '0 分钟']), '还没有使用记录');
    } catch (error) { fill('usage-history', [], '记录没有加载出来：' + error.message); }
  });
  // Low-balance reminders at 30 and 5 minutes (bar + one notice per threshold).
  let lastTier = null; // remind once per threshold crossed
  setInterval(() => {
    const account = cloudState.account, left = account ? account.remainingSeconds : Infinity;
    const tier = left < 5 * 60 ? 5 : left < 30 * 60 ? 30 : null;
    $('balance-warning').hidden = tier == null;
    if (tier != null) $('balance-warning-text').textContent = tier === 5 ? `剩余时长不到 5 分钟（剩 ${Math.floor(left / 60)} 分钟），用完数字人会自动停止。` : `剩余时长不到 30 分钟（剩 ${Math.floor(left / 60)} 分钟），记得充值。`;
    if (tier != null && tier !== lastTier) message(tier === 5 ? '剩余时长不到 5 分钟，用完数字人会自动停止。' : '剩余时长不到 30 分钟，记得充值。');
    lastTier = tier;
  }, 1000);
})();

'use strict';
// Phone + SMS login dialog. Depends on globals: $, api, cloudState, message.
(() => {
  let countdown = null, remaining = 0;
  function drawAccount() {
    const account = cloudState.account;
    $('account-button').textContent = account ? '退出登录' : '登录';
  }
  function tickCountdown() {
    $('login-send').disabled = remaining > 0;
    $('login-send').textContent = remaining > 0 ? `${remaining} 秒后重发` : '获取验证码';
    if (remaining-- <= 0) { clearInterval(countdown); countdown = null; }
  }
  const hint = text => { $('login-hint').textContent = text; };
  $('account-button').onclick = async () => {
    if (!cloudState.account) { hint(''); $('login-code').value = ''; $('login-dialog').showModal(); $('login-phone').focus(); return; }
    try { await api.logout(); message('已退出登录。'); } catch (error) { message(error.message); }
  };
  $('close-login').onclick = () => $('login-dialog').close();
  $('login-send').onclick = async () => {
    $('login-send').disabled = true;
    try {
      const result = await api.requestLoginCode($('login-phone').value.replace(/\s+/g, ''));
      hint(result.devHint || '验证码已发送，请查看短信。');
      remaining = result.resendAfterSeconds || 60; clearInterval(countdown); countdown = setInterval(tickCountdown, 1000); tickCountdown();
      $('login-code').focus();
    } catch (error) { hint(error.message); $('login-send').disabled = false; }
  };
  $('login-form').onsubmit = async event => {
    event.preventDefault();
    $('login-submit').disabled = true;
    try {
      const name = await api.login($('login-phone').value.replace(/\s+/g, ''), $('login-code').value.trim());
      $('login-dialog').close(); message(`已登录：${name}`);
    } catch (error) { hint(error.message); }
    finally { $('login-submit').disabled = false; }
  };
  api.onCloud(() => drawAccount());
  setInterval(drawAccount, 1000); drawAccount();
})();

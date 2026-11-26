'use strict';
// Login dialog: email + code or phone + SMS code. Depends on globals: $, api, cloudState, message.
(() => {
  const methods = {
    email: { label: '邮箱', type: 'email', inputmode: 'email', autocomplete: 'email', maxlength: 254, placeholder: '请输入邮箱', sent: '验证码已发到你的邮箱。没收到的话看看垃圾邮件箱。',
      normalize: value => value.trim(), check: value => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) ? '' : '邮箱格式不对，请检查一下' },
    sms: { label: '手机号', type: 'tel', inputmode: 'numeric', autocomplete: 'tel', maxlength: 13, placeholder: '11 位手机号', sent: '验证码已发送，请查看短信。',
      normalize: value => value.replace(/\s+/g, ''), check: value => /^1[3-9]\d{9}$/.test(value) ? '' : '请输入 11 位手机号' }
  };
  let method = 'email', countdown = null, remaining = 0;
  const current = () => methods[method];
  const idValue = () => current().normalize($('login-id').value);
  function drawAccount() { $('account-button').textContent = cloudState.account ? '退出登录' : '登录'; }
  function tickCountdown() {
    $('login-send').disabled = remaining > 0;
    $('login-send').textContent = remaining > 0 ? `${remaining} 秒后重发` : '获取验证码';
    if (remaining-- <= 0) { clearInterval(countdown); countdown = null; }
  }
  const hint = (text, error = false) => { $('login-hint').textContent = text; $('login-hint').classList.toggle('field-error', error && Boolean(text)); };
  const fieldError = text => { $('login-id-error').textContent = text; $('login-id-error').hidden = !text; $('login-id').setAttribute('aria-invalid', String(Boolean(text))); };
  function validate() { const error = current().check(idValue()); fieldError(error); return !error; }
  function setMethod(next) {
    method = next; const m = current(), input = $('login-id');
    document.querySelectorAll('[data-login-method]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.loginMethod === method)));
    $('login-id-label').textContent = m.label;
    Object.assign(input, { type: m.type, placeholder: m.placeholder, maxLength: m.maxlength, value: '' });
    input.setAttribute('inputmode', m.inputmode); input.setAttribute('autocomplete', m.autocomplete);
    $('login-code').value = ''; fieldError(''); hint('');
    clearInterval(countdown); countdown = null; remaining = 0; tickCountdown();
    input.focus();
  }
  document.querySelectorAll('[data-login-method]').forEach(button => { button.onclick = () => { if (button.dataset.loginMethod !== method) setMethod(button.dataset.loginMethod); }; });
  $('login-id').addEventListener('blur', () => { if ($('login-id').value.trim()) validate(); });
  $('login-id').addEventListener('input', () => { if (!$('login-id-error').hidden) validate(); });
  $('login-code').addEventListener('input', () => { if ($('login-hint').classList.contains('field-error')) hint(''); });
  $('account-button').onclick = async () => {
    if (!cloudState.account) { hint(''); $('login-code').value = ''; $('login-dialog').showModal(); $('login-id').focus(); return; }
    try { await api.logout(); message('已退出登录。'); } catch (error) { message(error.message); }
  };
  $('close-login').onclick = () => $('login-dialog').close();
  $('login-send').onclick = async () => {
    if (!validate()) { $('login-id').focus(); return; }
    $('login-send').disabled = true;
    try {
      const result = await api.requestLoginCode(method, idValue());
      hint(result.devHint || current().sent);
      remaining = result.resendAfterSeconds || 60; clearInterval(countdown); countdown = setInterval(tickCountdown, 1000); tickCountdown();
      $('login-code').focus();
    } catch (error) { hint(error.message, true); $('login-send').disabled = false; }
  };
  $('login-form').onsubmit = async event => {
    event.preventDefault();
    if (!validate()) { $('login-id').focus(); return; }
    if (!/^\d{6}$/.test($('login-code').value.trim())) { hint('请输入 6 位数字验证码', true); $('login-code').focus(); return; }
    $('login-submit').disabled = true;
    try {
      const name = await api.login(method, idValue(), $('login-code').value.trim());
      message(`已登录：${name}`); document.dispatchEvent(new CustomEvent('soundface-login')); $('login-dialog').close();
    } catch (error) { hint(error.message, true); $('login-code').select(); }
    finally { $('login-submit').disabled = false; }
  };
  api.onCloud(() => drawAccount());
  setInterval(drawAccount, 1000); drawAccount();
})();

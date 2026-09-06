(async () => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const form = $('form');
  const title = $('title');
  const subtitle = $('subtitle');
  const confirmRow = $('confirm-row');
  const errorEl = $('error');
  const submit = $('submit');
  const password = $('password');

  let setup = false;
  try {
    const status = await fetch('/api/auth/status').then((r) => r.json());
    if (status.user) {
      location.replace('/');
      return;
    }
    setup = !!status.setupRequired;
  } catch {
    /* server unreachable: leave the plain sign-in form */
  }

  if (setup) {
    title.textContent = 'Create the admin account';
    subtitle.textContent = 'This first account manages users. You can add everyone else afterwards.';
    confirmRow.hidden = false;
    password.autocomplete = 'new-password';
    submit.textContent = 'Create account';
  }

  function showError(text) {
    errorEl.textContent = text;
    errorEl.hidden = false;
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    errorEl.hidden = true;
    const username = $('username').value.trim();
    const pw = password.value;
    if (setup && pw !== $('confirm').value) {
      showError('Passwords do not match');
      return;
    }
    submit.disabled = true;
    try {
      const res = await fetch(setup ? '/api/auth/setup' : '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: pw }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Sign in failed');
      location.replace('/');
    } catch (err) {
      showError(err.message);
      submit.disabled = false;
    }
  });
})();

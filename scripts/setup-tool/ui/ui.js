(function () {
  var $ = function (id) { return document.getElementById(id); };
  // The tool passes the Windows display language in the address; the browser language is only a fallback.
  var lang = (new URLSearchParams(location.search).get('lang') || (navigator.language || 'en').split('-')[0] || 'en').toLowerCase();
  var copy = null, busy = false;
  var ICON = { pending: '', done: '✓', action: '!', error: '✕' };
  function api(path, post) {
    return fetch('/api/' + path + '?lang=' + encodeURIComponent(lang), { method: post ? 'POST' : 'GET', credentials: 'same-origin',
      headers: post ? { 'Content-Type': 'application/json', 'X-SCB-Setup': '1' } : {}, body: post ? '{}' : undefined })
      .then(function (r) { if (!r.ok) throw new Error('refused'); return r.json(); });
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; }
  function render(v) {
    var s = v.state; copy = v.copy;
    document.documentElement.lang = copy.language; document.documentElement.dir = copy.rtl ? 'rtl' : 'ltr';
    document.title = copy.title;
    $('title').textContent = copy.title; $('subtitle').textContent = copy.subtitle;
    var list = $('steps'); list.textContent = '';
    s.steps.forEach(function (step, i) {
      var li = el('li', step.status); li.id = 'step-' + step.id;
      var ico = el('span', 'ico'); if (step.status === 'running') ico.appendChild(el('span', 'spin')); else ico.textContent = ICON[step.status] || String(i + 1);
      li.appendChild(ico); li.appendChild(el('span', 'label', copy['step' + (i + 1)]));
      var more = null;
      if (step.id === 'chrome' && step.status === 'action' && step.detail === 'permission') more = el('div', 'more', copy.chromePermission);
      if (step.id === 'chrome' && step.status === 'action' && step.detail === 'manual') { more = el('div', 'more', copy.chromeManual); more.appendChild(el('code', '', s.folder)); }
      if (step.id === 'suno' && step.status === 'action') more = el('div', 'more', copy.suno);
      if (step.status === 'running') { more = el('div', 'more', step.id === 'chrome' && step.detail === 'restart' ? copy.chromeRestart : copy.working); }
      if (more) li.appendChild(more);
      list.appendChild(li);
    });
    $('done').hidden = s.phase !== 'done'; $('done').textContent = s.phase === 'done' ? copy.allDone : '';
    $('note').hidden = s.phase !== 'failed'; $('note').textContent = s.phase === 'failed' ? copy.failed : '';
    $('retry').textContent = copy.retry; $('close').textContent = copy.close;
    $('retry').hidden = !(s.phase === 'failed' || s.phase === 'waiting');
    $('close').hidden = !(s.phase === 'done' || s.phase === 'failed' || s.phase === 'waiting');
  }
  function tick() { if (busy) return; api('state').then(render).catch(function () {}); }
  $('retry').addEventListener('click', function () { busy = true; api('retry', true).then(render).catch(function () {}).then(function () { busy = false; }); });
  $('close').addEventListener('click', function () { api('close', true).catch(function () {}).then(function () { try { window.close(); } catch (e) {} }); });
  tick(); setInterval(tick, 250);
})();

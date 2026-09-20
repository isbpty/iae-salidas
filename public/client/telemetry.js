/* Telemetría del navegador: pantallas y tiempo de permanencia, modales, clics, formularios
   enviados o abandonados, errores de JavaScript y visibilidad. Se envía en lotes a
   POST /api/telemetry; el servidor decide quién es el probador a partir de la cookie. */
const T = (() => {
  const BATCH = 20, EVERY_MS = 5000, MAX = 100;
  let queue = [], timer = null, enabled = false;
  let screen = null, screenSince = 0, modal = null, modalSince = 0, dirty = false, submitted = false, hidden = false;
  const now = () => Date.now();
  const short = (v) => (v == null ? null : String(v).slice(0, 120));

  function push(ev) {
    if (!enabled) return;
    queue.push({ at: now(), screen: ev.screen === undefined ? screen : ev.screen, ...ev });
    if (queue.length >= BATCH) flush();
    else if (!timer) timer = setTimeout(flush, EVERY_MS);
  }
  async function flush(beacon) {
    clearTimeout(timer); timer = null;
    if (!queue.length) return;
    const batch = queue.splice(0, MAX);
    const body = JSON.stringify({ events: batch });
    if (beacon && navigator.sendBeacon) { navigator.sendBeacon('/api/telemetry', new Blob([body], { type: 'application/json' })); return; }
    try {
      const r = await fetch('/api/telemetry', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true });
      if (r.status === 401) { queue = []; enabled = false; }
    } catch { /* la telemetría nunca molesta al usuario */ }
  }

  /* Pantalla actual: al cambiar, cierra la anterior con su duración. */
  function setScreen(name) {
    if (name === screen) return;
    if (screen) push({ kind: 'screen_leave', name: screen, screen, durationMs: now() - screenSince });
    screen = name; screenSince = now();
    if (screen) push({ kind: 'screen_enter', name: screen, screen });
  }
  function setModal(name) {
    if (name === modal) return;
    if (modal) {
      const abandoned = dirty && !submitted;
      push({ kind: 'modal_close', name: modal, screen: 'modal:' + modal, durationMs: now() - modalSince, data: { abandoned, submitted } });
      if (abandoned) push({ kind: 'form_abandon', name: modal, screen: 'modal:' + modal });
    }
    modal = name; modalSince = now(); dirty = false; submitted = false;
    if (modal) push({ kind: 'modal_open', name: modal, screen: 'modal:' + modal });
  }
  function formSubmitted(name) { submitted = true; push({ kind: 'form_submit', name, screen: modal ? 'modal:' + modal : screen }); }

  function onClick(e) {
    const el = e.target.closest && e.target.closest('[data-action]');
    if (!el || !enabled) return;
    const d = {};
    for (const [k, v] of Object.entries(el.dataset)) if (k !== 'action') d[k] = short(v);
    const target = el.dataset.id || el.dataset.tab || el.dataset.view || el.dataset.modal || el.dataset.f || el.dataset.status || null;
    push({ kind: 'click', name: el.dataset.action, target: short(target), data: Object.keys(d).length ? d : null });
  }
  function onInput(e) { if (modal && e.target.closest && e.target.closest('#modal form')) dirty = true; }
  function onError(e) {
    const err = e.error || e.reason || e.message || e;
    const stack = err && err.stack ? String(err.stack).split('\n').slice(0, 4).join('\n') : null;
    push({ kind: e.type === 'unhandledrejection' ? 'promise_rejection' : 'js_error', name: e.type, error: short(err && err.message ? err.message : String(err)).slice(0, 300), data: stack ? { stack } : null });
  }
  function onVisibility() {
    if (document.hidden && !hidden) { hidden = true; push({ kind: 'visibility', name: 'hidden' }); const s = screen; setScreen(null); screen = s; screenSince = 0; }
    else if (!document.hidden && hidden) { hidden = false; screenSince = now(); if (screen) push({ kind: 'screen_enter', name: screen, screen }); push({ kind: 'visibility', name: 'visible' }); }
  }
  function onPageHide() {
    if (!enabled) return;
    if (modal) setModal(null);
    if (screen && screenSince) push({ kind: 'screen_leave', name: screen, screen, durationMs: now() - screenSince });
    push({ kind: 'session_end', name: 'pagehide' });
    flush(true);
  }

  document.addEventListener('click', onClick, true);
  document.addEventListener('input', onInput, true);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onError);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);

  return {
    start() { if (enabled) return; enabled = true; push({ kind: 'session_start', name: 'app', data: { width: window.innerWidth, height: window.innerHeight, lang: navigator.language } }); },
    stop() { if (!enabled) return; onPageHide(); enabled = false; screen = null; modal = null; },
    screen: setScreen, modal: setModal, formSubmitted, push, flush,
  };
})();

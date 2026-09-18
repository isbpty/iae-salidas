/* Connected persistence/auth adapter. The original UI and renderers remain untouched. */
(() => {
  const originalSave = window.save;
  let remoteReady = false, timer = null, syncing = false, currentUser = null;
  const api = async (path, opts = {}) => {
    const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
    const value = await res.json();
    if (!res.ok) throw Object.assign(new Error(value.error || res.status), { status: res.status });
    return value;
  };
  const sync = () => {
    if (!remoteReady || syncing) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      syncing = true;
      try { await api('/api/prototype-state', { method: 'PUT', body: JSON.stringify({ state: S }) }); setBadge('conectado'); }
      catch { setBadge('sin conexión'); }
      finally { syncing = false; }
    }, 120);
  };
  window.save = function connectedSave() { originalSave(); sync(); };
  function setBadge(text) {
    let badge = document.getElementById('connectedStatus');
    if (!badge) { badge = document.createElement('span'); badge.id = 'connectedStatus'; badge.className = 'muted small'; document.querySelector('.brand').append(' · ', badge); }
    badge.textContent = text;
  }
  function lockIdentity() {
    if (!currentUser) return;
    const { personId, phoneId, staffId } = currentUser.prototypeIdentity || {};
    if (personId) UI.parentId = personId;
    if (phoneId) UI.phoneId = phoneId;
    if (staffId) UI.staffId = staffId;
    UI.view = currentUser.role === 'parent' ? 'parents' : 'school';
    if (currentUser.role === 'gate') UI.schoolTab = 'salidas_hoy';
    if (currentUser.role === 'monitora') UI.schoolTab = 'rutas';
  }
  async function start() {
    try {
      currentUser = (await api('/api/state')).currentUser;
    } catch (error) {
      if (error.status === 401) return login();
      setBadge('sin conexión'); return;
    }
    const remote = await api('/api/prototype-state');
    if (remote.state) S = remote.state;
    else await api('/api/prototype-state', { method: 'PUT', body: JSON.stringify({ state: S, initialize: true }) });
    lockIdentity(); remoteReady = true; originalSave(); render(); setBadge('conectado');
    const events = new EventSource('/api/events');
    events.onmessage = async e => {
      if (JSON.parse(e.data).type !== 'prototype.changed' || syncing) return;
      const next = await api('/api/prototype-state');
      if (next.state) { S = next.state; originalSave(); render(); setBadge('conectado'); }
    };
  }
  async function login() {
    const options = await api('/api/auth/options');
    const modal = document.getElementById('modal');
    modal.className = 'modal';
    modal.innerHTML = `<div class="modal-card" style="max-width:420px"><h2>🏫 Entrar a IAE Salidas</h2><p class="muted">Piloto conectado</p><form id="connectedLogin" class="form"><label>Usuario<select name="userId">${options.map(x => `<option value="${esc(x.id)}">${esc(x.name)} · ${esc(x.role)}</option>`).join('')}</select></label><label>PIN<input name="pin" type="password" inputmode="numeric" required autofocus></label><button class="btn primary big">Entrar</button><div id="loginError" class="danger-text small"></div></form></div>`;
    document.getElementById('connectedLogin').onsubmit = async e => {
      e.preventDefault(); const data = Object.fromEntries(new FormData(e.target));
      try { await api('/api/auth/login', { method: 'POST', body: JSON.stringify(data) }); modal.className = 'modal hidden'; start(); }
      catch { document.getElementById('loginError').textContent = 'Usuario o PIN incorrecto.'; }
    };
  }
  window.addEventListener('DOMContentLoaded', start);
})();

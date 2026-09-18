/* Estado del cliente: la proyección V que manda el servidor y el estado de interfaz UI. */
let V = null, ME = null, REV = 0, SKEW = 0;
const UI = { view: 'parents', split: false, phoneId: 'p1', schoolTab: 'inicio', parentTab: 'inicio', modal: null, filter: 'todas', busy: false };
const FORM_MODALS = ['newSalida', 'newExcusa', 'newAuth', 'reject', 'scan'];
let markTimer = null, subscribed = false;

function setBadge(text) { const el = document.getElementById('connectedStatus'); if (el) el.textContent = text; }
function serverNow() { return Date.now() + SKEW; }
function formOpen() { return !!(UI.modal && FORM_MODALS.includes(UI.modal.type)); }
function toast(text, kind = 'info') {
  const box = document.getElementById('toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = text;
  box.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, 6000);
}
function toastNewNotifications(prev, next) {
  const seen = new Set((prev.notifications || []).map((n) => n.id));
  for (const n of next.notifications || []) if (!seen.has(n.id) && !n.read) toast((ME.role === 'parent' ? '📲 ' : '🏫 ') + n.text, ME.role === 'parent' ? 'wa' : 'school');
}
function adopt(payload) {
  const prev = V;
  V = payload.view; REV = payload.revision; ME = V.user; SKEW = V.serverNow - Date.now();
  if (prev && prev.user.id === ME.id) toastNewNotifications(prev, V);
}
async function refresh() {
  try {
    const r = await api.view('"' + REV + '"');
    if (r.notModified) return;
    adopt(r); setBadge('conectado · ' + ME.name);
    if (!formOpen()) render();
  } catch (e) { if (e.status === 401) return showLogin(); setBadge('sin conexión'); }
}
/* Ejecuta un comando y adopta la vista que devuelve. Lanza el error para que quien llama no siga. */
async function apply(name, input) {
  UI.busy = true; setBadge('guardando…');
  try { const r = await api.command(name, input); adopt(r); setBadge('conectado · ' + ME.name); return r.result; }
  catch (e) { if (e.status === 401) showLogin(); else toast('No se pudo guardar: ' + e.message, 'error'); throw e; }
  finally { UI.busy = false; }
}
function markReadSoon() {
  if (!V || !V.unread || markTimer) return;
  markTimer = setTimeout(() => { markTimer = null; apply('mark_notifications_read', {}).then(() => render()).catch(() => {}); }, 800);
}
async function boot() {
  try { const r = await api.view(); adopt(r); afterLogin(); }
  catch (e) { if (e.status === 401) showLogin(); else setBadge('sin conexión'); }
}
function afterLogin() {
  UI.view = ME.role === 'parent' ? 'parents' : 'school';
  UI.schoolTab = ME.role === 'garita' ? 'salidas_hoy' : ME.role === 'monitora' ? 'rutas' : 'inicio';
  UI.phoneId = ME.role === 'parent' ? V.me.id : 'p1';
  document.getElementById('splitWrap').style.display = ME.role === 'admin' ? '' : 'none';
  document.getElementById('resetBtn').style.display = ME.role === 'admin' ? '' : 'none';
  document.getElementById('logoutBtn').style.display = '';
  setBadge('conectado · ' + ME.name);
  render();
  if (!subscribed) { subscribed = true; api.subscribe(refresh); }
}
async function showLogin() {
  setBadge('inicia sesión');
  let options = [];
  try { options = await api.options(); } catch { setBadge('sin conexión'); return; }
  const modal = document.getElementById('modal');
  modal.className = 'modal';
  modal.innerHTML = '<div class="modal-card" style="max-width:420px"><h2>🏫 Entrar a IAE Salidas</h2><p class="muted">Elige tu usuario y escribe el PIN del piloto.</p>' +
    '<form id="loginForm" class="form"><label>Usuario<select name="userId">' + options.map((x) => '<option value="' + esc(x.id) + '">' + esc(x.name) + ' · ' + esc(roleName(x.role)) + '</option>').join('') + '</select></label>' +
    '<label>PIN<input name="pin" type="password" inputmode="numeric" required autofocus></label><button class="btn primary big">Entrar</button><div id="loginError" class="danger-text small"></div></form></div>';
  document.getElementById('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    try { await api.login(data.userId, data.pin); modal.className = 'modal hidden'; modal.innerHTML = ''; boot(); }
    catch (err) { document.getElementById('loginError').textContent = err.status === 429 ? 'Demasiados intentos. Espera 15 minutos.' : 'Usuario o PIN incorrecto.'; }
  };
}
async function doLogout() { try { await api.logout(); } finally { location.reload(); } }

/* Estado del cliente: la proyección V que manda el servidor y el estado de interfaz UI. */
let V = null, ME = null, REV = 0, SKEW = 0;
const UI = { view: 'parents', split: false, phoneId: 'p1', schoolTab: 'inicio', parentTab: 'inicio', modal: null, filter: 'todas', busy: false };
const FORM_MODALS = ['newSalida', 'newExcusa', 'newAuth', 'reject', 'scan'];
let markTimer = null, subscribed = false;
/* Mientras el formulario de login está en pantalla nadie más toca el modal:
   el sondeo sigue dando 401 y volvería a redibujarlo mientras se escribe el PIN. */
let loginShowing = false;

function setBadge(text) { const el = document.getElementById('connectedStatus'); if (el) el.textContent = text; }
function connectedText() { return 'conectado · ' + ME.name + (V.tester && V.tester.id ? ' · ' + V.tester.name : ''); }
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
  if (loginShowing) return;
  try {
    const r = await api.view('"' + REV + '"');
    if (r.notModified) return;
    adopt(r); setBadge(connectedText());
    if (!formOpen()) render();
  } catch (e) { if (e.status === 401) return showLogin(); setBadge('sin conexión'); }
}
/* Ejecuta un comando y adopta la vista que devuelve. Lanza el error para que quien llama no siga. */
async function apply(name, input) {
  UI.busy = true; setBadge('guardando…');
  try { const r = await api.command(name, input); adopt(r); setBadge(connectedText()); return r.result; }
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
  document.getElementById('switchBtn').style.display = '';
  document.getElementById('simBtn').style.display = '';
  setBadge(connectedText());
  T.start();
  render();
  if (!subscribed) { subscribed = true; api.subscribe(refresh, V.realtime); }
}
const loginErrorText = (err) => (err.status === 429 ? 'Demasiados intentos. Espera 15 minutos.' : err.status === 401 ? 'PIN incorrecto.' : 'Sin conexión. Intenta de nuevo.');
const userOption = (x) => '<option value="' + esc(x.id) + '">' + esc(x.name) + ' · ' + esc(roleName(x.role)) + '</option>';
/* Login en dos pasos en la misma tarjeta: primero el PIN (dice quién prueba), luego el usuario del demo. */
async function showLogin() {
  if (loginShowing) return;
  loginShowing = true;
  setBadge('inicia sesión');
  const modal = document.getElementById('modal');
  modal.className = 'modal';
  const card = (inner) => '<div class="modal-card" style="max-width:420px"><h2>🏫 Entrar a IAE Salidas</h2>' + inner + '</div>';
  const stepPin = () => {
    modal.innerHTML = card('<p class="muted">Escribe tu PIN de probador (o el PIN del piloto).</p>' +
      '<form id="loginForm" class="form"><label>PIN<input name="pin" type="password" inputmode="numeric" autocomplete="one-time-code" required autofocus></label>' +
      '<button class="btn primary big">Continuar</button><div id="loginError" class="danger-text small"></div></form>');
    document.getElementById('loginForm').onsubmit = async (e) => {
      e.preventDefault();
      const pin = new FormData(e.target).get('pin');
      try { stepUser(await api.pin(pin)); }
      catch (err) { document.getElementById('loginError').textContent = loginErrorText(err); }
    };
  };
  const stepUser = (r) => {
    const who = r.tester ? '👋 Hola, <b>' + esc(r.tester.name) + '</b>. ' : '';
    modal.innerHTML = card('<p class="muted">' + who + 'Elige con qué usuario del demo quieres entrar.</p>' +
      '<form id="loginForm" class="form"><label>Usuario<select name="userId" autofocus>' + r.options.map(userOption).join('') + '</select></label>' +
      '<button class="btn primary big">Entrar</button><button class="btn" type="button" id="loginBack">Cambiar PIN</button><div id="loginError" class="danger-text small"></div></form>');
    document.getElementById('loginBack').onclick = stepPin;
    document.getElementById('loginForm').onsubmit = async (e) => {
      e.preventDefault();
      const userId = new FormData(e.target).get('userId');
      try { await api.login(userId, { pinToken: r.pinToken }); modal.className = 'modal hidden'; modal.innerHTML = ''; loginShowing = false; boot(); }
      catch (err) { document.getElementById('loginError').textContent = err.status === 401 ? 'El PIN caducó. Vuelve a escribirlo.' : loginErrorText(err); }
    };
  };
  stepPin();
}
/* Mismo probador, otro usuario del demo: no hace falta el PIN otra vez. */
async function showSwitch() {
  let options = [];
  try { options = await api.options(); } catch { toast('Sin conexión', 'error'); return; }
  const modal = document.getElementById('modal');
  UI.modal = null;
  modal.className = 'modal';
  modal.innerHTML = '<div class="modal-card" style="max-width:420px"><button class="modal-x" id="switchClose">✕</button><h2>🔁 Cambiar de usuario</h2><p class="muted">Sigues siendo <b>' + esc(V.tester ? V.tester.name : '') + '</b>; solo cambia el usuario del demo.</p>' +
    '<form id="switchForm" class="form"><label>Usuario<select name="userId">' + options.map(userOption).join('') + '</select></label><button class="btn primary big">Cambiar</button></form></div>';
  document.getElementById('switchClose').onclick = () => { modal.className = 'modal hidden'; modal.innerHTML = ''; };
  document.getElementById('switchForm').onsubmit = async (e) => {
    e.preventDefault();
    const userId = new FormData(e.target).get('userId');
    try { T.flush(true); await api.switchUser(userId); location.reload(); }
    catch (err) { toast('No se pudo cambiar: ' + err.message, 'error'); }
  };
}
async function doLogout() { try { T.stop(); await api.logout(); } finally { location.reload(); } }

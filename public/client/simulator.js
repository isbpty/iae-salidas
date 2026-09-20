/* Simulador: recorre el guion del demo manejando la app de verdad (comandos reales contra el servidor),
   con un foco sobre lo que toca, un cursor animado, una explicación arriba y una barra de control abajo
   (play/pausa, paso a paso, velocidad ½x·1x·2x). Cambia de usuario cuando el paso lo necesita y al
   terminar devuelve el usuario con el que se empezó. Todo vive en el cliente. */
const SIM = { active: false, playing: false, stepMode: false, speed: 1, stepNo: 0, title: '', text: '', startUser: null, abort: false, waiters: [], confirmBackup: null, startedAt: 0, pauses: 0, completed: false };
class SimAbort extends Error {}

const USERS = { u_p1: 'Carlos (papá)', u_s1: 'Administración', u_s2: 'Recepción', u_s3: 'Prof. Diana (3°)', u_s5: 'Prof. Mónica (Kínder)', u_s6: 'Garita', u_s7: 'Monitora Bus 12' };

/* ---------- primitivas (cada una es un "paso" en modo paso a paso) ---------- */
const simSleep = async (ms) => {
  const end = Date.now() + ms / SIM.speed;
  while (Date.now() < end) { if (SIM.abort) throw new SimAbort(); await simGate(); await new Promise((r) => setTimeout(r, 60)); }
};
function simGate() {
  if (SIM.abort) throw new SimAbort();
  if (SIM.playing) return Promise.resolve();
  return new Promise((resolve) => SIM.waiters.push(resolve));
}
function simResume() { const w = SIM.waiters.splice(0); w.forEach((r) => r()); }
const prim = (fn) => async (...a) => {
  await simGate();
  const r = await fn(...a);
  if (SIM.stepMode) { SIM.playing = false; simBar(); }
  return r;
};
async function simWaitFor(test, timeout = 20000, label = '') {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (SIM.abort) throw new SimAbort();
    const v = typeof test === 'function' ? test() : document.querySelector(test);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('El simulador no encontró ' + (label || String(test)));
}
const byText = (sel, re) => [...document.querySelectorAll(sel)].find((el) => re.test(el.textContent.trim())) || null;
/* Botón dentro de la tarjeta que menciona a alguien (hay más solicitudes en la bandeja que las del guion). */
const inCard = (cardSel, re, btnSel) => () => { const c = [...document.querySelectorAll(cardSel)].find((x) => re.test(x.textContent) && x.querySelector(btnSel)); return c ? c.querySelector(btnSel) : null; };

const S = {
  say: prim(async (text, ms = 1800) => { SIM.text = text; simCaption(); await simSleep(ms); }),
  as: prim(async (userId) => {
    if (ME.id === userId) return;
    SIM.text = 'Cambiando al usuario ' + (USERS[userId] || userId) + '…'; simCaption(); simSpot(null);
    await api.switchUser(userId);
    const r = await api.view(); adopt(r); afterLogin();
    await simSleep(700);
  }),
  view: prim(async (view, tab) => {
    if (view) UI.view = view;
    if (tab && view === 'parents') UI.parentTab = tab;
    if (tab && view === 'school') UI.schoolTab = tab;
    UI.modal = null;
    render();
    await simSleep(600);
  }),
  /* El sondeo puede repintar la pantalla entre que se encuentra el botón y se pulsa: se vuelve a buscar justo antes del clic. */
  click: prim(async (target, label) => {
    const el = await simWaitFor(target, 20000, label || String(target));
    await simSpot(el); await simSleep(650);
    const live = document.contains(el) ? el : (typeof target === 'function' ? target() : document.querySelector(target)) || el;
    simCursorClick(); live.click();
    await simSleep(350);
  }),
  type: prim(async (target, text) => {
    let el = await simWaitFor(target, 20000, target);
    await simSpot(el);
    for (const ch of text) {
      if (!document.contains(el)) el = document.querySelector(target) || el;
      el.focus(); el.value = (el.value || '') + ch; el.dispatchEvent(new Event('input', { bubbles: true })); await simSleep(60);
    }
    await simSleep(300);
  }),
  spot: prim(async (target, ms = 1500) => { const el = await simWaitFor(target, 20000, String(target)); await simSpot(el); await simSleep(ms); }),
  /* Espera al servidor y a que el bot termine de "escribir". */
  settle: prim(async () => {
    await simWaitFor(() => !UI.busy, 30000, 'la respuesta del servidor');
    await simWaitFor(() => !UI.busy && !document.querySelector('.bubble.typing'), 30000, 'la respuesta del bot');
    await simSleep(500);
  }),
  wait: prim(async (ms) => simSleep(ms)),
  chip: async (re) => S.click(() => byText('.wa-chips .chip, .wa-btns .wa-btn', re), 'el botón "' + re.source + '"'),
};

/* ---------- guion ---------- */
const SIM_SCRIPT = [
  { title: 'El papá pide una salida por WhatsApp', run: async () => {
    await S.as('u_p1'); await S.view('whatsapp');
    await S.say('Carlos escribe al WhatsApp de la escuela. Los chips son ejemplos: en la vida real escribe con sus palabras.');
    await S.chip(/^Necesito retirar a Joseph/); await S.settle();
    await S.say('El bot entendió el hijo, la hora y quién retira, y pide confirmación.');
    await S.chip(/^Sí$/); await S.settle();
    await S.say('Cumple la regla (titular, 2 h de anticipación, sin rechazos): se auto-aprueba y llegan el punto de retiro y el código.', 2600);
  } },
  { title: 'La abuela retira con poca anticipación: Recepción decide', run: async () => {
    await S.as('u_p1'); await S.view('whatsapp');
    await S.chip(/lo va a retirar la abuela/); await S.settle();
    await S.chip(/^Sí$/); await S.settle();
    await S.say('Solo 30 minutos de anticipación: no cumple la regla y queda pendiente para la escuela.');
    await S.as('u_s2'); await S.view('school', 'inicio');
    await S.say('Recepción ve la solicitud en "Requieren acción" en el mismo instante, con la persona y su cédula.');
    await S.click(inCard('.card.req', /Joseph/, '[data-action=approve]'), 'el botón Aprobar de la salida de Joseph'); await S.settle();
    await S.say('Aprobada en un clic. Carlos y Ana reciben el punto de retiro y el código por WhatsApp.', 2400);
  } },
  { title: 'Garita verifica la cédula y marca la salida', run: async () => {
    await S.as('u_s6'); await S.view('school', 'salidas_hoy');
    await S.say('La garita solo ve las salidas aprobadas de hoy, con la foto o cédula de quien retira.');
    await S.click(inCard('.card.gate', /Joseph/, '[data-action=markExit]'), 'el botón de marcar retirado de Joseph'); await S.settle();
    await S.say('Retirado. Los dos titulares reciben "salió por Puerta Principal, confirmó el oficial".', 2400);
  } },
  { title: 'Autorización de una sola vez, con confirmación del titular', run: async () => {
    await S.as('u_p1'); await S.view('whatsapp');
    await S.chip(/^Hoy retira a Joseph/); await S.settle();
    await S.chip(/^Sí$/); await S.settle();
    await S.say('Laura Gómez está autorizada solo por hoy: nunca se auto-aprueba.');
    await S.as('u_s2'); await S.view('school', 'inicio');
    await S.click(inCard('.card.req', /Joseph[\s\S]*Laura/, '[data-action=approve]'), 'el botón Aprobar de la salida con Laura'); await S.settle();
    await S.say('Aviso proactivo: como es una autorización nueva, los titulares reciben "¿Es correcto?" con botones.');
    await S.as('u_p1'); await S.view('whatsapp');
    await S.chip(/correcto/i); await S.settle();
    await S.as('u_s6'); await S.view('school', 'salidas_hoy');
    await S.say('Laura llega a la garita. Antes de entregar, el oficial pide confirmación a los titulares.');
    await S.click(inCard('.card.gate', /Laura/, '[data-action=askConfirm]'), 'el botón de solicitar confirmación'); await S.settle();
    await S.as('u_p1'); await S.view('whatsapp');
    await S.chip(/^Sí, confirmo/); await S.settle();
    await S.as('u_s6'); await S.view('school', 'salidas_hoy');
    await S.click(inCard('.card.gate', /Laura/, '[data-action=markExit]'), 'la salida de Laura');
    await S.settle();
    await S.say('Con la confirmación registrada, la garita entrega. Todo queda en el historial.', 2400);
  } },
  { title: 'Excusa por WhatsApp y bandeja de la profesora', run: async () => {
    await S.as('u_p1'); await S.view('whatsapp');
    await S.chip(/no irá mañana/); await S.settle();
    await S.say('El bot arma la excusa; el papá puede adjuntar el certificado con 📎 antes de confirmar.');
    await S.chip(/^Sí$/); await S.settle();
    await S.as('u_s2'); await S.view('school', 'excusas');
    await S.click(inCard('.card.req', /Sofía/, '[data-action=acceptExcusa]'), 'el botón Aceptar de la excusa de Sofía'); await S.settle();
    await S.as('u_s5'); await S.view('school', 'excusas');
    await S.spot(() => [...document.querySelectorAll('.card.req')].find((x) => /Sofía/.test(x.textContent)) || document.querySelector('.card.req'), 2000);
    await S.say('La profesora de Kínder solo ve las excusas de su grado.', 2000);
  } },
  { title: 'La app de padres', run: async () => {
    await S.as('u_p1'); await S.view('parents', 'inicio');
    await S.spot('.card.kid', 1500);
    await S.say('Hijos, titulares, autorizados, bus y accesos rápidos.');
    await S.view('parents', 'solicitudes');
    await S.spot('.card.req', 1800);
    await S.say('Cada salida aprobada muestra su QR y su código para la garita.');
    await S.view('parents', 'autorizados');
    await S.spot('.card', 1500);
    await S.say('Autorizados "siempre", "por tiempo" o "una vez"; se pueden agregar con foto o cédula.', 2200);
  } },
  { title: 'Permisos por rol', run: async () => {
    await S.as('u_s3'); await S.view('school', 'estudiantes');
    await S.spot('.tbl', 1800);
    await S.say('La profesora Diana solo ve a los estudiantes de 3°.');
    await S.as('u_s1'); await S.view('school', 'personal');
    await S.spot(() => document.querySelectorAll('.tbl')[1] || document.querySelector('.tbl'), 1800);
    await S.say('Administración edita la matriz de permisos por rol.');
    await S.view('school', 'config');
    await S.spot('input[name=autoApprove]', 1800);
    await S.say('…y la regla de auto-aprobación (minutos de anticipación, punto de retiro).', 2000);
  } },
  { title: '¿Dónde está mi hijo? (GPS del bus)', run: async () => {
    await S.as('u_p1'); await S.view('whatsapp');
    await S.say('El papá pregunta con sus palabras; Joseph ya salió hoy, así que pregunta por Sofía, que va en el bus.');
    await S.type('#waInput', '¿Dónde está Sofía?');
    await S.click('.wa-send', 'enviar'); await S.settle();
    await S.spot(() => document.querySelector('.wa-chat .map-wrap') || [...document.querySelectorAll('.wa-chat .bubble.in')].pop(), 2500);
    await S.say('Responde con el bus, la próxima parada, el tiempo estimado y el mapa (GPS simulado con la forma de la API real). Si ya salió, responde por dónde y quién lo confirmó.', 2800);
  } },
  { title: 'La monitora del bus', run: async () => {
    await S.as('u_s7'); await S.view('school', 'rutas');
    await S.say('Kenia solo ve el Bus 12 y marca quién abordó o bajó.');
    await S.click(inCard('.route-card', /Joseph/, '[data-action=board][data-status=abordo]'), 'el botón Abordó'); await S.settle();
    await S.as('u_p1'); await S.view('whatsapp');
    await S.chip(/hoy no va en el bus/); await S.settle();
    await S.say('"Hoy no va en bus" le llega a la monitora al instante.');
    await S.as('u_s7'); await S.view('school', 'rutas');
    await S.spot(() => byText('.badge', /Hoy no va/), 2200);
  } },
  { title: 'Escanear el QR en la garita', run: async () => {
    await S.as('u_s6'); await S.view('school', 'salidas_hoy');
    await S.click('[data-modal=scan]', 'el botón de escanear');
    const code = (V.requests.find((r) => r.kind === 'salida' && r.status === 'aprobada' && r.date === todayISO()) || {}).code || '0000';
    await S.type('input[name=code]', String(code));
    await S.click('form[data-form=scan] button[type=submit]', 'Buscar'); await S.settle();
    await S.say('El código trae la foto o cédula del autorizado y a quién retira.');
    await S.click('#modal [data-action=markExit]', 'marcar retirado'); await S.settle();
  } },
  { title: 'Vista dividida para el demo', run: async () => {
    await S.as('u_s1'); await S.view('school', 'inicio');
    UI.split = true; const t = document.getElementById('splitToggle'); if (t) t.checked = true; render();
    await S.say('Administración puede ver WhatsApp y el dashboard a la vez. Cada dispositivo del piloto entra con su propio usuario.', 3200);
    UI.split = false; if (t) t.checked = false; render();
  } },
  { title: 'Fin del recorrido', run: async () => {
    await S.say('Fin del recorrido. Todo lo que viste quedó guardado en el servidor: bitácora, notificaciones e historial.', 2500);
  } },
];

/* ---------- interfaz del simulador ---------- */
function simEl() {
  let el = document.getElementById('sim');
  if (el) return el;
  el = document.createElement('div'); el.id = 'sim'; el.className = 'sim hidden';
  el.innerHTML = '<div class="sim-shade"></div><div class="sim-spot"></div><div class="sim-cursor"><svg width="26" height="30" viewBox="0 0 26 30"><path d="M2 2 L2 24 L8 18 L12 28 L16 26 L12 17 L20 17 Z" fill="#fff" stroke="#111" stroke-width="2" stroke-linejoin="round"/></svg></div>' +
    '<div class="sim-caption"><div class="sim-step"></div><div class="sim-text"></div></div>' +
    '<div class="sim-bar"><button class="btn small" data-sim="toggle" title="Play / Pausa">⏸ Pausa</button><button class="btn small" data-sim="step" title="Ejecuta la siguiente acción y se detiene">⏭ Paso a paso</button>' +
    '<span class="sim-speed"><button class="chip" data-sim="speed" data-v="0.5">½x</button><button class="chip active" data-sim="speed" data-v="1">1x</button><button class="chip" data-sim="speed" data-v="2">2x</button></span>' +
    '<span class="sim-progress muted small"></span><button class="btn small danger" data-sim="exit">✕ Salir</button></div>';
  document.body.appendChild(el);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sim]'); if (!b) return;
    const k = b.dataset.sim;
    if (k === 'toggle') { SIM.stepMode = false; SIM.playing = !SIM.playing; T.push({ kind: 'simulator', name: SIM.playing ? 'resume' : 'pause', target: String(SIM.stepNo) }); if (SIM.playing) simResume(); }
    if (k === 'step') { SIM.stepMode = true; SIM.playing = true; T.push({ kind: 'simulator', name: 'step_mode', target: String(SIM.stepNo) }); simResume(); }
    if (k === 'speed') { SIM.speed = Number(b.dataset.v); T.push({ kind: 'simulator', name: 'speed', target: String(SIM.speed), data: { speed: SIM.speed } }); }
    if (k === 'exit') { T.push({ kind: 'simulator', name: 'exit', target: String(SIM.stepNo) }); simStop(); return; }
    simBar();
  });
  return el;
}
function simBar() {
  const el = simEl();
  el.querySelector('[data-sim=toggle]').textContent = SIM.playing && !SIM.stepMode ? '⏸ Pausa' : '▶ Play';
  el.querySelectorAll('[data-sim=speed]').forEach((c) => c.classList.toggle('active', Number(c.dataset.v) === SIM.speed));
  el.querySelector('.sim-progress').textContent = 'paso ' + SIM.stepNo + ' de ' + SIM_SCRIPT.length + (SIM.playing ? (SIM.stepMode ? ' · paso a paso' : '') : ' · en pausa: puedes usar la app');
  el.classList.toggle('paused', !SIM.playing);
  simCaption();
}
function simCaption() {
  const el = simEl();
  el.querySelector('.sim-step').textContent = 'Paso ' + SIM.stepNo + ' de ' + SIM_SCRIPT.length + ' · ' + SIM.title;
  el.querySelector('.sim-text').textContent = SIM.text;
}
async function simSpot(target) {
  const el = simEl(); const spot = el.querySelector('.sim-spot'); const cur = el.querySelector('.sim-cursor');
  if (!target) { spot.style.opacity = '0'; return; }
  target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
  await new Promise((r) => setTimeout(r, 350));
  const r = target.getBoundingClientRect();
  spot.style.opacity = '1';
  spot.style.left = (r.left - 6) + 'px'; spot.style.top = (r.top - 6) + 'px'; spot.style.width = (r.width + 12) + 'px'; spot.style.height = (r.height + 12) + 'px';
  cur.style.left = (r.left + Math.min(r.width / 2, 120)) + 'px'; cur.style.top = (r.top + r.height / 2) + 'px'; cur.style.opacity = '1';
}
function simCursorClick() { const cur = simEl().querySelector('.sim-cursor'); cur.classList.remove('click'); void cur.offsetWidth; cur.classList.add('click'); }

/* ---------- arranque y parada ---------- */
async function simStart() {
  if (SIM.active || !V || UI.busy) return;
  /* Reservar la instancia antes del diálogo y del reinicio: un segundo clic en esos segundos arrancaba otro recorrido en paralelo. */
  SIM.active = true; SIM.runId = (SIM.runId || 0) + 1;
  const btn = document.getElementById('simBtn'); if (btn) btn.disabled = true;
  const reset = confirm('El simulador recorre el guion del demo manejando la app de verdad.\n¿Reiniciar antes los datos de ejemplo para que el recorrido salga igual que siempre?');
  const startUser = ME.id;
  if (reset) {
    setBadge('reiniciando demo…');
    try {
      /* Solo Administración puede reiniciar: se cambia de usuario un momento y se vuelve al final. */
      if (ME.role !== 'admin') { await api.switchUser('u_s1'); const r = await api.view(); adopt(r); afterLogin(); }
      await apply('reset_demo', {});
    } catch { /* apply ya avisó */ }
  }
  SIM.playing = true; SIM.stepMode = false; SIM.abort = false; SIM.stepNo = 0; SIM.startUser = startUser; SIM.text = ''; SIM.startedAt = Date.now(); SIM.completed = false;
  SIM.confirmBackup = window.confirm; window.confirm = () => true;
  const el = simEl(); el.classList.remove('hidden');
  T.push({ kind: 'simulator', name: 'start', data: { reset, user: ME.id, speed: SIM.speed } });
  try {
    for (let i = 0; i < SIM_SCRIPT.length; i++) {
      SIM.stepNo = i + 1; SIM.title = SIM_SCRIPT[i].title; SIM.text = ''; simBar();
      T.push({ kind: 'simulator', name: 'step', target: String(i + 1), data: { title: SIM.title } });
      await SIM_SCRIPT[i].run();
    }
    SIM.completed = true;
  } catch (e) {
    if (!(e instanceof SimAbort)) { console.error(e); toast('El simulador se detuvo: ' + e.message, 'error'); T.push({ kind: 'simulator', name: 'error', target: String(SIM.stepNo), error: String(e.message).slice(0, 200), data: { step: SIM.stepNo, title: SIM.title } }); }
  }
  await simFinish();
}
function simStop() { if (!SIM.active) return; SIM.abort = true; SIM.playing = true; simResume(); }
async function simFinish() {
  window.confirm = SIM.confirmBackup || window.confirm;
  SIM.active = false; SIM.playing = false; SIM.waiters = [];
  const btn = document.getElementById('simBtn'); if (btn) btn.disabled = false;
  const el = simEl(); el.classList.add('hidden'); el.querySelector('.sim-spot').style.opacity = '0'; el.querySelector('.sim-cursor').style.opacity = '0';
  T.push({ kind: 'simulator', name: 'end', target: String(SIM.stepNo), durationMs: Date.now() - SIM.startedAt, data: { completed: SIM.completed, stepsDone: SIM.completed ? SIM_SCRIPT.length : Math.max(0, SIM.stepNo - 1), totalSteps: SIM_SCRIPT.length } });
  T.flush();
  try {
    if (SIM.startUser && ME && ME.id !== SIM.startUser) { await api.switchUser(SIM.startUser); const r = await api.view(); adopt(r); afterLogin(); }
    else render();
  } catch { location.reload(); }
}
document.addEventListener('DOMContentLoaded', () => {
  const b = document.getElementById('simBtn');
  if (b) b.addEventListener('click', () => simStart());
});

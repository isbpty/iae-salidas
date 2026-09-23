/* Cliente HTTP mínimo. Todas las respuestas de comandos traen la proyección fresca (view). */
const api = (() => {
  /* R4: sondeo de la vista. 3 s en primer plano para garita/recepción/admin (necesitan verlo al instante),
     10 s para padres/profesores/monitoras; en pausa con la pestaña oculta (un refresco al volver a primer
     plano); *backoff* hasta 30 s tras 10 sondeos seguidos sin cambios; vuelve a la base tras un cambio real
     (200) o justo después de un comando propio (`resetPoll`, llamado desde `apply` en state.js). */
  const FAST_ROLES = new Set(['garita', 'recepcion', 'admin']);
  const BASE_FAST_MS = 3000, BASE_SLOW_MS = 10000, MAX_INTERVAL_MS = 30000, MISSES_TO_BACKOFF = 10;
  const currentRole = () => (typeof ME !== 'undefined' && ME && ME.role) || null;
  const baseInterval = () => (FAST_ROLES.has(currentRole()) ? BASE_FAST_MS : BASE_SLOW_MS);
  let resetPollFn = () => {};
  function startPoll(onChange) {
    let interval = baseInterval(), misses = 0, timer = null;
    const schedule = () => { if (timer) clearTimeout(timer); timer = document.hidden ? null : setTimeout(tick, interval); };
    async function tick() {
      timer = null;
      if (document.hidden) return; // pausado; `visibilitychange` lo retoma
      let changed = false;
      try { changed = await onChange(); } catch { changed = false; }
      if (changed) { interval = baseInterval(); misses = 0; }
      else { misses += 1; if (misses % MISSES_TO_BACKOFF === 0) interval = Math.min(MAX_INTERVAL_MS, interval * 2); }
      schedule();
    }
    resetPollFn = () => { interval = baseInterval(); misses = 0; };
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { if (timer) { clearTimeout(timer); timer = null; } }
      else { resetPollFn(); onChange(); schedule(); }
    });
    schedule();
  }
  async function req(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
    if (res.status === 304) return { notModified: true };
    const value = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(value.message || value.error || String(res.status)); e.status = res.status; e.code = value.error; throw e; }
    return value;
  }
  function shrinkImage(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const max = 640; const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.75));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }
  const readDataUrl = (file) => new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.onerror = reject; fr.readAsDataURL(file); });
  return {
    options: () => req('/api/auth/options'),
    /* Paso 1: el PIN identifica al probador y devuelve la lista de usuarios. Paso 2: usuario + prueba del PIN. */
    pin: (pin) => req('/api/auth/pin', { method: 'POST', body: JSON.stringify({ pin }) }),
    login: (userId, proof) => req('/api/auth/login', { method: 'POST', body: JSON.stringify({ userId, ...(typeof proof === 'string' ? { pin: proof } : proof) }) }),
    switchUser: (userId) => req('/api/auth/switch', { method: 'POST', body: JSON.stringify({ userId }) }),
    activity: (what, params) => req('/api/activity/' + what + (params && params.toString() ? '?' + params.toString() : '')),
    logout: () => req('/api/auth/logout', { method: 'POST' }),
    view: (etag) => req('/api/me/view', { headers: etag ? { 'if-none-match': etag } : {} }),
    command: (name, input) => req('/api/commands/' + name, { method: 'POST', body: JSON.stringify(input || {}) }),
    /* Convierte un File en el cuerpo de upload_attachment; las imágenes se reducen a 640 px JPEG. */
    async filePayload(file, purpose) {
      let dataUrl = await readDataUrl(file);
      if (/^image\//.test(file.type)) dataUrl = await shrinkImage(dataUrl);
      const [head, data] = dataUrl.split(',');
      const mime = (/^data:([^;]+)/.exec(head) || [])[1] || file.type;
      return { purpose, mime, name: file.name, dataBase64: data };
    },
    /* Notificación de cambios: el servidor dice cuál usar en `view.realtime`
       ('sse' en local, 'poll' donde no hay conexión larga). Si el SSE falla, se pasa a sondeo. */
    subscribe(onChange, mode) {
      if (mode === 'poll' || !window.EventSource) { startPoll(onChange); return; }
      const es = new EventSource('/api/events');
      es.onmessage = () => onChange();
      let fallenBack = false;
      es.onerror = () => { if (fallenBack) return; fallenBack = true; es.close(); startPoll(onChange); };
      setInterval(onChange, 15000); // red de seguridad si se pierde un evento
    },
    /* Tras un comando propio conviene volver a sondear a la frecuencia base: algo sí cambió. Sin efecto en
       modo SSE (no hay intervalo de sondeo que reiniciar). */
    resetPoll() { resetPollFn(); },
  };
})();

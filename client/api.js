/* Cliente HTTP mínimo. Todas las respuestas de comandos traen la proyección fresca (view). */
const api = (() => {
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
    login: (userId, pin) => req('/api/auth/login', { method: 'POST', body: JSON.stringify({ userId, pin }) }),
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
    /* Notificación de cambios: SSE en local, sondeo cada 3 s en Vercel (o si SSE falla). */
    subscribe(onChange) {
      if (window.__IAE_SERVERLESS__ || !window.EventSource) { setInterval(onChange, 3000); return; }
      const es = new EventSource('/api/events');
      es.onmessage = () => onChange();
      setInterval(onChange, 15000); // red de seguridad si se pierde un evento
    },
  };
})();

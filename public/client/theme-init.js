/* S11: aplica el tema guardado antes de pintar (evita el parpadeo claro→oscuro). Vivía como script en
   línea en super.html; se movió aquí para que la CSP no necesite un hash 'sha256-…' que cambiaría con
   cada edición de esta línea. */
try { const t = localStorage.getItem('iae_theme'); if (t) document.documentElement.dataset.theme = t; } catch (e) { /* sin almacenamiento */ }

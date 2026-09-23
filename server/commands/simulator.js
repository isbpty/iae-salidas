import { register } from './index.js';
import { HttpError, badRequest } from '../domain/errors.js';
import { USER_ROLES } from '../domain/constants.js';

/* L18: la "instancia única" del simulador (public/client/simulator.js) era por pestaña -- dos probadores
   que lo arrancan a la vez ejecutan `reset_demo` sobre la misma base compartida y se borran los datos
   mutuamente (y los de quien esté probando a mano). Un candado en `app_meta` (id='sim_lock', value =
   segundos unix de vencimiento) lo evita entre pestañas y dispositivos: `acquire` falla con 409 y
   `{ until }` mientras el candado no venció; `release` lo limpia al terminar (o al cancelar). Mismo
   patrón de upsert condicional que `claimAutoPurge` en server/app.js, con consultas directas contra
   `app_meta` -- no hace falta tocar repo.js. Cualquier probador (de cualquier rol, incluidos los padres)
   puede correr el simulador, así que el comando no restringe roles más allá de tener sesión. */
const LOCK_ID = 'sim_lock';
const TTL_S = 900;

register({
  sim_lock: {
    roles: USER_ROLES,
    bump: false,
    handler: async (ctx, input) => {
      const nowS = Math.floor(ctx.now.getTime() / 1000);
      if (input.action === 'acquire') {
        const until = nowS + TTL_S;
        const r = await ctx.q.query(
          `INSERT INTO app_meta(id, value) VALUES ($1, $2)
             ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value WHERE app_meta.value <= $3
           RETURNING value`,
          [LOCK_ID, until, nowS],
        );
        if (!r.length) {
          const cur = await ctx.q.query('SELECT value FROM app_meta WHERE id=$1', [LOCK_ID]);
          throw new HttpError(409, 'simulator_busy', 'Otro probador está corriendo el simulador ahora mismo. Espera un momento e inténtalo de nuevo.', { until: cur[0] ? cur[0].value : nowS });
        }
        return { until };
      }
      if (input.action === 'release') {
        await ctx.q.query('DELETE FROM app_meta WHERE id=$1', [LOCK_ID]);
        return { released: true };
      }
      badRequest('invalid_action');
    },
  },
});

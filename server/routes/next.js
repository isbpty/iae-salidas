/* Lo que devuelve una ruta de server/routes/*.js cuando la petición no es suya: el router de
   `createApp` (server/app.js) prueba la siguiente. Cualquier otro valor (incluido `undefined`, que es lo
   que deja el canal SSE) significa "ya respondí". */
export const NEXT = Symbol('next_route');

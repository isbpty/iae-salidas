/* `code` is the machine-readable snake_case error; `detail` is an optional Spanish sentence for the UI. */
export class HttpError extends Error {
  constructor(status, code, detail = null) { super(code); this.status = status; this.code = code; this.detail = detail; }
}
export const badRequest = (code) => { throw new HttpError(400, code); };
export const unauthorized = (code = 'authentication_required') => { throw new HttpError(401, code); };
export const deny = (code) => { throw new HttpError(403, code); };
export const notFound = (code) => { throw new HttpError(404, code); };
export const conflict = (code) => { throw new HttpError(409, code); };

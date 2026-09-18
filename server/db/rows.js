const toCamel = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
export function camel(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[toCamel(k)] = v instanceof Date ? v.getTime() : v;
  return out;
}
export const snake = (k) => k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

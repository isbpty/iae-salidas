import { randomUUID } from 'node:crypto';
export const uid = (prefix = '') => prefix + randomUUID().replace(/-/g, '').slice(0, 10);

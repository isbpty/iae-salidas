import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class Store {
  constructor(file) { this.file = file; this.state = null; this.queue = Promise.resolve(); }
  async load(seed) {
    try { this.state = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = structuredClone(seed);
      await this.persist();
    }
    return this.state;
  }
  async persist() {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2));
    await rename(tmp, this.file);
  }
  mutate(fn) {
    const run = this.queue.then(async () => {
      const result = await fn(this.state);
      await this.persist();
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/* C5: el cliente son scripts clásicos que comparten el ámbito global, repartidos en varios archivos
   (views-core, views-parent, views-school, views-gate, views-bus, modals, actions). No hay bundler que
   avise si falta una etiqueta <script> o si un archivo no compila, así que esta prueba de humo: cada
   script local de index.html/super.html existe y pasa `node --check`; todo .js de public/client lo
   carga alguna página; y los scripts de index.html, cargados en orden en un contexto con un DOM
   mínimo, se evalúan sin errores y dejan definidas las funciones que usan los demás. */
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const scriptsOf = (page) => [...fs.readFileSync(path.join(PUBLIC, page), 'utf8').matchAll(/<script src="(client\/[^"]+)"/g)].map((m) => m[1]);

test('index.html y super.html cargan todos los scripts del cliente y cada uno compila', () => {
  const index = scriptsOf('index.html');
  const referenced = new Set([...index, ...scriptsOf('super.html')]);
  for (const src of referenced) {
    const file = path.join(PUBLIC, src);
    assert.ok(fs.existsSync(file), src + ' está en el HTML pero no existe');
    execFileSync(process.execPath, ['--check', file]);
  }
  const onDisk = fs.readdirSync(path.join(PUBLIC, 'client')).filter((f) => f.endsWith('.js')).map((f) => 'client/' + f);
  assert.deepEqual(onDisk.filter((f) => !referenced.has(f)), [], 'scripts del cliente que ninguna página carga');
  assert.equal(index[index.length - 1], 'client/actions.js', 'actions.js va al final: usa lo que definen los demás');
  assert.ok(index.indexOf('client/views-core.js') > index.indexOf('client/simulator.js'));
});

test('los scripts de index.html se evalúan en orden sin errores y definen el render y los eventos', () => {
  const listeners = {};
  const stub = () => new Proxy({}, { get: (t, k) => (k === 'addEventListener' ? () => {} : k === 'classList' ? { toggle() {}, add() {}, remove() {} } : k === 'dataset' || k === 'style' ? {} : undefined), set: () => true });
  const ctx = {
    console, setInterval: () => 0, setTimeout: () => 0, clearTimeout() {}, clearInterval() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { search: '', pathname: '/', href: 'http://localhost/' }, navigator: {}, fetch: async () => ({}), EventSource: function () {},
    matchMedia: () => ({ matches: false }), addEventListener() {},
    document: { addEventListener: (ev, fn) => { (listeners[ev] ||= []).push(fn); }, getElementById: stub, querySelector: stub, querySelectorAll: () => [], body: stub(), documentElement: { dataset: {} }, hidden: false, createElement: stub },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const src of scriptsOf('index.html')) vm.runInContext(fs.readFileSync(path.join(PUBLIC, src), 'utf8'), ctx, { filename: src });
  for (const name of ['render', 'renderModal', 'viewParents', 'viewWhatsapp', 'viewSchool', 'viewTv', 'viewLog', 'schoolGate', 'schoolRutas', 'routeMap', 'animateBuses', 'modalSalida', 'modalScan', 'onClick', 'onSubmit', 'onChange', 'run', 'formData', 'ACTIONS', 'FORMS', 'SCHOOL_TABS']) {
    assert.notEqual(vm.runInContext('typeof ' + name, ctx), 'undefined', name + ' no quedó definido');
  }
  assert.equal((listeners.DOMContentLoaded || []).length, 2, 'el arranque (views-core.js) y el simulador enlazan sus escuchas');
});

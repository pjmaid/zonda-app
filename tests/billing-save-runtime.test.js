const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = html.slice(html.indexOf('async function factGuardarGasto('), html.indexOf('async function factEliminarGasto('));

function form({file, upsert, storagePut = async () => {}}) {
  const elements = {
    factStudy: {value: 'study-test'}, btnFactGastoRemis: {disabled: false},
    factGastoRemisFecha: {value: '2026-09-10'}, factGastoRemisReferencia: {value: ''},
    factGastoRemisDetalle: {value: 'Traslado ficticio'}, factGastoRemisMonto: {value: '1200'},
    factGastoRemisMoneda: {value: 'ARS'}, factGastoRemisFile: {files: file ? [file] : []}
  };
  const alerts = [], toasts = [];
  const ctx = vm.createContext({
    FACT_GASTOS: {gasto_remis: {key: 'Remis', titulo: 'Gasto de remís'}},
    $: id => elements[id], canFact: () => true, uid: () => 'test-id', T: s => s,
    Store: {upsert, online: () => true}, storagePut, renderFactGasto: () => {},
    alert: text => alerts.push(text), toast: text => toasts.push(text)
  });
  vm.runInContext(source, ctx);
  return {save: () => ctx.factGuardarGasto('gasto_remis'), alerts, toasts, elements};
}

test('el fallo del comprobante se informa sin reemplazarlo por un éxito completo', async () => {
  let writes = 0;
  const app = form({
    file: {name: 'comprobante-ficticio.pdf', size: 20, type: 'application/pdf'},
    upsert: async () => { writes++; },
    storagePut: async () => { throw new Error('Carga interrumpida'); }
  });
  await app.save();
  assert.equal(writes, 1, 'El gasto se crea una sola vez.');
  assert.equal(app.alerts.length, 1);
  assert.match(app.alerts[0], /gasto quedó guardado.*no se pudo adjuntar/);
  assert.match(app.alerts[0], /No vuelvas a agregar/);
  assert.equal(app.toasts.length, 0);
  assert.equal(app.elements.btnFactGastoRemis.disabled, false);
});

test('dos envíos simultáneos del formulario generan un solo gasto', async () => {
  let finish, writes = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  const app = form({upsert: async () => { writes++; await pending; }});
  const first = app.save();
  await app.save();
  finish();
  await first;
  assert.equal(writes, 1);
  assert.deepEqual(app.toasts, ['Gasto registrado.']);
});

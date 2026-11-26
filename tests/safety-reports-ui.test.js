const test = require('node:test');
const assert = require('node:assert/strict');
const {mount, selectPage} = require('../safety-reports.js');

test('se pueden recorrer cientos de informes sin omitir ni repetir archivos', () => {
  const reports = Array.from({length: 257}, (_, number) => ({
    id: String(number), filename: `SUSAR-${number}.pdf`,
    subido: new Date(Date.UTC(2026, 0, 1, 0, number)).toISOString(),
  }));
  const expected = reports.slice().reverse().map(doc => doc.id);
  const seen = [];
  for (let page = 1; page <= 11; page++) {
    const result = selectPage(reports, {page});
    assert.equal(result.pages, 11);
    assert.equal(result.total, 257);
    assert.equal(result.page, page);
    assert.equal(result.items.length, page === 11 ? 7 : 25);
    seen.push(...result.items.map(doc => doc.id));
  }
  assert.deepEqual(seen, expected);
  assert.equal(selectPage(reports, {page: 200}).page, 11);
  assert.deepEqual(reports.map(doc => doc.id), expected.reverse(), 'Mostrar una lista no reordena la colección compartida.');
});

test('búsqueda, categoría y fechas combinan metadatos del patrocinador y archivos históricos', () => {
  const reports = [
    { id: 'ref', filename: 'adjunto.pdf', safetyReference: 'Señal-17', safetyCategory: 'SUSAR', safetyDate: '2026-07-01', subido: '2026-10-01T00:00:00Z' },
    { id: 'name', filename: 'Informe Señal-17.pdf', safetyCategory: 'SUSAR', safetyDate: '2026-07-31', subido: '2026-10-04T00:00:00Z' },
    { id: 'legacy', filename: 'uno.pdf', version: 'Señal-17', safetyCategory: 'SUSAR', subido: '2026-07-31T09:00:00Z' },
    { id: 'wrong-type', filename: 'Señal-17.pdf', safetyCategory: 'CIOMS', safetyDate: '2026-07-15' },
    { id: 'wrong-date', filename: 'Señal-17.pdf', safetyCategory: 'SUSAR', safetyDate: '2026-08-01' },
    { id: 'wrong-title', filename: 'otro.pdf', safetyCategory: 'SUSAR', safetyDate: '2026-07-15' },
  ];
  const result = selectPage(reports, {
    search: 'SENAL-17', category: 'SUSAR', from: '2026-07-01', to: '2026-07-31', page: 8,
  });
  assert.equal(result.total, 3);
  assert.equal(result.page, 1);
  assert.deepEqual(result.items.map(doc => doc.id), ['name', 'legacy', 'ref']);
  assert.deepEqual(selectPage(reports, {category:'CIOMS'}).items.map(doc=>doc.id), ['wrong-type']);
  const empty = selectPage(reports, {search: 'inexistente', page: 100});
  assert.equal(empty.page, 1);
  assert.equal(empty.pages, 1);
  assert.deepEqual(empty.items, []);
});

// Only the DOM operations used by the view are needed to exercise its public events.
function fixture(upload, isActive = () => true, options = {}) {
  const document = {defaultView: {confirm: () => true}};
  function element(tagName) {
    const listeners = new Map();
    const el = {
      ownerDocument: document, tagName: tagName.toUpperCase(), children: [], dataset: {},
      value: '', files: [], style: {}, disabled: false, textContent: '',
      append(...children) { this.children.push(...children); },
      focus() { document.activeElement = this; },
      replaceChildren(...children) { this.children = children; },
      get options() { return this.children.filter(child => child.tagName === 'OPTION'); },
      get selectedOptions() { return this.options.filter(option => option.selected); },
      setAttribute(key, value) {
        if (key.startsWith('data-')) this.dataset[key.slice(5)] = String(value);
        else this[key] = String(value);
      },
      addEventListener(type, handler) { (listeners.get(type) || listeners.set(type, []).get(type)).push(handler); },
      fire(type) { return Promise.all((listeners.get(type) || []).map(handler => handler.call(this, {target: this, currentTarget: this, preventDefault() {}}))); },
    };
    return el;
  }
  document.createElement = element;
  const host = element('div');
  const controller = mount(host, {
    studyId: 'p1', isActive, canManage: () => true, getReports: () => [], getOtherDocs: () => [],
    upload, reclassify: async () => {}, open: async () => {}, download: async () => {}, ...options,
  });
  function optionalControl(name) {
    function find(el) {
      if (!el || typeof el !== 'object') return undefined;
      return el.dataset.safety === name ? el : el.children.map(find).find(Boolean);
    }
    return find(host);
  }
  function control(name) {
    const el = optionalControl(name);
    assert.ok(el, `Control ${name}`);
    return el;
  }
  async function select(...names) {
    const input = control('files');
    input.files = names.map(name => ({name, type: 'application/pdf', size: 160, lastModified: 1}));
    await input.fire('change');
  }
  return {controller, control, optionalControl, select};
}

async function idle(controller) {
  for (let i = 0; i < 30 && controller.isBusy(); i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.isBusy(), false, 'La operación debe haber terminado.');
}

test('el botón de reintento conserva la operación fallida y no vuelve a enviar los éxitos', async () => {
  const calls = [];
  let failed = false;
  const ui = fixture(async (file, _meta, key) => {
    calls.push({name: file.name, key});
    if (file.name === 'B.pdf' && !failed) { failed = true; throw new Error('Error sintético de red'); }
  });
  await ui.select('A.pdf', 'B.pdf', 'C.pdf');
  await ui.select('B.pdf');
  assert.equal(calls.length, 0);
  await ui.control('upload').fire('click');
  await idle(ui.controller);
  assert.deepEqual(calls.map(call => call.name), ['A.pdf', 'B.pdf', 'C.pdf']);
  await ui.control('retry').fire('click');
  await idle(ui.controller);
  assert.deepEqual(calls.map(call => call.name), ['A.pdf', 'B.pdf', 'C.pdf', 'B.pdf']);
  assert.ok(calls[1].key);
  assert.equal(calls[3].key, calls[1].key);
});

test('cambiar de contexto detiene los archivos del lote que aún no se enviaron', async () => {
  let active = true;
  const calls = [];
  const ui = fixture(async file => { calls.push(file.name); active = false; }, () => active);
  await ui.select('A.pdf', 'B.pdf');
  await ui.control('upload').fire('click');
  await idle(ui.controller);
  assert.deepEqual(calls, ['A.pdf']);
});

test('detener un lote termina el informe en curso y permite continuar sólo los pendientes', async () => {
  let finish, started;
  const firstStarted = new Promise(resolve => { started = resolve; });
  const firstCompleted = new Promise(resolve => { finish = resolve; });
  const calls = [];
  const ui = fixture(async file => {
    calls.push(file.name);
    if (file.name === 'A.pdf') { started(); await firstCompleted; }
  });
  await ui.select('A.pdf', 'B.pdf', 'C.pdf');
  const first = ui.control('upload').fire('click');
  await firstStarted;
  await ui.control('stop').fire('click');
  assert.equal(ui.controller.isBusy(), true, 'El primer informe todavía está en curso.');
  finish(); await first; await idle(ui.controller);
  assert.deepEqual(calls, ['A.pdf']);
  await ui.control('upload').fire('click');
  await idle(ui.controller);
  assert.deepEqual(calls, ['A.pdf', 'B.pdf', 'C.pdf']);
});


test('el traslado desde Otro conserva la selección entre páginas y reintenta sólo lo que falló', async () => {
  const docs = Array.from({length: 136}, (_, i) => ({
    id: String(i + 1).padStart(3, '0'), filename: `Informe ${String(i + 1).padStart(3, '0')}.pdf`, tipo: 'otro',
  }));
  const moved = new Set(), calls = [];
  let failId;
  const ui = fixture(async () => {}, () => true, {
    getOtherDocs: () => docs.filter(doc => !moved.has(doc.id)),
    reclassify: async id => {
      calls.push(id);
      if (id === failId && calls.filter(value => value === id).length === 1) throw new Error('Falló el traslado');
      moved.add(id);
    },
  });
  const idsOnPage = () => ui.control('legacySelect').options.map(option => option.value);
  const firstPage = idsOnPage();
  assert.equal(firstPage.length, 25);
  await ui.control('legacyAll').fire('click');
  await ui.control('legacyNext').fire('click');
  const secondPage = idsOnPage();
  assert.equal(secondPage.length, 25);
  await ui.control('legacyAll').fire('click');
  await ui.control('legacyPrev').fire('click');
  assert.deepEqual(idsOnPage(), firstPage);
  const selected = new Set([...firstPage, ...secondPage]);
  assert.equal(selected.size, 50);
  failId = secondPage[0];
  assert.equal(calls.length, 0, 'Seleccionar documentos no los mueve.');
  await ui.control('legacyMove').fire('click');
  await idle(ui.controller);
  assert.equal(calls.length, 50);
  assert.deepEqual(new Set(calls), selected);
  assert.equal(moved.size, 49);
  await ui.control('legacyMove').fire('click');
  await idle(ui.controller);
  assert.deepEqual(calls.slice(50), [failId]);
  assert.deepEqual(moved, selected);
  assert.equal(ui.control('legacyMove').disabled, true);
});


test('editar un reporte corrige su descripción sin crear otra copia y se limita a usuarios con permiso', async () => {
  let writable = true, uploads = 0;
  const report = {id: 'report1', tipo: 'reporte_seguridad', filename: 'Adjunto.pdf', safetyReference: 'Provisional'};
  const changes = [];
  const ui = fixture(async () => { uploads++; }, () => true, {
    canManage: () => writable,
    getReports: () => [report],
    updateMetadata: async (id, meta) => {
      changes.push({id, meta});
      Object.assign(report, {safetyDate: meta.reportDate, safetyReference: meta.reference, safetyCategory: meta.category});
    },
  });
  await ui.control('edit-report1').fire('click');
  assert.equal(ui.control('editReference').value, 'Provisional');
  ui.control('editReference').value = 'Seguimiento 2';
  ui.control('editDate').value = '2026-09-30';
  ui.control('editCategory').value = 'SUSAR';
  await ui.control('editSave').fire('click');
  await idle(ui.controller);
  assert.deepEqual(changes, [{id: 'report1', meta: {reportDate: '2026-09-30', reference: 'Seguimiento 2', category: 'SUSAR'}}]);
  assert.equal(uploads, 0);
  writable = false;
  ui.controller.refresh();
  assert.equal(ui.optionalControl('edit-report1'), undefined);
});

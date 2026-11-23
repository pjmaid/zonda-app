const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
function section(start, end) {
  const a = html.indexOf(start), b = html.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `Sección disponible: ${start}`);
  return html.slice(a, b);
}
function harness(extra = {}) {
  const elements = {}, handlers = {}, toasts = [];
  const $ = id => elements[id] || (elements[id] = {
    value: '', disabled: false, innerHTML: '', textContent: '', style: {},
    classList: {add() {}, remove() {}, contains() { return false; }},
    addEventListener: (event, fn) => { handlers[id + ':' + event] = fn; }
  });
  let seq = 0;
  const ctx = vm.createContext({$, T: s => s, uid: () => `new-${++seq}`,
    toast: text => toasts.push(text), showView() {}, confirm: () => true,
    ...extra});
  return {ctx, $, elements, handlers, toasts,
    run: source => vm.runInContext(source, ctx),
    click: id => handlers[id + ':click']()};
}
const patientHandler = section("$('btnSavePatient').addEventListener", "$('btnCancelPatient').addEventListener");
function patientForm({patient, medication = [], persist, guardarLog, sync} = {}) {
  const DB = {patients: patient ? [patient] : [], records: []};
  const writes = [];
  const app = harness({DB, LOGS: {conmed: []}, PA_CRIT: {i0: 'si'}, PA_JUST: {i0: 'documentado'},
    PA_CONMED: medication, PA_CONMED_BAJAS: [], NARR: null, NARR_PATIENT_ID: '', NARR_STUDY_ID: '',
    getPatient: id => DB.patients.find(p => p.id === id),
    getStudy: () => ({id: 'study'}), critFirma: () => 'firma',
    todayISO: () => '2026-11-23', coincidenciasMedProhibida: () => [],
    sincronizarEvolucionesClinicas: sync || (async () => {}),
    guardarLog: guardarLog || (async () => true),
    persist: persist || (async (kind, obj) => {
      writes.push(JSON.parse(JSON.stringify(obj)));
      DB.patients = DB.patients.filter(p => p.id !== obj.id).concat([obj]);
      return true;
    })});
  Object.entries({paId: patient?.id || '', paCodigo: 'FICTICIO', paIniciales: 'XX',
    paEstudio: 'study', paEstado: 'screening'}).forEach(([k, v]) => app.$(k).value = v);
  app.run(patientHandler);
  return {...app, writes, DB};
}

test('guardar la ficha conserva historial y fundamentación confirmados', async () => {
  const patient = {id: 'p1', critHistorial: [{fecha: 'anterior'}], critNarrativa: {items: [{texto: 'Borrador revisado'}]}};
  const app = patientForm({patient});
  await app.click('btnSavePatient');
  assert.deepEqual(app.writes[0].critHistorial, patient.critHistorial);
  assert.deepEqual(app.writes[0].critNarrativa, patient.critNarrativa);
});

test('la medicación pendiente puede reintentarse sin crear otra ficha ni otro medicamento', async () => {
  const med = {farmaco: 'Medicamento ficticio'}, medIds = [];
  const app = patientForm({medication: [med], guardarLog: async (_, r) => {
    medIds.push(r.id); return medIds.length > 1;
  }});
  await app.click('btnSavePatient');
  const patientId = app.$('paId').value;
  assert.ok(patientId);
  assert.match(app.toasts.at(-1), /paciente quedó guardado.*falta actualizar/);
  await app.click('btnSavePatient');
  assert.equal(app.DB.patients.length, 1);
  assert.equal(app.writes[1].id, patientId);
  assert.equal(medIds[0], medIds[1]);
});

test('dos envíos simultáneos guardan una sola ficha y se libera el botón', async () => {
  let finish, calls = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  const app = patientForm({persist: async () => { calls++; await pending; return true; }});
  const first = app.click('btnSavePatient');
  await app.click('btnSavePatient');
  finish(); await first;
  assert.equal(calls, 1);
  assert.equal(app.$('btnSavePatient').disabled, false);
});

test('un reintento de medicación omite los registros ya confirmados', async () => {
  const writes = [];
  let fail = true, app;
  app = patientForm({medication: [{id: 'm1', farmaco: 'Ficticio A'}, {id: 'm2', farmaco: 'Ficticio B'}],
    guardarLog: async (_, value) => {
      writes.push(value.id);
      if(value.id === 'm2' && fail) return false;
      app.ctx.LOGS.conmed = app.ctx.LOGS.conmed.filter(m => m.id !== value.id).concat([value]);
      app.DB.records = app.DB.records.filter(m => m.id !== value.id).concat([value]);
      return true;
    }});
  await app.click('btnSavePatient');
  fail = false;
  await app.click('btnSavePatient');
  assert.deepEqual(writes, ['m1', 'm2', 'm2']);
});

test('cambiar de ficha durante el guardado no mezcla medicación ni reemplaza el ID visible', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; }), meds = [];
  const app = patientForm({patient: {id: 'p1'}, medication: [{farmaco: 'Ficticio A'}],
    persist: async () => { await pending; return true; },
    guardarLog: async (_, value) => { meds.push(value); return true; }});
  const running = app.click('btnSavePatient');
  app.ctx.PA_CONMED = [{farmaco: 'Ficticio B'}];
  app.$('paId').value = 'p2';
  finish(); await running;
  assert.equal(app.$('paId').value, 'p2');
  assert.equal(meds[0].pacienteId, 'p1');
  assert.equal(meds[0].farmaco, 'Ficticio A');
});

test('el aviso de evolución pendiente sobrevive al guardado parcial de paciente', async () => {
  const app = patientForm({sync: async () => { throw new Error('Sin conexión'); }});
  await app.click('btnSavePatient');
  assert.equal(app.toasts.length, 1);
  assert.match(app.toasts[0], /evoluciones pendientes.*Sin conexión/);
});

const evolutionSource = section('function openEvolution(logId)', "$('btnCopyEvo').addEventListener");
function evolutionForm(persist = async () => false) {
  const log = {id: 'v1', pacienteId: 'p1', estudioId: 'study', evolucionTexto: 'Texto confirmado', editadoManual: true};
  const app = harness({getVisitLog: () => log, getPatient: () => ({}), getStudy: () => ({}),
    patientLabel: () => 'Ficticio', studyLabel: () => 'Ensayo ficticio', fmtDate: () => '',
    evoChecks: () => [], esc: s => s,
    refrescarSeccionesClinicas: () => 'Vista actualizada', buildEvolution: () => 'Texto generado', persist});
  app.run(evolutionSource);
  app.ctx.openEvolution(log.id);
  return {...app, log};
}

test('abrir una evolución actualiza la vista sin mutar ni guardar el registro', () => {
  let writes = 0;
  const app = evolutionForm(async () => { writes++; return true; });
  assert.equal(app.log.evolucionTexto, 'Texto confirmado');
  assert.equal(app.$('evoText').value, 'Vista actualizada');
  assert.equal(writes, 0);
  assert.match(app.$('evoStale').innerHTML, /guardalo/);
});

test('una regeneración fallida conserva el texto confirmado y el borrador visible', async () => {
  const app = evolutionForm();
  app.$('evoText').value = 'Borrador manual';
  await app.click('btnRegenEvo');
  assert.equal(app.log.evolucionTexto, 'Texto confirmado');
  assert.equal(app.log.editadoManual, true);
  assert.equal(app.$('evoText').value, 'Borrador manual');
  await app.click('btnSaveEvo');
  assert.match(app.$('evoStale').innerHTML, /no se pudo guardar/);
});

test('guardar una evolución espera confirmación y usa una copia', async () => {
  let finish, candidate;
  const pending = new Promise(resolve => { finish = resolve; });
  const app = evolutionForm(async (_, value) => { candidate = value; await pending; return true; });
  app.$('evoText').value = 'Revisado';
  const saving = app.click('btnSaveEvo');
  assert.equal(app.$('btnSaveEvo').disabled, true);
  assert.equal(app.log.evolucionTexto, 'Texto confirmado');
  assert.notEqual(candidate, app.log);
  finish(); await saving;
  assert.equal(app.$('btnSaveEvo').disabled, false);
  assert.equal(app.$('evoStale').innerHTML, '');
});

const remapSource = section('async function critRemapearPacientes(prev, nuevo)', 'function critAvisoRemapeo(');
test('remapeo parcial se reanuda sin desplazar otra vez respuestas confirmadas', async () => {
  const original = {id: 'p1', codigo: 'FICTICIO-1', estudioId: 's', critFirma: 'anterior',
    criterios: {i0: 'si', i1: 'no'}, critJust: {i0: 'dato A'}, critNarrativa: {items: [], obsoleta: false}};
  const DB = {patients: [original, {...original, id: 'p2', codigo: 'FICTICIO-2'}]};
  const writes = [];
  let fail = true;
  const app = harness({DB, CURRENT_USER: 'test', critFirma: x => x.firma,
    critMapear: () => ({mapa: {i0: 'i1', i1: 'i0'}, exactas: 2, aproximadas: 0, perdidos: []}),
    auditar() {}, Store: {upsert: async (_, value) => {
      writes.push(value.id);
      if(value.id === 'p2' && fail) throw new Error('interrumpido');
      DB.patients = DB.patients.map(p => p.id === value.id ? value : p);
    }}});
  app.run(remapSource);
  const before = {id: 's', firma: 'anterior', criteriosInclusion: ['A', 'B']};
  const after = {id: 's', firma: 'nueva', criteriosInclusion: ['B', 'A']};
  await assert.rejects(app.ctx.critRemapearPacientes(before, after), /1 paciente\(s\) pendientes/);
  assert.equal(original.critFirma, 'anterior');
  assert.equal(original.critNarrativa.obsoleta, false);
  assert.equal(DB.patients[0].criterios.i1, 'si');
  fail = false;
  await app.ctx.critRemapearPacientes(before, after);
  assert.deepEqual(writes, ['p1', 'p2', 'p2']);
  assert.equal(DB.patients[0].critHistorial.length, 1);
  assert.equal(DB.patients[1].criterios.i1, 'si');
  assert.equal(DB.patients[1].critJust.i1, 'dato A');
});

test('guardar registro conserva el aviso de sincronización y el tipo de registro original', async () => {
  const source = section("  $('lf_save').addEventListener('click', async ()=>{", '  box.scrollIntoView({');
  let calls = 0;
  const app = harness({tipo: 'conmed', draftId: 'med1', id: null, r: {}, LOG_EDIT: null, LOG_TIPO: 'conmed',
    def: {paciente: true, campos: [{k: 'farmaco', t: 'text', req: true, n: 'Medicamento'}]},
    LOG_CLINICOS: ['conmed'], fechaISO: s => s, coincidenciasMedProhibida: () => [],
    qualityForLog: () => [], qualityGate: () => true, qualityStamp: () => ({}),
    guardarLog: async tipo => { assert.equal(tipo, 'conmed'); calls++; return true; },
    sincronizarEvolucionesClinicas: async () => { throw new Error('Sin conexión'); },
    box: {classList: {add() {}}}, renderLog() {}, renderTools() {}, finishLinkedVisitLog() {}});
  app.$('lf_estudio').value = 's'; app.$('lf_paciente').value = 'p'; app.$('lf_farmaco').value = 'Ficticio';
  app.run(source);
  await app.click('lf_save');
  assert.equal(calls, 1);
  assert.equal(app.toasts.length, 1);
  assert.match(app.toasts[0], /Registro guardado, pero no se pudieron actualizar/);
  assert.equal(app.$('lf_save').disabled, false);
});

test('el plan de remapeo persiste antes de actualizar pacientes y se limpia sólo al terminar', async () => {
  const source = section("$('btnSaveStudy').addEventListener", "$('btnCancelStudy').addEventListener");
  const DB = {studies: [{id: 's', criteriosInclusion: ['Original'], criteriosExclusion: []}], patients: [{estudioId: 's'}]};
  const origins = [];
  let attempt = 0;
  const app = harness({DB, can: () => true, collectStVisitas: () => [], collectStMedsProhib: () => [],
    EDIT_IMPORTACIONES_PROTOCOLO: [], getStudy: id => DB.studies.find(s => s.id === id),
    critFirma: s => JSON.stringify([s.criteriosInclusion || [], s.criteriosExclusion || []]),
    persist: async (_, s) => { DB.studies = [s]; return true; },
    Store: {upsert: async (_, s) => { DB.studies = [s]; }},
    critRemapearPacientes: async (before, after) => {
      assert.ok(DB.studies[0].critRemapeoPendiente, 'El origen ya quedó guardado antes de remapear.');
      origins.push(before.criteriosInclusion[0]);
      if(++attempt === 1) throw new Error('Interrumpido');
      return {tocados: 1};
    }, renderAll() {}, critAvisoRemapeo() {}, auditar() {}});
  Object.entries({stId: 's', stCodigo: 'FICTICIO', stNombre: 'Estudio ficticio', stIncl: 'Nuevo'}).forEach(([k, v]) => app.$(k).value = v);
  app.run(source);
  await app.click('btnSaveStudy');
  assert.equal(DB.studies[0].critRemapeoPendiente.desde.criteriosInclusion[0], 'Original');
  assert.match(app.toasts.at(-1), /sigue pendiente/);
  await app.click('btnSaveStudy');
  assert.deepEqual(origins, ['Original', 'Original']);
  assert.equal(DB.studies[0].critRemapeoPendiente, undefined);
});

test('una fundamentación tardía no se asigna al paciente abierto después', async () => {
  const source = section("$('btnNarrRun').addEventListener", "$('btnNarrPrint').addEventListener");
  let finish, started, writes = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const study = {id: 's', criteriosInclusion: ['Criterio ficticio']};
  const app = harness({NARR: null, NARR_PATIENT_ID: '', NARR_STUDY_ID: '', PA_CRIT: {i0: 'si'},
    getStudy: () => study, getPatient: id => ({id, criterios: {i0: 'si'}}),
    docsOfPatient: () => [{id: 'doc', filename: 'ficticio.txt'}], docBlob: async () => ({}),
    document: {querySelectorAll: () => [{dataset: {ndoc: 'doc'}}]},
    extractTextTablas: async () => 'Texto clínico sintético suficientemente largo para esta prueba.',
    patientEvidenceSafeText: s => s,
    aiNarrarCriterios: async () => { started(); return pending; },
    critFirma: () => 'firma', aiModelName: () => 'test', renderNarr() {},
    aiConfigured: () => true, ragEstricto: () => false, auditar() {},
    Store: {upsert: async () => { writes++; }}});
  app.$('paId').value = 'p1'; app.$('paEstudio').value = 's';
  app.run(source);
  const running = app.click('btnNarrRun');
  await ready;
  app.$('paId').value = 'p2';
  finish({items: [{texto: 'Texto del primer paciente'}], lotes: 1});
  await running;
  assert.equal(writes, 0);
  assert.equal(app.ctx.NARR, null);
  assert.match(app.$('narrStatus').textContent, /Cambió el paciente o el protocolo/);
});

test('las ediciones de fundamentación se guardan como copia junto a la ficha', async () => {
  const app = patientForm({patient: {id: 'p1'}});
  const draft = {items: [{texto: 'Revisado por el investigador'}]};
  app.ctx.NARR = draft; app.ctx.NARR_PATIENT_ID = 'p1'; app.ctx.NARR_STUDY_ID = 'study';
  await app.click('btnSavePatient');
  draft.items[0].texto = 'Edición posterior';
  assert.equal(app.DB.patients[0].critNarrativa.items[0].texto, 'Revisado por el investigador');
});

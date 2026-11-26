const test = require('node:test');
const assert = require('node:assert/strict');
const safety = require('../safety-report-store.js');
const rag = require('../clinical-rag-policy.js');

const file = (name = 'Informe 1.pdf', size = 120) => ({name, size, type: 'application/pdf'});
const metadata = {category: 'SUSAR', reportDate: '2024-02-29', reference: '  CASO 27  '};

function fixture(initial = [], settings = {}) {
  const records = new Map(initial.map(d => [d.id, d]));
  const counts = {id: 0, save: 0, storage: 0, idb: 0, refresh: 0};
  const deps = {
    studyId: 'S1', docs: () => [...records.values()], assertContext() {},
    online: () => true, uid: () => 'doc-' + ++counts.id,
    async storagePut() { counts.storage++; }, async idbPut() { counts.idb++; },
    async saveDoc(doc) { counts.save++; records.set(doc.id, doc); },
    async refreshDoc() { counts.refresh++; }, ...settings
  };
  return {driver: safety.create(deps), records, counts};
}

test('sube un reporte al estudio con su fecha y referencia sin incorporarlo al corpus clínico', async () => {
  const {driver, counts} = fixture();
  const report = await driver.upload(file(), metadata, {});
  assert.equal(report.estudioId, 'S1');
  assert.equal(report.path, 'S1/doc-1/Informe_1.pdf');
  assert.equal(report.tipo, 'reporte_seguridad');
  assert.equal(report.safetyReference, 'CASO 27');
  assert.equal(report.safetyCategory, 'SUSAR');
  assert.equal(report.safetyDate, '2024-02-29');
  assert.equal(safety.isReport(report), true);
  assert.equal(rag.isClinicalDocument(report), false);
  assert.equal('pacienteId' in report, false);
  assert.equal(counts.save, 1);
  assert.equal(counts.storage, 1);
  assert.equal(counts.idb, 0);
});

test('rechaza fecha y tamaño inválidos sin escrituras y admite exactamente 50 MB en el archivo local', async () => {
  const {driver, counts} = fixture([], {online: () => false});
  await assert.rejects(driver.upload(file('big', safety.MAX_BYTES + 1), {}), /50 MB/);
  await assert.rejects(driver.upload(file(), {reportDate:'2025-02-29'}), /fecha/);
  assert.equal(counts.save, 0);
  const report = await driver.upload(file('informe.pdf', safety.MAX_BYTES), {});
  assert.equal(counts.idb, 1);
  assert.equal(counts.storage, 0);
  assert.equal(report.storage, 'idb');
  assert.equal(report.path, '');
});

test('reintentar tras una respuesta perdida consulta el mismo identificador y evita duplicar ficha y archivo', async () => {
  const server = new Map(), cache = new Map();
  let writes = 0, reads = 0, puts = 0;
  const {driver, counts} = fixture([], {
    docs: () => [...cache.values()],
    async storagePut() { puts++; },
    async saveDoc(doc) { writes++; server.set(doc.id, doc); throw new Error('sin respuesta'); },
    async refreshDoc(id) { reads++; if (server.has(id)) cache.set(id, server.get(id)); }
  });
  const report = file(), key = {};
  await assert.rejects(driver.upload(report, metadata, key), /sin respuesta/);
  const recovered = await driver.upload(report, metadata, key);
  assert.equal(recovered.id, 'doc-1');
  assert.equal(reads, 1);
  assert.equal(writes, 1);
  assert.equal(puts, 1);
  assert.equal(counts.id, 1);
});

test('un reintento de guardado incompleto conserva bytes y ruta y no acepta otro archivo para el mismo intento', async () => {
  const ids = [];
  const {driver, counts} = fixture([], {async saveDoc(doc) {
    ids.push(doc.id);
    if (ids.length === 1) throw new Error('falla antes de guardar');
  }});
  const report = file(), key = {};
  await assert.rejects(driver.upload(report, metadata, key), /antes de guardar/);
  await assert.rejects(driver.upload(file('distinto.pdf'), metadata, key), /otro archivo/);
  await driver.upload(report, metadata, key);
  assert.deepEqual(ids, ['doc-1', 'doc-1']);
  assert.equal(counts.storage, 1);
});

test('dos submits concurrentes comparten una carga y un cambio de contexto impide guardar la ficha', async () => {
  let release, active = true, writes = 0;
  const delayed = new Promise(resolve => { release = resolve; });
  const {driver, counts} = fixture([], {
    assertContext() { if (!active) throw new Error('sesión cambió'); },
    async storagePut() { writes++; await delayed; }
  });
  const report = file(), key = {};
  const first = driver.upload(report, metadata, key), second = driver.upload(report, metadata, key);
  active = false;
  release();
  const res = await Promise.allSettled([first, second]);
  assert.ok(res.every(item => item.status === 'rejected' && /sesión cambió/.test(item.reason.message)));
  assert.equal(writes, 1);
  assert.equal(counts.save, 0);
});

test('mover y devolver Otro conserva identidad, fecha, versión y archivo sin escribir o mover los bytes', async () => {
  const original = {id:'legacy', estudioId:'S1', tipo:'otro', path:'S1/legacy/uno.pdf', subido:'2026-05-01', version:'seguimiento 3', extra:{foo:42}};
  const {driver, counts} = fixture([original]);
  const moved = await driver.reclassify('legacy', metadata);
  assert.equal(moved.tipo, 'otro');
  assert.equal(moved.path, original.path);
  assert.equal(safety.isReport(moved), true);
  assert.equal(safety.isOther(moved), false);
  assert.equal(rag.isClinicalDocument(moved), false);
  const restored = await driver.restore('legacy');
  assert.deepEqual(restored, original);
  assert.equal(safety.isOther(restored), true);
  assert.equal(counts.storage + counts.idb, 0);
  assert.equal(counts.save, 2);
});

test('impide reclasificar adjuntos de participante, de gastos, normativos y de otro estudio', async () => {
  const docs = [
    {id:'p', estudioId:'S1', pacienteId:'patient', tipo:'otro'},
    {id:'g', estudioId:'S1', gastoId:'gasto', tipo:'otro'},
    {id:'ci', estudioId:'S1', tipo:'ci'},
    {id:'otherStudy', estudioId:'S2', tipo:'otro'},
    {id:'native', estudioId:'S1', tipo:safety.TYPE}
  ];
  const {driver, counts} = fixture(docs);
  for (const doc of docs) await assert.rejects(driver.reclassify(doc.id, metadata), /de este estudio/);
  await assert.rejects(driver.restore('native'), /incorporados/);
  assert.equal(counts.save, 0);
});

test('corregir metadatos de un reporte preserva el binario y el tipo de origen', async () => {
  const docs = [
    {id:'heredado', estudioId:'S1', tipo:'otro', safetyReport:true, path:'S1/heredado/original.pdf', version:'V2'},
    {id:'propio', estudioId:'S1', tipo:safety.TYPE, path:'S1/propio/original.pdf'},
    {id:'ajeno', estudioId:'S2', tipo:safety.TYPE},
    {id:'general', estudioId:'S1', tipo:'otro'}
  ];
  const {driver, counts} = fixture(docs);
  for (const original of docs.slice(0,2)) {
    const updated = await driver.updateMetadata(original.id, metadata);
    assert.deepEqual(updated, {...original, safetyDate:'2024-02-29', safetyCategory:'SUSAR', safetyReference:'CASO 27'});
  }
  for (const other of docs.slice(2)) await assert.rejects(driver.updateMetadata(other.id, metadata), /de este estudio/);
  assert.equal(counts.storage + counts.idb, 0);
  assert.equal(counts.save, 2);
});

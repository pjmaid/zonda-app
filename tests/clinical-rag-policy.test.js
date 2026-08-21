const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const policy = require(path.join(root, 'clinical-rag-policy.js'));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const ragFunction = fs.readFileSync(path.join(root, 'supabase/functions/rag/index.ts'), 'utf8');
const pdfVendor = path.join(root, 'vendor', 'pdfjs-3.11.174');

test('nunca solicita más de 25 resultados documentales', () => {
  assert.equal(policy.MAX_RETURN_RESULTS, 25);
  assert.equal(policy.clampMaxReturnResults(30), 25);
  assert.equal(policy.clampMaxReturnResults(999), 25);
  assert.equal(policy.clampMaxReturnResults(0), 1);
  assert.doesNotMatch(html, /max_fragmentos\s*:\s*30/);
  assert.match(ragFunction, /const MAX_RETURN_RESULTS=25/);
  assert.match(ragFunction, /Math\.min\(MAX_RETURN_RESULTS,n\)/);
});

test('aísla las fuentes por protocolo', () => {
  const docs = [
    { id:'a', estudioId:'imvt', tipo:'protocolo', filename:'IMVT.pdf' },
    { id:'b', estudioId:'otro', tipo:'protocolo', filename:'Otro.pdf' },
    { id:'c', estudioId:'imvt', tipo:'manual', filename:'Manual IMVT.pdf' },
  ];
  assert.deepEqual(policy.clinicalDocuments(docs, 'imvt').map(d => d.id), ['a', 'c']);
  assert.throws(() => policy.clinicalQueryPayload({ pregunta:'x' }), /STUDY_SCOPE_REQUIRED/);
  assert.equal(policy.clinicalQueryPayload({ estudio_id:'imvt', max_fragmentos:80 }).max_fragmentos, 25);
});

test('excluye contratos, facturas, administrativos e historias clínicas', () => {
  const docs = [
    { estudioId:'imvt', tipo:'protocolo' },
    { estudioId:'imvt', tipo:'manual' },
    { estudioId:'imvt', tipo:'enmienda' },
    { estudioId:'imvt', tipo:'ci' },
    { estudioId:'imvt', tipo:'contrato' },
    { estudioId:'imvt', tipo:'gasto_medicamentos_comprobante' },
    { estudioId:'imvt', tipo:'otro' },
    { estudioId:'imvt', tipo:'historia', pacienteId:'p1' },
  ];
  assert.deepEqual(policy.clinicalDocuments(docs, 'imvt').map(d => d.tipo), ['protocolo','manual','enmienda','ci']);
  assert.throws(() => policy.clinicalQueryPayload({ estudio_id:'imvt', paciente_id:'p1' }), /PATIENT_DATA_NOT_ALLOWED/);
  assert.match(ragFunction, /ALLOWED_TYPES=\["protocolo","manual","enmienda","ci"\]/);
  assert.match(ragFunction, /return`org_id: ANY.*estudio_id: ANY.*tipo: ANY/);
  assert.doesNotMatch(ragFunction, /return`structData\.org_id/);
  assert.match(ragFunction, /if\(input\?\.paciente_id\)throw new Error\("PATIENT_DATA_NOT_ALLOWED"\)/);
  assert.match(ragFunction, /rest\/v1\/ec_docs\?select=id,data/);
  assert.match(ragFunction, /data\.estudioId!==studyId.*allowedTypes\.has.*data\.pacienteId/);
});

test('no acepta una respuesta clínica sin documento y página verificables', () => {
  const docs = [{ estudioId:'imvt', tipo:'protocolo', filename:'IMVT Protocol.pdf' }];
  assert.throws(() => policy.requireCitedClinicalAnswer({ respuesta:'Sí', citas:[] }, docs), /CLINICAL_CITATIONS_REQUIRED/);
  assert.throws(() => policy.requireCitedClinicalAnswer({ respuesta:'Sí', citas:[{documento:'IMVT Protocol.pdf',cita:'texto'}] }, docs), /CLINICAL_CITATIONS_REQUIRED/);
  const ok = policy.requireCitedClinicalAnswer({ respuesta:'Sí', citas:[{documento:'IMVT Protocol.pdf',pagina:42,cita:'texto'}] }, docs);
  assert.equal(ok.citas[0].pagina, 42);
  assert.match(ragFunction, /if\(!respuesta\|\|!citas\.length\)return\{respuesta:"",citas:\[\],sinRespuesta:true,confiable:false\}/);
  assert.match(ragFunction, /pagina:pageFrom\(reference\)/);
});

test('criterios, medicamentos y tareas siguen siendo borradores antes del guardado', () => {
  assert.match(html, /borrador, queda auditado y debe revisarse antes de aplicarlo/);
  assert.match(html, /EDIT_MEDS_PROHIBIDOS = actuales\.concat\(nuevos\)/);
  assert.match(html, /\$\('btnApplyImport'\)\.addEventListener/);
  assert.match(html, /Datos aplicados al formulario\. Revisá contra el protocolo y guardá el estudio/);
  assert.match(html, /EDIT_VISITAS = actuales/);
});

test('PDF.js y su worker se sirven localmente con licencia', () => {
  assert.match(html, /loadScript\('\/vendor\/pdfjs-3\.11\.174\/pdf\.min\.js'\)/);
  assert.match(html, /workerSrc = '\/vendor\/pdfjs-3\.11\.174\/pdf\.worker\.min\.js'/);
  assert.doesNotMatch(html, /cdnjs\.cloudflare\.com\/ajax\/libs\/pdf\.js/);
  for (const file of ['pdf.min.js','pdf.worker.min.js','LICENSE','README.md']) {
    assert.equal(fs.existsSync(path.join(pdfVendor, file)), true, file+' debe existir');
  }
});

test('la indexación distingue descarga, extracción y envío sin exponer errores crudos', () => {
  assert.match(html, /return ragFallo\('descarga'\)/);
  assert.match(html, /catch\(e\)\{ return ragFallo\('extraccion'\); \}/);
  assert.match(html, /catch\(e\)\{ return ragFallo\('envio'\); \}/);
  assert.match(html, /ragResumenFallos\(r\.errores\)/);
  assert.doesNotMatch(html, /ragResumenFallos[\s\S]{0,800}e\.message/);
});

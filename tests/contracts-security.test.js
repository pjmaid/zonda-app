const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260816_contratos_solo_facturacion.sql'),
  'utf8'
);
const aiFunction = fs.readFileSync(
  path.join(root, 'supabase/functions/ia/index.ts'),
  'utf8'
);

test('los contratos se administran solamente desde Facturación', () => {
  const studyTypeSelect = html.match(/<select id="docTipo">([\s\S]*?)<\/select>/);
  assert.ok(studyTypeSelect);
  assert.doesNotMatch(studyTypeSelect[1], /value="contrato"/);
  assert.match(html, /id="factContratoFile"/);
  assert.match(html, /id="btnFactContratoUpload"/);
  assert.match(html, /function studyDocsOf\(studyId\).*!esDocumentoFinanciero\(d\)/);
  assert.match(html, /const list = studyDocsOf\(stId\)/);
  assert.match(html, /if\(esDocumentoFinanciero\(doc\)\) return false/);
  assert.match(html, /factDesindexarContratos\(contratos\)/);
});

test('Facturación permite elegir, abrir, descargar y eliminar copias', () => {
  assert.match(html, /id="factContratoSelect"/);
  assert.match(html, /id="factContratosLista"/);
  assert.match(html, /data-contrato-select/);
  assert.match(html, /id="btnFactContratoVer"/);
  assert.match(html, /id="btnFactContratoDescargar"/);
  assert.match(html, /id="btnFactContratoEliminar"/);
  assert.match(html, /data-contrato-ver/);
  assert.match(html, /data-contrato-dl/);
  assert.match(html, /data-contrato-del/);
  assert.match(html, /function factEliminarContrato\(doc\)/);
  assert.match(html, /function factContratoSeleccionado\(/);
});

test('el chat consulta todos los contratos y adendas y declara su finalidad', () => {
  assert.match(html, /id="factChatInput"/);
  assert.match(html, /id="btnFactChat"/);
  assert.match(html, /purpose:'contrato_consulta'/);
  assert.match(html, /const contratos=factContratos\(\$\('factStudy'\)\.value\)/);
  assert.match(html, /CONJUNTO DE CONTRATOS, PRESUPUESTOS Y ADENDAS DEL ESTUDIO/);
  assert.match(html, /exclusivamente con lo que figura en el conjunto de contratos/);
  assert.match(html, /No surge de los contratos cargados/);
  assert.match(html, /nombre del archivo y su versión/);
});

test('el tarifario analiza el conjunto completo y admite OCR visual de PDF escaneado', () => {
  assert.match(html, /Analizar todos y armar el tarifario/);
  assert.match(html, /const contratos = factContratos\(stId\)/);
  assert.match(html, /CONJUNTO COMPLETO DE CONTRATOS, PRESUPUESTOS Y ADENDAS DEL ESTUDIO/);
  assert.match(html, /Compará el contrato original con todas las adendas/);
  assert.match(html, /DOCUMENTO ESCANEADO/);
  assert.match(html, /pdfPageImage\(pg,1100\)/);
  assert.match(html, /Localizando visualmente las páginas del tarifario/);
  assert.match(html, /total\\s\+cost\\s\+per/);
  assert.match(html, /purpose:'contrato_tarifario'/);
  assert.match(html, /purpose:'contrato_tarifario_completar'/);
  assert.match(html, /Tarifario incompleto/);
  assert.match(html, /factVisitaClave/);
});

test('RLS protege metadatos y archivos de contrato con el permiso de facturación', () => {
  assert.match(migration, /create or replace function ec_can_facturacion\(\)/i);
  assert.match(migration, /create or replace function ec_can_document\(p_data jsonb\)/i);
  assert.match(migration, /p_data ->> 'tipo'.*= 'contrato'/s);
  assert.match(migration, /gasto_\(remis\|medicamentos\)_comprobante/);
  assert.match(migration, /create policy contracts_ver on ec_docs/i);
  assert.match(migration, /create policy contracts_ins on ec_docs/i);
  assert.match(migration, /create policy contracts_upd on ec_docs/i);
  assert.match(migration, /create policy contracts_del on ec_docs/i);
  assert.match(migration, /return ec_can_document\(v_doc_data\)/i);
});

test('remises y medicamentos tienen secciones privadas con comprobantes', () => {
  assert.match(html, /id="factGastosRemis"/);
  assert.match(html, /id="factGastosMedicamentos"/);
  assert.match(html, /gasto_remis:/);
  assert.match(html, /gasto_medicamentos:/);
  assert.match(html, /tipo:tipo\+'_comprobante'/);
  assert.match(html, /function factGuardarGasto\(tipo\)/);
  assert.match(html, /function factEliminarGasto\(tipo,id\)/);
  assert.match(migration, /create or replace function ec_can_record\(p_data jsonb\)/i);
  assert.match(migration, /'gasto_remis','gasto_medicamentos'/);
  assert.match(migration, /create policy finance_records_ver on ec_records/i);
  assert.match(migration, /create policy finance_records_ins on ec_records/i);
  assert.match(migration, /create policy finance_records_upd on ec_records/i);
  assert.match(migration, /create policy finance_records_del on ec_records/i);
});

test('la Edge Function bloquea preguntas y lectura de contratos sin permiso', () => {
  assert.match(aiFunction, /billingAllowed/);
  assert.match(aiFunction, /\^contrato_/);
  assert.match(aiFunction, /BILLING_ACCESS_REQUIRED/);
  assert.match(aiFunction, /profile\?\.data\?\.facturacion === true/);
});

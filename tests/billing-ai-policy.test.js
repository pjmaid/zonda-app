const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const policy = require(path.join(root, 'billing-ai-policy.js'));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const docs = [
  {id:'a',estudioId:'study-a',tipo:'contrato',filename:'Contrato GARDENIA.pdf',version:'Adenda 2'},
  {id:'b',estudioId:'study-b',tipo:'contrato',filename:'Contrato SRF201.pdf',version:'Original'},
  {id:'c',estudioId:'study-a',tipo:'protocolo',filename:'Protocolo.pdf',version:'3.0'}
];

test('aísla las fuentes de facturación por estudio y excluye documentos clínicos', () => {
  assert.deepEqual(policy.allowedContracts(docs,'study-a').map(doc=>doc.id),['a']);
  assert.deepEqual(policy.allowedContracts(docs,'study-b').map(doc=>doc.id),['b']);
});

test('exige documento del mismo estudio y ubicación contractual verificable', () => {
  assert.equal(policy.verifyCitation('Contrato GARDENIA.pdf, Adenda 2, página 14',docs,'study-a').valid,true);
  assert.equal(policy.verifyCitation('Contrato SRF201.pdf, página 8',docs,'study-a').valid,false);
  assert.equal(policy.verifyCitation('Contrato GARDENIA.pdf: honorario 300 USD',docs,'study-a').valid,false);
});

test('una respuesta sin cita entre corchetes no se marca confiable', () => {
  assert.equal(policy.verifyAnswer('La visita vale 300 USD.',docs,'study-a').trusted,false);
  assert.equal(policy.verifyAnswer('La visita vale 300 USD [Contrato GARDENIA.pdf, página 14].',docs,'study-a').trusted,true);
});

test('las filas del tarifario sin cita válida quedan bloqueadas antes de persistir', () => {
  const rows=policy.gateTariffRows([
    {nombre:'V1',valor:300,cita:'Contrato GARDENIA.pdf, cláusula 4.2'},
    {nombre:'V2',valor:400,cita:'Contrato GARDENIA.pdf'}
  ],docs,'study-a');
  assert.equal(rows[0].citaValida,true);
  assert.equal(rows[1].citaValida,false);
  assert.match(html,/if\(!v\.citaValida\) return/);
  assert.match(html,/FACT_PROP\.extras\.filter\(x=>x\.citaValida\)/);
  assert.match(html,/sin cita verificable/);
});

test('el tarifario y sus borradores nunca se reutilizan entre estudios', () => {
  assert.match(html,/function factTarifas\(stId\)\{\s*return logRows\('tarifas'\)\.filter\(r=>r\.estudioId===stId\)/);
  assert.match(html,/FACT_PROP && FACT_PROP\.estudioId!==stId/);
  assert.match(html,/asistida:true,\s*estudioId:stId/);
  assert.match(html,/El borrador pertenece a otro estudio y fue descartado/);
});

test('la interfaz carga la política y conserva toda salida como borrador revisable', () => {
  assert.match(html,/billing-ai-policy\.js/);
  assert.match(html,/Borrador sin cita contractual verificable/);
  assert.match(html,/Borrador generado con asistencia de IA — requiere revisión humana/);
});

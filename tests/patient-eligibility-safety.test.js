const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const policy = require(path.join(root, 'patient-eligibility-policy.js'));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const aiFunction = fs.readFileSync(path.join(root, 'supabase/functions/ia/index.ts'), 'utf8');

test('anonimiza identificadores del paciente antes del envío', () => {
  const input = 'Paciente ABC-001, J.M.P., DNI 12.345.678, HC 998877 y mail prueba@example.com';
  const clean = policy.deidentifyText(input, ['ABC-001', 'J.M.P.']);
  assert.doesNotMatch(clean.text, /ABC-001|J\.M\.P\.|12\.345\.678|998877|prueba@example\.com/);
  assert.ok(clean.replacements >= 5);
  assert.match(html, /patientEvidenceSafeText\(text\)/);
  assert.match(aiFunction, /const clean = redactText/);
});

test('Vertex nunca recibe documentos ni identificadores del paciente', () => {
  assert.doesNotMatch(html, /id="btnEvalIndex"|id="btnNarrIndex"/);
  assert.doesNotMatch(html, /async function ragEvalCriterios|async function ragNarrarLote/);
  assert.doesNotMatch(html, /ragLineas\([^\n]+paciente_id/);
  assert.match(html, /ragCitasCriterios\(st, estudioId\)/);
  assert.match(html, /\{ estudio_id: estudioId\|\|'' \}/);
});

test('no envía imágenes de pacientes a la IA', () => {
  assert.doesNotMatch(html, /id="evalVisual"|id="narrVisual"/);
  assert.doesNotMatch(html, /aiEvalCriteria\(study, text, imgs\)/);
  assert.doesNotMatch(html, /aiNarrarCriterios\(st, texto, p, imgs/);
});

test('sin cita verificable del protocolo la sugerencia queda pendiente', () => {
  const results = [{clave:'i0',respuesta:'si',justificacion:'Edad 36 años'}];
  const gated = policy.applyCitationGate(results, {});
  assert.equal(gated[0].respuesta, 'pendiente');
  assert.equal(gated[0].confiable, false);

  const citation = {documento:'Protocolo.pdf',pagina:42,cita:'Edad mínima 18 años'};
  const trusted = policy.applyCitationGate(results, {i0:citation});
  assert.equal(trusted[0].respuesta, 'si');
  assert.equal(trusted[0].confiable, true);
  assert.deepEqual(trusted[0].citaProtocolo, citation);
});

test('valida documento y página contra las citas devueltas por Vertex', () => {
  const items = [
    {clave:'i0',documento:'Protocolo.pdf',pagina:'42',cita:'Edad mínima 18 años'},
    {clave:'e0',documento:'Otro.pdf',pagina:'7',cita:'Embarazo'},
  ];
  const verified = policy.verifiedCriterionCitations(items,[{documento:'Protocolo.pdf',pagina:42}]);
  assert.deepEqual(Object.keys(verified), ['i0']);
  assert.equal(verified.i0.pagina, 42);
});

test('las sugerencias y sus citas siguen siendo borrador hasta guardar Pacientes', () => {
  assert.match(html, /PA_JUST\[k\] = \{ ai:true/);
  assert.match(html, /critJust: Object\.assign\(\{\}, PA_JUST\)/);
  assert.match(html, /Confirmá cada criterio antes de guardar/);
});

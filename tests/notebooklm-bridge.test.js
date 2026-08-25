const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('ofrece el puente de ida y vuelta con NotebookLM', () => {
  assert.match(html, /id="btnNlmPrompt">\s*📋 Copiar consulta y abrir NotebookLM/);
  assert.match(html, /id="btnNlmPaste">\s*📥 Pegar respuesta desde el portapapeles/);
  assert.match(html, /const NLM_URL = 'https:\/\/notebook\.google\.com\/'/);
  assert.match(html, /window\.open\(NLM_URL, '_blank', 'noopener,noreferrer'\)/);
  assert.match(html, /navigator\.clipboard\.writeText\(NLM_PROMPT\)/);
  assert.match(html, /navigator\.clipboard\.readText\(\)/);
});

test('la respuesta se interpreta localmente y queda como borrador revisable', () => {
  assert.match(html, /function importarRespuestaNotebookLM\(text\)/);
  assert.match(html, /const nlm = parseNotebookLM\(text\)/);
  assert.match(html, /\$\('impIncl'\)\.value = nlm\.incl\.join\('\\n'\)/);
  assert.match(html, /\$\('impExcl'\)\.value = nlm\.excl\.join\('\\n'\)/);
  assert.match(html, /Revisá y aplicá/);
  assert.match(html, /\$\('btnApplyImport'\)\.addEventListener/);
});

test('el puente declara que usa solo el protocolo y no automatiza la sesión', () => {
  assert.match(html, /NotebookLM se usa solo con el protocolo/);
  assert.match(html, /no automatiza ni inspecciona[\s\S]{0,120}su sesión/);
  assert.match(html, /ni envía datos de pacientes/);
});

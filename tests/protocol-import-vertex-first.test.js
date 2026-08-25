const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('la importación del protocolo prioriza Vertex aunque Gemini esté configurado', () => {
  assert.match(html, /const extraerConIaPorSeccion = src === 'doc' && aiConfigured\(\) && !ragActivo\(\)/);
  assert.match(html, /if\(ragActivo\(\) && src === 'doc'\)/);
  assert.match(html, /if\(ragEstricto\(\)\) throw new Error\(T\('Búsqueda documental'\)/);
  assert.match(html, /Búsqueda documental segura:/);
  assert.match(html, /Motor de respaldo:/);
});

test('hace consultas complementarias y combina criterios sin duplicados', () => {
  assert.match(html, /const consultas = \{[\s\S]{0,100}inclusion:\[[\s\S]{0,1200}exclusion:\[/);
  assert.match(html, /for\(const enfoque of consultas\[tipo\]\)/);
  assert.match(html, /const \[inc, exc\] = await Promise\.all/);
  assert.match(html, /const combinar = respuestas =>/);
  assert.match(html, /claves\.has\(clave\)/);
  assert.match(html, /consultas:inc\.length\+exc\.length/);
});

test('reintenta fallas transitorias sin aumentar el límite documental', () => {
  assert.match(html, /for\(let intento=0; intento<3; intento\+\+\)/);
  assert.match(html, /429\|500\|502\|503\|504/);
  assert.match(html, /setTimeout\(resolve, 700\*Math\.pow\(2,intento\)\)/);
  assert.match(html, /max_fragmentos: 25/);
});

test('retira el puente manual de NotebookLM y conserva el pegado local de emergencia', () => {
  assert.doesNotMatch(html, /id="btnNlmPrompt"/);
  assert.doesNotMatch(html, /id="btnNlmPaste"/);
  assert.doesNotMatch(html, /notebook\.google\.com/);
  assert.match(html, /function parseRespuestaEstructurada\(txt\)/);
  assert.match(html, /function importarRespuestaEstructurada\(text\)/);
  assert.match(html, /nunca envía su contenido a IA/);
  assert.match(html, /Revisá y aplicá/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('Herramientas no muestra Administración y facturación', () => {
  const groups = html.match(/const LOG_GRUPOS = \{[\s\S]*?\n\};/)?.[0] || '';
  assert.doesNotMatch(groups, /Administración y facturación/);
  assert.doesNotMatch(groups, /\badm\s*:/);
});

test('el selector de herramientas omite los registros administrativos', () => {
  const featAll = html.match(/function featAll\(\)\{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(featAll, /if\(d\.grupo==='adm'\) continue;/);
});

test('Facturación conserva las tarifas y su acceso principal', () => {
  assert.match(html, /tarifas:\{ icon:'💰', grupo:'adm'/);
  assert.match(html, /<button data-tab="fact">💵 Facturación<\/button>/);
  assert.match(html, /function renderFact\(\)/);
});

test('el editor de tarifas conserva el contexto de Facturación y nunca vuelve a Herramientas', () => {
  assert.match(html, /ZONDA_LOG_PARENT_TAB = tipo==='tarifas' \? 'fact' : 'tools'/);
  assert.match(html, /id==='view-log' && window\.ZONDA_LOG_PARENT_TAB/);
  assert.match(html, /if\(window\.ZONDA_LOG_PARENT_TAB==='fact'\)\{\s*renderFact\(\); showView\('view-fact'\); return;/);
  assert.match(html, /openLog\('tarifas'\)/);
});

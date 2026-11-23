const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = html.slice(html.indexOf('function aiServerError('), html.indexOf('/* ================= CAPA ÚNICA DE CONSULTA'));
const json = value => JSON.parse(JSON.stringify(value));
function app(options = {}) {
  const state = { requests: [], confirmations: [], notices: [] };
  const ctx = vm.createContext({
    DB: { patients: options.patients || [] }, AI_STATUS: null,
    T: value => value,
    confirm(message) {
      state.confirmations.push(message);
      return options.confirm ? options.confirm(state.confirmations.length) : true;
    },
    syncStatus(...args) { state.notices.push(args); },
    async supaFetch(_url, init) {
      state.requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify(options.response || { text: 'Borrador de prueba', meta: { provider: 'fixture', model: 'fixture' } }), { status: options.status || 200 });
    },
  });
  vm.runInContext(source, ctx);
  return { ctx, state };
}

test('cada solicitud con imágenes requiere una confirmación nueva', async () => {
  const { ctx, state } = app({ confirm: count => count === 1 });
  const content = [{ t: 'img', mime: 'image/png', data: 'AAAA' }];
  await ctx.aiChat({ content });
  await assert.rejects(ctx.aiChat({ content }), /falta confirmar/);
  assert.equal(state.confirmations.length, 2);
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].images_confirmed_deidentified, true);
});

test('las solicitudes solo de texto no piden confirmación de imágenes', async () => {
  const { ctx, state } = app();
  await ctx.aiChat({ content: 'Material sintético' });
  assert.equal(state.confirmations.length, 0);
  assert.equal(state.requests[0].images_confirmed_deidentified, false);
});

test('solo adjunta identificadores presentes y conserva la coincidencia número 51', async () => {
  const initials = ['ÁB', ...Array.from({ length: 60 }, (_, index) => 'Inicial' + index)];
  const { ctx, state } = app({ patients: [...initials.map(iniciales => ({ iniciales })), { iniciales: 'NoRelevante' }] });
  await ctx.aiChat({ content: initials.join('; ') });
  assert.deepEqual(state.requests[0].identifiers, initials);
  assert.ok(!state.requests[0].identifiers.includes('NoRelevante'));
});

test('la selección de identificadores respeta límites Unicode e incluye el sistema', () => {
  const { ctx } = app({ patients: [{ iniciales: 'ÁB' }, { iniciales: 'A.B' }, { iniciales: 'AB' }, { iniciales: 'JS' }] });
  assert.deepEqual(json(ctx.aiIdentifiers([{ t: 'text', text: 'ÁB A.B ABC' }], 'Iniciales JS')), ['ÁB', 'A.B', 'JS']);
});

test('una auditoría final pendiente conserva la respuesta y muestra aviso persistente', async () => {
  const { ctx, state } = app({ response: { text: 'Resultado obtenido', meta: { audit_pending: true, request_id: 'request-fixture' } } });
  const result = await ctx.aiChat({ content: 'Material sintético' });
  assert.equal(result.text, 'Resultado obtenido');
  assert.equal(state.notices.length, 1);
  assert.deepEqual(state.notices[0].slice(0, 2), ['audit', 'error']);
  assert.match(state.notices[0][2], /no repitas.*request-fixture/);
});

test('los errores de IA se explican sin exponer mensajes internos del proveedor', () => {
  const { ctx } = app();
  assert.match(ctx.aiServerError(504, { error: 'AI_TIMEOUT' }), /tardó demasiado/);
  assert.match(ctx.aiServerError(429, { error: 'AI_RATE_LIMITED' }), /límite de uso/);
  assert.match(ctx.aiServerError(400, { error: 'IDENTIFIERS_LIMIT_EXCEEDED' }), /Dividilo/);
  assert.match(ctx.aiServerError(500, { error: 'AI_AUDIT_FAILED' }), /No se envió material/);
  assert.doesNotMatch(ctx.aiServerError(500, { error: 'PRIVATE INPUT OR SERVER DETAIL' }), /PRIVATE INPUT/);
});

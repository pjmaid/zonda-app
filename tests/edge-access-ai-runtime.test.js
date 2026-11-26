const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { webcrypto } = require('node:crypto');

// Execute the real Edge entrypoints with synthetic identities and a deterministic
// HTTP boundary. No live accounts, clinical data or provider requests are used.
const actorId = '11111111-1111-4111-8111-111111111111';
const targetId = '22222222-2222-4222-8222-222222222222';
const siteId = '33333333-3333-4333-8333-333333333333';
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
const source = name => stripTypeScriptTypes(fs.readFileSync(path.join(__dirname, '../supabase/functions', name, 'index.ts'), 'utf8'));
const sources = { users: source('crear-usuario'), ai: source('ia') };

function edge(kind, options = {}) {
  let serve;
  const state = { calls: [], audits: [], providerCalls: [], ...options.state };
  const actor = { user_id: actorId, org_id: siteId, rol: 'admin', activo: true, superadmin: false, ...options.actor };
  const target = { user_id: targetId, org_id: siteId, rol: 'medico', activo: true, superadmin: false, ...options.target };
  const env = { SUPABASE_URL: 'https://fixture.supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'service-fixture', SUPABASE_ANON_KEY: 'anon-fixture', OPENAI_API_KEY: 'provider-fixture', ...options.env };
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const call = { url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined, init };
    state.calls.push(call);
    if (url.pathname === '/rest/v1/ec_audit') state.audits.push(call.body);
    if (url.host === 'api.openai.com') state.providerCalls.push(call);
    const custom = await options.respond?.(call, state);
    if (custom !== undefined) return custom;
    if (url.pathname === '/auth/v1/user') return reply({ id: actorId, email: 'actor@example.invalid' });
    if (url.pathname === '/rest/v1/ec_members' && call.method === 'GET') {
      if (url.searchParams.has('rol')) return reply([actor, target]);
      return reply([url.searchParams.get('user_id') === `eq.${targetId}` ? target : actor]);
    }
    if (url.pathname === '/rest/v1/ec_orgs' && call.method === 'GET') return reply([{ id: siteId }]);
    if (url.pathname === '/rest/v1/ec_orgs' && call.method === 'POST') return reply([{ id: 'new-site' }]);
    if (url.pathname === '/rest/v1/ec_users' && call.method === 'GET') {
      const isTarget = url.searchParams.get('data->>authId') === `eq.${targetId}`;
      return reply([{ id: isTarget ? 'profile-target' : 'profile-actor', data: {
        authId: isTarget ? targetId : actorId, activo: true, facturacion: false, ...options.profile,
      } }]);
    }
    if (url.pathname === '/rest/v1/ec_studies') return reply([]);
    if (url.host === 'api.openai.com') return reply({ choices: [{ message: { content: 'Borrador de prueba' }, finish_reason: 'stop' }] });
    if (/\/auth\/v1\/(admin\/users|invite)$/.test(url.pathname) && call.method === 'POST') return reply({ id: targetId });
    if (url.pathname === `/auth/v1/admin/users/${targetId}` && call.method === 'GET') return reply({ id: targetId, email: 'target@example.invalid' });
    if (call.method !== 'GET') return reply({});
    throw new Error(`Unexpected fixture route: ${call.method} ${url.pathname}`);
  };
  const ctx = vm.createContext({
    fetch, Request, Response, URL, AbortSignal, Error, DOMException,
    crypto: webcrypto,
    Deno: { env: { get: key => env[key] }, serve: handler => { serve = handler; } },
  });
  vm.runInContext(sources[kind], ctx);
  return {
    state,
    async request(body) {
      const response = await serve(new Request('https://fixture.supabase.test/functions/v1/test', {
        method: 'POST', headers: { Authorization: 'Bearer actor-fixture', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }));
      return { status: response.status, body: await response.json() };
    },
  };
}

const passwordInput = { accion: 'cambiar_clave', authId: targetId, claveTemporal: 'Temporary123!' };
const createInput = { accion: 'usuario', email: 'new@example.invalid', rol: 'medico' };
const deleteInput = { accion: 'eliminar_usuario', authId: targetId, profileId: 'profile-target' };
const aiInput = { content: 'Material de ejemplo sin datos personales.', purpose: 'protocolo_resumen' };
const authMutations = state => state.calls.filter(call => call.url.pathname.startsWith('/auth/') && call.method !== 'GET');

test('cambiar la propia clave la confirma como personal; una clave asignada a otro sigue temporal', async () => {
  for (const ownAccount of [true, false]) {
    const app = edge('users', { actor: { superadmin: !ownAccount } });
    const id = ownAccount ? actorId : targetId;
    const result = await app.request({ ...passwordInput, authId: id });
    assert.equal(result.status, 200);
    const updates = authMutations(app.state);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].method, 'PUT');
    assert.equal(updates[0].url.pathname, `/auth/v1/admin/users/${id}`);
    assert.deepEqual(updates[0].body.user_metadata, { clave_temporal: !ownAccount });
    assert.match(result.body.mensaje, ownAccount ? /clave personal quedó actualizada/ : /deberá reemplazarla/);
    assert.equal(app.state.audits.length, 2);
    assert.ok(app.state.audits.every(event => event.detalle.includes(ownAccount ? 'personal' : 'temporal')));
    assert.ok(app.state.audits.every(event => !JSON.stringify(event).includes(passwordInput.claveTemporal)));
  }
});

test('un administrador de sitio no puede cambiar la clave ni borrar un superadministrador', async () => {
  for (const input of [passwordInput, deleteInput]) {
    const app = edge('users', { target: { superadmin: true } });
    const result = await app.request(input);
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'SUPERADMIN_TARGET_FORBIDDEN');
    assert.equal(authMutations(app.state).length, 0);
  }
});

test('las funciones con service_role rechazan sitios desactivados', async () => {
  for (const kind of ['users', 'ai']) {
    const app = edge(kind, { respond: call => call.url.pathname === '/rest/v1/ec_orgs' ? reply([]) : undefined });
    const result = await app.request(kind === 'users' ? passwordInput : aiInput);
    assert.equal(result.status, 401);
    assert.equal(authMutations(app.state).length, 0);
    assert.equal(app.state.providerCalls.length, 0);
  }
});

test('la auditoría de intención fallida impide modificar cuentas', async () => {
  const app = edge('users', { respond: call => call.url.pathname === '/rest/v1/ec_audit' ? reply({}, 503) : undefined });
  const result = await app.request(passwordInput);
  assert.equal(result.status, 500);
  assert.equal(result.body.code, 'AUDIT_WRITE_FAILED');
  assert.equal(authMutations(app.state).length, 0);
});

test('el fallo de auditoría final informa que la clave sí cambió', async () => {
  const app = edge('users', { respond: (call, state) => call.url.pathname === '/rest/v1/ec_audit' && state.audits.length === 2 ? reply({}, 503) : undefined });
  const result = await app.request(passwordInput);
  assert.equal(result.status, 200);
  assert.equal(result.body.applied, true);
  assert.equal(result.body.audit_pending, true);
  assert.match(result.body.mensaje, /No repitas/);
  assert.doesNotMatch(result.body.mensaje, /no se aplicaron/);
  assert.equal(authMutations(app.state).length, 1);
});

test('la baja rechaza una ficha ajena antes de eliminar la cuenta', async () => {
  const app = edge('users');
  const result = await app.request({ ...deleteInput, profileId: 'another-profile' });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'PROFILE_MISMATCH_FORBIDDEN');
  assert.equal(authMutations(app.state).length, 0);
});

test('la baja deriva la ficha de authId aunque el cliente omita profileId', async () => {
  const app = edge('users');
  const result = await app.request({ accion: 'eliminar_usuario', authId: targetId });
  assert.equal(result.status, 200);
  const deletes = app.state.calls.filter(call => call.method === 'DELETE');
  assert.equal(deletes.length, 2);
  assert.equal(deletes[0].url.pathname, `/auth/v1/admin/users/${targetId}`);
  assert.equal(deletes[1].url.searchParams.get('id'), 'eq.profile-target');
  assert.equal(deletes[1].url.searchParams.get('org_id'), `eq.${siteId}`);
});

test('la baja parcial distingue cuenta eliminada de ficha pendiente', async () => {
  const app = edge('users', { respond: call => call.url.pathname === '/rest/v1/ec_users' && call.method === 'DELETE' ? reply({}, 503) : undefined });
  const result = await app.request(deleteInput);
  assert.equal(result.status, 200);
  assert.equal(result.body.applied, true);
  assert.equal(result.body.cleanup_pending, true);
  assert.equal(app.state.audits[1].accion, 'baja parcial');
});

test('las invitaciones envían redirect_to en query y excluyen tokens de la sesión', async () => {
  const app = edge('users');
  const result = await app.request({ ...createInput, redirect: 'https://zonda-app.pages.dev/?code=secret#access_token=secret' });
  assert.equal(result.status, 200);
  const invitation = authMutations(app.state)[0];
  assert.equal(invitation.url.pathname, '/auth/v1/invite');
  assert.equal(invitation.url.searchParams.get('redirect_to'), 'https://zonda-app.pages.dev/');
  assert.equal(invitation.body.redirect_to, undefined);
});

test('los enlaces de invitación a otro origen se rechazan antes del alta', async () => {
  const app = edge('users');
  const result = await app.request({ ...createInput, redirect: 'https://other.example.invalid/' });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'REDIRECT_INVALID');
  assert.equal(authMutations(app.state).length, 0);
});

test('no se pueden asignar estudios inexistentes o de otro sitio', async () => {
  const app = edge('users');
  const result = await app.request({ ...createInput, estudios: ['study-outside'] });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'STUDIES_INVALID');
  assert.equal(authMutations(app.state).length, 0);
});

test('el alta verifica y deduplica estudios del sitio antes de guardar el perfil', async () => {
  const app = edge('users', { respond: call => {
    if (call.url.pathname !== '/rest/v1/ec_studies') return;
    assert.equal(call.url.searchParams.get('org_id'), `eq.${siteId}`);
    return reply([{ id: 'study-a' }]);
  } });
  const result = await app.request({ ...createInput, estudios: ['study-a', 'study-a'] });
  assert.equal(result.status, 200);
  const profile = app.state.calls.find(call => call.url.pathname === '/rest/v1/ec_users' && call.method === 'POST');
  assert.deepEqual(profile.body.data.estudios, ['study-a']);
});

test('el rollback fallido informa un alta incompleta, sin asegurar reversión', async () => {
  const app = edge('users', { respond: call => {
    if (call.url.pathname === '/rest/v1/ec_users' && call.method === 'POST') return reply({}, 503);
    if (call.method === 'DELETE') return reply({}, 503);
  } });
  const result = await app.request(createInput);
  assert.equal(result.status, 500);
  assert.equal(result.body.code, 'ROLLBACK_INCOMPLETE');
  assert.equal(result.body.applied, 'partial');
});

test('IA no transmite contenido cuando falla la auditoría previa', async () => {
  const app = edge('ai', { respond: call => call.url.pathname === '/rest/v1/ec_audit' ? reply({}, 503) : undefined });
  const result = await app.request(aiInput);
  assert.equal(result.status, 500);
  assert.equal(result.body.error, 'AI_AUDIT_FAILED');
  assert.equal(app.state.providerCalls.length, 0);
});

test('IA enlaza intención y resultado con eventos distintos sin auditar contenido', async () => {
  const app = edge('ai');
  const result = await app.request(aiInput);
  assert.equal(result.status, 200);
  assert.equal(app.state.audits.length, 2);
  const [intent, completed] = app.state.audits;
  assert.equal(intent.accion, 'generacion_solicitada');
  assert.equal(completed.accion, 'generacion_asistida');
  assert.equal(intent.ref_id, result.body.meta.request_id);
  assert.equal(completed.ref_id, intent.ref_id);
  assert.notEqual(intent.event_id, completed.event_id);
  assert.doesNotMatch(JSON.stringify(app.state.audits), /Material de ejemplo/);
  const boundary = app.state.calls.map(call => call.url.pathname);
  assert.ok(boundary.indexOf('/rest/v1/ec_audit') < boundary.indexOf('/v1/chat/completions'));
});

test('IA conserva un resultado generado cuando falla solo la auditoría final', async () => {
  const app = edge('ai', { respond: (call, state) => call.url.pathname === '/rest/v1/ec_audit' && state.audits.length === 2 ? reply({}, 503) : undefined });
  const result = await app.request(aiInput);
  assert.equal(result.status, 200);
  assert.equal(result.body.text, 'Borrador de prueba');
  assert.equal(result.body.meta.audit_pending, true);
  assert.equal(app.state.providerCalls.length, 1);
});

test('IA usa un filtro de identidad y no una lista de perfiles truncada por paginación', async () => {
  const app = edge('ai', { actor: { rol: 'medico' }, profile: { facturacion: true } });
  const result = await app.request({ ...aiInput, purpose: 'contrato_consulta' });
  assert.equal(result.status, 200);
  const lookup = app.state.calls.find(call => call.url.pathname === '/rest/v1/ec_users');
  assert.equal(lookup.url.searchParams.get('data->>authId'), `eq.${actorId}`);
  assert.equal(lookup.url.searchParams.get('org_id'), `eq.${siteId}`);
});

test('IA exige facturación incluso si la finalidad llega en mayúsculas', async () => {
  const app = edge('ai', { actor: { rol: 'medico' } });
  const result = await app.request({ ...aiInput, purpose: 'CONTRATO_CONSULTA' });
  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'BILLING_ACCESS_REQUIRED');
  assert.equal(app.state.providerCalls.length, 0);
});

test('IA rechaza perfiles desactivados o ambiguos', async () => {
  const inactive = edge('ai', { profile: { activo: false } });
  assert.equal((await inactive.request(aiInput)).status, 401);
  const duplicate = edge('ai', { respond: call => call.url.pathname === '/rest/v1/ec_users' ? reply([{ data: {} }, { data: {} }]) : undefined });
  assert.equal((await duplicate.request(aiInput)).body.error, 'PROFILE_AMBIGUOUS');
  assert.equal(inactive.state.providerCalls.length + duplicate.state.providerCalls.length, 0);
});

test('el respaldo de email solo consulta perfiles legados sin authId', async () => {
  const app = edge('ai', { actor: { rol: 'medico' }, respond: call => {
    if (call.url.pathname !== '/rest/v1/ec_users') return;
    if (call.url.searchParams.has('data->>authId')) return reply([]);
    assert.equal(call.url.searchParams.get('data->>email'), 'imatch.^actor@example\\.invalid$');
    assert.equal(call.url.searchParams.get('or'), '(data->>authId.is.null,data->>authId.eq.)');
    return reply([]);
  } });
  const result = await app.request({ ...aiInput, purpose: 'contrato_consulta' });
  assert.equal(result.status, 403);
});

test('los perfiles legados conservan acceso con email en mayúsculas sin aceptar otra identidad', async () => {
  for (const sameIdentity of [true, false]) {
    const app = edge('ai', { actor: { rol: 'medico' }, respond: call => {
      if (call.url.pathname !== '/rest/v1/ec_users') return;
      if (call.url.searchParams.has('data->>authId')) return reply([]);
      return reply([{ data: { email: 'ACTOR@EXAMPLE.INVALID', facturacion: true, authId: sameIdentity ? '' : targetId } }]);
    } });
    const result = await app.request({ ...aiInput, purpose: 'contrato_consulta' });
    assert.equal(result.status, sameIdentity ? 200 : 403);
  }
});

test('la baja reconoce la ficha legada por email exacto sin distinguir mayúsculas', async () => {
  const app = edge('users', { respond: call => {
    if (call.url.pathname !== '/rest/v1/ec_users' || call.method !== 'GET') return;
    if (call.url.searchParams.has('data->>authId')) return reply([]);
    assert.equal(call.url.searchParams.get('data->>email'), 'imatch.^target@example\\.invalid$');
    return reply([{ id: 'legacy-target', data: { email: 'TARGET@EXAMPLE.INVALID' } }]);
  } });
  const result = await app.request({ ...deleteInput, profileId: 'legacy-target' });
  assert.equal(result.status, 200);
  const deleted = app.state.calls.find(call => call.url.pathname === '/rest/v1/ec_users' && call.method === 'DELETE');
  assert.equal(deleted.url.searchParams.get('id'), 'eq.legacy-target');
});

test('IA redacta nombres que comienzan o terminan con letras acentuadas', async () => {
  const app = edge('ai');
  const result = await app.request({ ...aiInput, content: 'Álvaro informó a José. DNI 12345678. Contacto persona@example.invalid.', identifiers: ['Álvaro', 'José'] });
  assert.equal(result.status, 200);
  const transmitted = JSON.stringify(app.state.providerCalls[0].body);
  assert.doesNotMatch(transmitted, /Álvaro|José|12345678|persona@example/);
  assert.equal(result.body.meta.redactions, 4);
});

test('IA redacta más de 50 coincidencias y también iniciales de dos letras', async () => {
  const identifiers = ['ÁB', ...Array.from({ length: 60 }, (_, index) => 'Inicial' + index)];
  const app = edge('ai');
  const result = await app.request({ ...aiInput, content: identifiers.join('; ') + '. Teléfono 1145678901.', identifiers });
  assert.equal(result.status, 200);
  assert.equal(result.body.meta.redactions, 62);
  const transmitted = JSON.stringify(app.state.providerCalls[0].body);
  assert.doesNotMatch(transmitted, /ÁB|Inicial\d|1145678901/);
});

test('IA rechaza explícitamente más de 500 identificadores en vez de descartar algunos', async () => {
  const app = edge('ai');
  const result = await app.request({ ...aiInput, identifiers: Array.from({ length: 501 }, (_, index) => 'Inicial' + index) });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'IDENTIFIERS_LIMIT_EXCEEDED');
  assert.equal(app.state.providerCalls.length, 0);
});

test('IA rechaza bloques vacíos, tipos desconocidos e imágenes base64 inválidas', async () => {
  for (const content of ['', [{ t: 'other', text: 'dato' }], [{ t: 'img', mime: 'image/png', data: 'not base64!' }]]) {
    const app = edge('ai');
    const result = await app.request({ ...aiInput, content, images_confirmed_deidentified: true });
    assert.equal(result.status, 400);
    assert.equal(app.state.providerCalls.length, 0);
    assert.equal(app.state.audits.length, 0);
  }
});

test('IA no devuelve mensajes externos con datos sensibles y audita el fallo', async () => {
  const app = edge('ai', { respond: call => call.url.host === 'api.openai.com' ? reply({ error: { message: 'Payload rejected: PRIVATE INPUT 12345678' } }, 400) : undefined });
  const result = await app.request(aiInput);
  assert.equal(result.status, 502);
  assert.equal(result.body.error, 'AI_PROVIDER_FAILED');
  assert.doesNotMatch(JSON.stringify(result.body) + JSON.stringify(app.state.audits), /PRIVATE INPUT|12345678/);
  assert.equal(app.state.audits[1].accion, 'generacion_fallida');
});

test('IA expone límite de cuota y tiempo de espera con estados recuperables', async () => {
  const rateLimited = edge('ai', { respond: call => call.url.host === 'api.openai.com' ? reply({}, 429) : undefined });
  assert.equal((await rateLimited.request(aiInput)).status, 429);
  const timedOut = edge('ai', { respond: call => {
    if (call.url.host === 'api.openai.com') throw new DOMException('fixture timeout', 'TimeoutError');
  } });
  const result = await timedOut.request(aiInput);
  assert.equal(result.status, 504);
  assert.equal(result.body.error, 'AI_TIMEOUT');
});

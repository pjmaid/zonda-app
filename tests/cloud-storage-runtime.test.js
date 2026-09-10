const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const tableSource = html.slice(html.indexOf('const KIND_TABLE ='), html.indexOf('/* ================= USUARIOS'));
const storageSource = html.slice(html.indexOf('function cloneData('), html.indexOf('/* ================= SEGURIDAD'));
const json = value => JSON.parse(JSON.stringify(value));
const reply = (body, status = 200) => new Response(JSON.stringify(body), {status});
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
};

function app(fetch) {
  const ctx = vm.createContext({
    CFG: {supaUrl: 'https://example.supabase.co', supaKey: 'public-test-key'},
    SESSION: {access_token: 'old-access', refresh_token: 'old-refresh', email: 'test@example.invalid'},
    window: {ZONDA_RUNTIME_CONFIG: {environment: 'test'}},
    DB: {studies: [], patients: [], visits: [], docs: [], users: [], records: [], checklists: [], settings: []},
    LS: {SES: 'session'}, saved: [], status: [],
    saveJSON(key, value) { ctx.saved.push(json(value)); },
    syncStatus(...args) { ctx.status.push(args); },
    uid: () => 'test-event', fetch, URLSearchParams
  });
  vm.runInContext(tableSource + storageSource + '\nthis.store = Store; this.refresh = supaRefresh; this.request = supaFetch;', ctx);
  ctx.store.resetMeta();
  return ctx;
}

test('carga todos los registros aunque el servidor limite cada respuesta', async () => {
  const rows = Array.from({length: 1205}, (_, i) => ({
    id: 'r' + String(i).padStart(5, '0'), rev: i + 1,
    data: {id: 'r' + String(i).padStart(5, '0'), detalle: 'Ficticio ' + i}, updated_at: '2026-09-10T10:00:00Z'
  }));
  let calls = 0;
  const ctx = app(async url => {
    if (!url.includes('/ec_records?')) return reply([]);
    assert.ok(++calls < 10, 'La paginación debe avanzar y terminar.');
    const params = new URL(url).searchParams;
    const after = params.get('id');
    // PostgREST conserva literalmente el valor de un filtro simple gt.
    // No interpreta como JSON ni retira comillas (pSingleVal en QueryParams.hs).
    const cursor = after ? after.slice(3) : '';
    return reply(rows.filter(row => row.id > cursor).slice(0, 400));
  });
  await ctx.store.loadAll();
  assert.equal(ctx.DB.records.length, 1205);
  assert.equal(new Set(ctx.DB.records.map(row => row.id)).size, 1205);
  assert.equal(ctx.store.revisions.records.get('r01204'), 1205);
  assert.equal(ctx.store.snapshots.records.get('r01204').detalle, 'Ficticio 1204');
});

test('el ingreso termina la carga cuando el estudio tiene un ID UUID', async () => {
  const id = 'c99ca55a-65e1-459c-ac15-cfa6b7bbd015';
  let pages = 0;
  const ctx = app(async url => {
    if (!url.includes('/ec_studies?')) return reply([]);
    pages++;
    const filter = new URL(url).searchParams.get('id');
    // Modelo del valor escalar que recibe PostgreSQL: las comillas, si las
    // hubiera, forman parte del valor. Eso repetía la primera página.
    const cursor = filter ? filter.slice(3) : '';
    return reply(id > cursor ? [{id, data: {id, nombre: 'Estudio ficticio'}, rev: 1}] : []);
  });
  await ctx.store.loadAll();
  assert.equal(ctx.DB.studies.length, 1);
  assert.equal(pages, 2);
});

test('el cursor conserva caracteres especiales sin agregar delimitadores al ID', async () => {
  const id = 'config:uno.dos&x=(tres),"cuatro"\\cinco';
  let pages = 0;
  const ctx = app(async url => {
    if (!url.includes('/ec_settings?')) return reply([]);
    const params = new URL(url).searchParams;
    if (++pages === 1) return reply([{id, data: {id}, rev: 1}]);
    assert.equal(params.get('id'), 'gt.' + id);
    assert.equal(params.has('x'), false);
    return reply([]);
  });
  await ctx.store.loadAll();
  assert.equal(ctx.DB.settings[0].id, id);
});

test('una carga fallida conserva los datos y revisiones confirmados juntos', async () => {
  const ctx = app(async url => url.includes('/ec_patients?') ? reply({}, 503) : reply([]));
  const previous = {id: 's1', nombre: 'Confirmado'};
  ctx.DB.studies.push(previous);
  ctx.store.revisions.studies.set('s1', 7);
  ctx.store.snapshots.studies.set('s1', json(previous));
  await assert.rejects(ctx.store.loadAll(), /Error al leer/);
  assert.equal(ctx.DB.studies[0].nombre, 'Confirmado');
  assert.equal(ctx.store.revisions.studies.get('s1'), 7);
  assert.equal(ctx.store.snapshots.studies.get('s1').nombre, 'Confirmado');
});

test('guardar confirma solamente el contenido enviado aunque el formulario cambie', async () => {
  const network = deferred();
  let sent;
  const ctx = app(async (_url, opts) => {
    sent = JSON.parse(opts.body);
    return network.promise;
  });
  const draft = {id: 'p1', criterios: {i0: 'si'}};
  const pending = ctx.store.upsert('patients', draft);
  draft.criterios.i0 = 'no';
  network.resolve(reply({rev: 1, event_id: 'test-event'}));
  await pending;
  assert.equal(sent.p_data.criterios.i0, 'si');
  assert.equal(ctx.DB.patients[0].criterios.i0, 'si');
  draft.criterios.i0 = 'pendiente';
  assert.equal(ctx.store.snapshots.patients.get('p1').criterios.i0, 'si');
  assert.equal(ctx.DB.patients[0].criterios.i0, 'si');
});

test('el reintento conserva exactamente el cuerpo y el identificador del evento', async () => {
  const payload = {p_event_id: 'same-event', p_data: {detalle: 'Enviado'}};
  const bodies = [];
  const ctx = app(async (_url, opts) => {
    bodies.push(opts.body);
    if (bodies.length === 1) {
      payload.p_data.detalle = 'Cambio posterior';
      throw new Error('Respuesta perdida');
    }
    return reply({rev: 1, event_id: 'same-event'});
  });
  await ctx.store.rpc('ec_save_record', payload);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1], bodies[0]);
});

test('una respuesta repetida recarga el contenido vigente junto con su revisión', async () => {
  const latest = {id: 'p1', criterios: {i0: 'Modificado por otro usuario'}};
  const ctx = app(async url => url.includes('/rpc/')
    ? reply({rev: 3, event_id: 'test-event', replayed: true})
    : reply([{id: 'p1', rev: 3, data: latest}]));
  ctx.store.revisions.patients.set('p1', 1);
  await ctx.store.upsert('patients', {id: 'p1', criterios: {i0: 'Edición anterior'}});
  assert.equal(ctx.store.revisions.patients.get('p1'), 3);
  assert.equal(ctx.store.snapshots.patients.get('p1').criterios.i0, latest.criterios.i0);
  assert.equal(ctx.DB.patients[0].criterios.i0, latest.criterios.i0);
});

test('las renovaciones simultáneas comparten una única solicitud', async () => {
  const network = deferred();
  let requests = 0;
  const ctx = app(async () => { requests++; return (await network.promise).clone(); });
  const first = ctx.refresh(), second = ctx.refresh();
  network.resolve(reply({access_token: 'new-access', refresh_token: 'new-refresh'}));
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(requests, 1);
  assert.equal(ctx.SESSION.access_token, 'new-access');
});

test('una renovación pendiente no reemplaza una cuenta que acaba de ingresar', async () => {
  const network = deferred();
  const ctx = app(async () => network.promise);
  const pending = ctx.refresh();
  const other = {access_token: 'other-access', refresh_token: 'other-refresh', email: 'other@example.invalid'};
  ctx.SESSION = other;
  network.resolve(reply({access_token: 'new-access', refresh_token: 'new-refresh', user: {email: 'test@example.invalid'}}));
  assert.equal(await pending, false);
  assert.equal(ctx.SESSION, other);
  assert.equal(ctx.saved.length, 0);
});

test('una solicitud de la cuenta anterior no se reintenta con la cuenta nueva', async () => {
  const network = deferred();
  let requests = 0;
  const ctx = app(async () => {
    requests++;
    return requests === 1 ? network.promise : reply({access_token: 'new', refresh_token: 'new'});
  });
  const pending = ctx.request('/rest/v1/rpc/ec_save_record', {method: 'POST', body: '{}'});
  ctx.SESSION = {access_token: 'other-access', refresh_token: 'other-refresh'};
  network.resolve(reply({}, 401));
  await assert.rejects(pending, /La sesión cambió/);
  assert.equal(requests, 1);
});

test('una renovación que termina después de salir no restablece la sesión', async () => {
  const network = deferred();
  const ctx = app(async () => network.promise);
  const pending = ctx.refresh();
  ctx.SESSION = null;
  network.resolve(reply({access_token: 'new-access', refresh_token: 'new-refresh'}));
  assert.equal(await pending, false);
  assert.equal(ctx.SESSION, null);
  assert.equal(ctx.saved.length, 0);
});

test('no reintenta una escritura de la sesión anterior tras un fallo de red', async () => {
  let requests = 0;
  const ctx = app(async () => {
    requests++;
    ctx.SESSION = {access_token: 'other-access', refresh_token: 'other-refresh'};
    throw new Error('Red interrumpida');
  });
  await assert.rejects(ctx.store.upsert('patients', {id: 'p1'}), /La sesión cambió/);
  assert.equal(requests, 1);
  assert.equal(ctx.DB.patients.length, 0);
});

test('el guardado sigue bloqueado si el entorno no está declarado', async () => {
  const ctx = app(async () => { throw new Error('No debe contactar al servidor'); });
  for (const environment of [undefined, '', 'unconfigured', 'invalid']) {
    ctx.window.ZONDA_RUNTIME_CONFIG = {environment};
    await assert.rejects(ctx.store.upsert('patients', {id: 'p1'}), /El entorno no está configurado/);
    await assert.rejects(ctx.store.remove('patients', 'p1'), /El entorno no está configurado/);
  }
});

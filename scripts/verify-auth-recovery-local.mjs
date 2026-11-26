/* Auth real + captura SMTP local + funciones de acceso de index.html.
 * Solo loopback y usuarios sintéticos. Nunca imprime claves, tokens ni correos.
 * Módulo para un supervisor: crear capturador, aplicar authEnv antes de iniciar
 * Auth, ejecutar run(testEnv) sobre Auth local vacío y cerrar el capturador.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { validateTestConfig } from './verify-supabase-integration.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function startLocalAuthMailCapture({port = 55525, authUrl = 'http://127.0.0.1:59999', appUrl = 'http://127.0.0.1:55526/zonda/'} = {}) {
  const external = new URL(authUrl).origin;
  assert.equal(new URL(external).hostname, '127.0.0.1', 'Auth debe usar loopback.');
  assert.equal(new URL(appUrl).hostname, '127.0.0.1', 'El callback debe usar loopback.');
  assert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
  let keys, log = () => {};
  const sockets = new Set();
const created = [];
const messages = [];
const checks = [];
const report = { startedAt: new Date().toISOString(), passed: false, runtime: 'Official Auth 2.198.0 + PostgreSQL 17.12, loopback only', checks, cleanup: [], limitations: ['SMTP público y entrega al destinatario real no evaluados', 'No usa la cuenta ni la clave de Pablo', 'Las funciones reales del cliente corren en un DOM de prueba; no es una sesión de navegador'], };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let activeStage = 'Inicializar servicios locales';
const check = label => { checks.push({ label, status: 'passed' }); log('OK: ' + label); };
async function ready(probe) {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    try { if (await probe()) return; } catch {}
    await delay(150);
  }
  throw new Error('El servicio local no inició en 30 segundos.');
}
function localUrl(value) {
  const url = new URL(value);
  assert.equal(url.origin, external, 'Destino de Auth no local.');
  return url;
}
async function api(route, { method = 'GET', body, token = keys.SERVICE_KEY } = {}) {
  assert.ok(route.startsWith('/') && !route.startsWith('//'));
  const response = await fetch(external + route, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  return { response, body: await response.json().catch(() => ({})) };
}
function client(url = appUrl) {
  // Reutiliza el DOM de prueba existente, pero cada solicitud va a Auth real.
  // No ejecuta los test() del archivo ni conserva las contraseñas de prueba.
  const fixturePath = path.join(root, 'tests/auth-runtime.test.js');
  const fixture = fs.readFileSync(fixturePath, 'utf8').split("test('recuperación transmite")[0];
  assert.ok(fixture.includes('function app(fetch,'), 'Fixture de cliente no reconocido.');
  const createApp = new Function('require', '__dirname', fixture + '\nreturn app;')(createRequire(fixturePath), path.dirname(fixturePath));
  const requestEvidence=[];
  const localFetch=async (value, opts = {}) => {
    const target = new URL(value);
    assert.equal(target.origin, external, 'Solicitud de cliente fuera de loopback.');
    assert.ok(target.pathname.startsWith('/auth/v1/'));
    target.pathname = target.pathname.slice('/auth/v1'.length);
    const response=await fetch(target, opts);
    if(target.pathname==='/user' && opts.method==='PUT'){
      const requestBody=JSON.parse(opts.body||'{}');
      const responseBody=await response.clone().json().catch(()=>({}));
      requestEvidence.push({method:'PUT',path:'/user',hasPassword:Object.hasOwn(requestBody,'password'),
        clearsTemporaryFlag:requestBody.data?.clave_temporal===false,status:response.status,
        errorCode:responseBody.error_code||null});
    }
    return response;
  };
  const ctx = createApp(localFetch,url);
  ctx.CFG.supaKey = keys.ANON_KEY;
  ctx.supaBase = () => external;
  ctx.supaFetch=(route,options={})=>localFetch(external+route,{...options,headers:{
    apikey:keys.ANON_KEY,'Content-Type':'application/json',Authorization:'Bearer '+ctx.SESSION.access_token,...options.headers,
  }});
  ctx.jwtSub=()=>JSON.parse(Buffer.from(ctx.SESSION.access_token.split('.')[1],'base64url').toString()).sub;
  ctx.entered = 0;
  ctx.enterApp = async () => { ctx.entered++; };
  ctx.authRequestEvidence=requestEvidence;
  return ctx;
}
async function smtpCapture() {
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    socket.write('220 localhost synthetic SMTP\r\n');
    let buffer = '', data = false, lines = [], recipient = '';
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 2 * 1024 * 1024) { socket.destroy(); return; }
      let index;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        if (data) {
          if (line === '.') { messages.push({ recipient, body: lines.join('\r\n') }); data = false; lines = []; socket.write('250 captured locally\r\n'); }
          else lines.push(line.replace(/^\.\./, '.'));
        } else if (/^(EHLO|HELO) /i.test(line)) socket.write('250-localhost\r\n250 8BITMIME\r\n');
        else if (/^MAIL FROM:/i.test(line)) socket.write('250 OK\r\n');
        else if (/^RCPT TO:/i.test(line)) { recipient = line.replace(/^RCPT TO:\s*</i, '').replace(/>.*$/, ''); socket.write('250 OK\r\n'); }
        else if (line === 'DATA') { data = true; socket.write('354 End with dot\r\n'); }
        else if (line === 'QUIT') { socket.end('221 Bye\r\n'); }
        else if (/^(RSET|NOOP)/i.test(line)) socket.write('250 OK\r\n');
        else socket.write('502 Unsupported\r\n');
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}
async function verificationLink(email, type) {
  await ready(() => messages.some(message => message.recipient.toLowerCase() === email));
  const message = messages.findLast(message => message.recipient.toLowerCase() === email);
  const decoded = message.body.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/&amp;/g, '&');
  const links = [...decoded.matchAll(/https?:\/\/[^\s<>"']+/g)].map(match => match[0]);
  const value = links.find(link => { try { const u = new URL(link); return u.pathname === '/verify' && u.searchParams.get('type') === type; } catch { return false; } });
  assert.ok(value, 'El correo no contiene el enlace esperado.');
  return localUrl(value);
}
async function callback(link, type) {
  const response = await fetch(localUrl(link), { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 303, 'Verificación Auth no redirigió.');
  const target = new URL(response.headers.get('location'));
  assert.equal(target.origin + target.pathname, appUrl, 'No respetó redirect_to.');
  const fragment = new URLSearchParams(target.hash.slice(1));
  assert.equal(fragment.get('type'), type, 'Tipo de enlace incorrecto.');
  assert.ok(fragment.get('access_token'), 'Auth no devolvió sesión.');
  return target;
}
async function setPassword(url, email, password) {
  const ctx = client(String(url));
  assert.equal(await ctx.auth.consume(), true);
  assert.equal(ctx.location.hash, '');
  assert.equal(ctx.element('loginUser').value, email);
  assert.equal(ctx.element('recoveryBox').classList.contains('hidden'), false);
  assert.equal([...password].length,10,'La clave de recuperación sintética debe probar el límite de diez caracteres.');
  ctx.element('recoveryPass').value = password.slice(0,9);
  ctx.element('recoveryPass2').value = password.slice(0,9);
  await ctx.click('btnRecoverySave');
  assert.ok(ctx.auth.getRecoveryToken(),'El rechazo de nueve caracteres debe conservar la sesión de recuperación.');
  assert.match(ctx.element('recoveryMsg').textContent,/10/,'El cliente no explicó el mínimo de diez caracteres.');
  ctx.element('recoveryPass').value = password;
  ctx.element('recoveryPass2').value = password;
  await ctx.click('btnRecoverySave');
  assert.equal(ctx.auth.getRecoveryToken(), '');
  assert.equal(ctx.element('recoveryPass').value, '');
  assert.equal(ctx.element('recoveryPass2').value, '');
  assert.match(ctx.element('loginMsg').textContent, /Clave confirmada/);
  ctx.element('loginUser').value = email;
  ctx.element('loginPass').value = password;
  await ctx.auth.login();
  assert.equal(ctx.entered, 1, 'El cliente no completó el acceso con la nueva clave.');
  assert.equal(ctx.SESSION.email, email);
  assert.equal(ctx.SESSION.claveTemp, false);
  assert.equal(ctx.element('loginPass').value, '');
  return ctx;
}
async function confirmOwnPassword(session,email,password){
  const ctx=client();
  ctx.SESSION={access_token:session.access_token,refresh_token:session.refresh_token,email,claveTemp:true};
  ctx.CURRENT_USER=email;
  const confirmed=ctx.auth.temporary();
  ctx.element('fc_p1').value=password;ctx.element('fc_p2').value=password;
  await ctx.click('fc_ok');
  assert.equal(ctx.SESSION.claveTemp,false,'El diálogo no confirmó la clave elegida.');
  assert.equal(await confirmed,true,'El diálogo de confirmación no finalizó.');
  return ctx;
}
const smtp = await smtpCapture();
return {
  authEnv: {
    API_EXTERNAL_URL: external, GOTRUE_SITE_URL: appUrl, GOTRUE_URI_ALLOW_LIST: appUrl,
    GOTRUE_SMTP_HOST: '127.0.0.1', GOTRUE_SMTP_PORT: String(port), GOTRUE_SMTP_USER: '', GOTRUE_SMTP_PASS: '',
    GOTRUE_SMTP_ADMIN_EMAIL: 'auth@zonda.example.invalid', GOTRUE_SMTP_SENDER_NAME: 'Zonda Synthetic Test',
    GOTRUE_MAILER_URLPATHS_RECOVERY: '/verify', GOTRUE_MAILER_URLPATHS_INVITE: '/verify',
    GOTRUE_SMTP_MAX_FREQUENCY: '1s', GOTRUE_RATE_LIMIT_EMAIL_SENT: '100',
  },
  async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => smtp.close(resolve)); messages.length = 0; },
  async run(env, options = {}) {
    const config = validateTestConfig(env);
    assert.equal(config.mode, 'local', 'Esta prueba solo admite el runtime local.');
    assert.equal(checks.length, 0, 'El capturador solo puede ejecutarse una vez.');
    keys = { ANON_KEY: config.publicKey, SERVICE_KEY: config.serviceKey };
    log = options.log || (() => {});
try {
  const empty = await api('/admin/users?page=1&per_page=1');
  assert.ok(empty.response.ok && Array.isArray(empty.body.users));
  assert.equal(empty.body.users.length, 0, 'La base local tiene usuarios; no se ejecutará.');
  check('Base Auth local vacía y Auth oficial disponible');
  const suffix = randomBytes(8).toString('hex');
  const recoveryEmail = 'recovery-' + suffix + '@example.invalid';
  const inviteEmail = 'invite-' + suffix + '@example.invalid';
  const existingPendingEmail = 'pending-other-' + suffix + '@example.invalid';
  const oldPassword = 'Old!a7' + randomBytes(2).toString('hex');
  const newPassword = 'New!a7' + randomBytes(2).toString('hex');
  activeStage = 'Crear fixture local de recuperación';
  const fixture = await api('/admin/users', { method: 'POST', body: { email: recoveryEmail, password: oldPassword, email_confirm: true, user_metadata: { clave_temporal: true } } });
  assert.ok(fixture.response.ok && fixture.body.id, 'No se pudo crear el usuario sintético.');
  created.push(fixture.body.id);
  const before = await api('/token?grant_type=password', { method: 'POST', token: keys.ANON_KEY, body: { email: recoveryEmail, password: oldPassword } });
  assert.ok(before.response.ok && before.body.access_token, 'El fixture no puede ingresar antes de recuperar.');
  check('Acceso inicial con cuenta sintética confirmado');
  activeStage = 'Recuperar mediante correo local y cliente real';
  await client().auth.recover(recoveryEmail);
  const recoveryLink = await verificationLink(recoveryEmail, 'recovery');
  check('Solicitud real de recuperación entregada al capturador SMTP local');
  const recoveryCallback = await callback(recoveryLink, 'recovery');
  check('Enlace de recuperación respeta el destino solicitado');
  const recoveredClient=await setPassword(recoveryCallback, recoveryEmail, newPassword);
  check('Cliente rechaza nueve caracteres, acepta diez, limpia URL y permite ingresar con la nueva clave');
  const after = await api('/token?grant_type=password', { method: 'POST', token: keys.ANON_KEY, body: { email: recoveryEmail, password: oldPassword } });
  assert.equal(after.response.status, 400);
  assert.equal(after.body.error_code, 'invalid_credentials');
  check('La clave anterior queda invalidada');
  const metadata = await api('/admin/users/' + fixture.body.id);
  assert.equal(metadata.body.user_metadata.clave_temporal, false);
  check('El cambio de clave elimina el indicador temporal en Auth real');
  const replay = await fetch(recoveryLink, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  const replayUrl = new URL(replay.headers.get('location'));
  assert.equal(replayUrl.origin + replayUrl.pathname, appUrl);
  assert.ok(new URLSearchParams(replayUrl.hash.slice(1)).has('error'));
  const replayClient = client(String(replayUrl));
  await replayClient.auth.consume();
  assert.equal(replayClient.auth.getRecoveryToken(), '');
  assert.equal(replayClient.location.hash, '');
  check('Un enlace ya utilizado se rechaza y no deja tokens en la URL');
  activeStage = 'Reutilizar una contraseña anterior válida desde el cliente real';
  const reuse=await confirmOwnPassword(recoveredClient.SESSION,recoveryEmail,oldPassword);
  assert.deepEqual(reuse.authRequestEvidence.map(x=>({status:x.status,hasPassword:x.hasPassword})),[{status:200,hasPassword:true}]);
  const reusedLogin=await api('/token?grant_type=password',{method:'POST',token:keys.ANON_KEY,body:{email:recoveryEmail,password:oldPassword}});
  assert.ok(reusedLogin.response.ok && reusedLogin.body.access_token,'La contraseña anterior reutilizada no permite ingresar.');
  assert.equal(reusedLogin.body.user.user_metadata.clave_temporal,false);
  const superseded=await api('/token?grant_type=password',{method:'POST',token:keys.ANON_KEY,body:{email:recoveryEmail,password:newPassword}});
  assert.equal(superseded.response.status,400);assert.equal(superseded.body.error_code,'invalid_credentials');
  check('El cliente reutiliza una contraseña anterior válida de diez caracteres e inicia sesión');
  activeStage = 'Confirmar la contraseña actual sin exigir una distinta';
  const markTemporary=await api('/admin/users/'+fixture.body.id,{method:'PUT',body:{user_metadata:{clave_temporal:true}}});
  assert.ok(markTemporary.response.ok);
  const same=await api('/user',{method:'PUT',token:reusedLogin.body.access_token,body:{password:oldPassword,data:{clave_temporal:false}}});
  assert.equal(same.response.status,422);assert.equal(same.body.error_code,'same_password');
  const beforeConfirmation=await api('/admin/users/'+fixture.body.id);
  assert.equal(beforeConfirmation.body.user_metadata.clave_temporal,true,'same_password limpió el indicador antes de la confirmación de metadatos.');
  check('Auth real devuelve 422 same_password al volver a enviar la contraseña actual');
  const current=await confirmOwnPassword(reusedLogin.body,recoveryEmail,oldPassword);
  assert.deepEqual(current.authRequestEvidence.map(x=>({status:x.status,hasPassword:x.hasPassword,clearsTemporaryFlag:x.clearsTemporaryFlag,errorCode:x.errorCode})),[
    {status:422,hasPassword:true,clearsTemporaryFlag:true,errorCode:'same_password'},
    {status:200,hasPassword:false,clearsTemporaryFlag:true,errorCode:null},
  ]);
  const confirmedLogin=await api('/token?grant_type=password',{method:'POST',token:keys.ANON_KEY,body:{email:recoveryEmail,password:oldPassword}});
  assert.ok(confirmedLogin.response.ok);assert.equal(confirmedLogin.body.user.user_metadata.clave_temporal,false);
  check('El cliente confirma la contraseña actual mediante metadatos, conserva el acceso y elimina el indicador temporal');
  activeStage = 'Proteger una cuenta pendiente preexistente al crear usuarios';
  const pending = await api('/admin/users', { method:'POST',body:{email:existingPendingEmail,email_confirm:false,
    user_metadata:{fixture_origin:'other-synthetic-site',preserve_marker:suffix}} });
  assert.ok(pending.response.ok && pending.body.id,'No se pudo crear la cuenta pendiente sintética.');
  created.push(pending.body.id);
  assert.ok(!pending.body.email_confirmed_at,'La cuenta pendiente ya estaba confirmada.');
  const pendingBefore = await api('/admin/users/'+pending.body.id);
  assert.ok(pendingBefore.response.ok);
  const duplicate = await api('/admin/users',{method:'POST',body:{email:existingPendingEmail,email_confirm:false,
    user_metadata:{fixture_origin:'attempted-overwrite',preserve_marker:'changed'}}});
  if(duplicate.response.ok && duplicate.body.id && !created.includes(duplicate.body.id))created.push(duplicate.body.id);
  assert.ok([400,422].includes(duplicate.response.status),'El alta duplicada de una cuenta pendiente no fue rechazada.');
  assert.equal(duplicate.body.error_code,'email_exists','El rechazo no identifica un email preexistente.');
  const pendingAfter = await api('/admin/users/'+pending.body.id);
  assert.ok(pendingAfter.response.ok,'La cuenta pendiente desapareció después del alta rechazada.');
  const preservedFields = user => Object.fromEntries(['id','email','created_at','updated_at','email_confirmed_at',
    'invited_at','app_metadata','user_metadata','identities'].map(key=>[key,user[key]]));
  assert.deepEqual(preservedFields(pendingAfter.body),preservedFields(pendingBefore.body),
    'El alta duplicada cambió la identidad o metadatos de la cuenta pendiente preexistente.');
  assert.equal(messages.length,1,'Un alta administrativa o duplicado envió correo inesperado.');
  check('Auth rechaza admin-create duplicado y conserva identidad y metadatos de la cuenta pendiente preexistente');
  activeStage = 'Crear cuenta nueva antes de invitar y verificar la misma identidad';
  const newPending = await api('/admin/users',{method:'POST',body:{email:inviteEmail,email_confirm:false,
    user_metadata:{clave_temporal:true,fixture_origin:'safe-admin-create'}}});
  assert.ok(newPending.response.ok && newPending.body.id,'No se pudo reservar una cuenta nueva antes de invitar.');
  assert.notEqual(newPending.body.id,pending.body.id);
  assert.ok(!newPending.body.email_confirmed_at,'La cuenta nueva no quedó pendiente de activación.');
  created.push(newPending.body.id);
  assert.equal(messages.length,1,'Crear la cuenta nueva envió correo antes de la invitación.');
  const invitation = await api('/invite?redirect_to=' + encodeURIComponent(appUrl), { method: 'POST', body: { email: inviteEmail, data: { clave_temporal: true } } });
  assert.ok(invitation.response.ok && invitation.body.id, 'No se pudo invitar el usuario sintético.');
  if(!created.includes(invitation.body.id))created.push(invitation.body.id);
  assert.equal(invitation.body.id,newPending.body.id,'Invitar no conservó el ID creado previamente por la API administrativa.');
  check('Admin-create sin contraseña reserva una identidad nueva y la invitación reutiliza exactamente ese ID');
  const inviteLink = await verificationLink(inviteEmail, 'invite');
  check('Invitación real entregada al capturador SMTP local');
  await setPassword(await callback(inviteLink, 'invite'), inviteEmail, 'Inv!a7' + randomBytes(2).toString('hex'));
  check('Cliente activa la invitación y permite ingresar con la clave elegida');
  activeStage = 'Recuperar una cuenta pendiente sin contraseña ni invitación previa';
  const neverInvited = await api('/admin/users/'+pending.body.id);
  assert.ok(neverInvited.response.ok && !neverInvited.body.email_confirmed_at && !neverInvited.body.invited_at,
    'El fixture pendiente fue activado o invitado antes de probar su recuperación.');
  await client().auth.recover(existingPendingEmail);
  const pendingRecoveryLink = await verificationLink(existingPendingEmail,'recovery');
  await setPassword(await callback(pendingRecoveryLink,'recovery'),existingPendingEmail,'Pen!a7'+randomBytes(2).toString('hex'));
  const recoveredPending = await api('/admin/users/'+pending.body.id);
  assert.ok(recoveredPending.response.ok && recoveredPending.body.email_confirmed_at,
    'La recuperación no confirmó la cuenta pendiente.');
  assert.equal(recoveredPending.body.id,pending.body.id,'La recuperación cambió la identidad de la cuenta pendiente.');
  check('Una cuenta pendiente sin contraseña ni invitación puede recuperarse por correo local, elegir clave e ingresar');
  assert.equal(messages.length, 3);
  check('Solo se capturaron tres correos sintéticos, sin SMTP externo');
  report.passed = true;
} catch (error) {
  // AssertionError puede incluir tokens/contraseñas. Reportar etapa, nunca sus valores.
  report.error = 'Falló la etapa: ' + activeStage;
  log(report.error);
} finally {
  for (const id of created.reverse()) {
    try { const result = await api('/admin/users/' + id, { method: 'DELETE' }); assert.ok(result.response.ok); report.cleanup.push({ target: 'synthetic Auth user', status: 'passed' }); }
    catch { report.cleanup.push({ target: 'synthetic Auth user', status: 'failed' }); report.passed = false; }
  }
  try {
    const empty = await api('/admin/users?page=1&per_page=1');
    assert.ok(empty.response.ok && Array.isArray(empty.body.users));
    assert.equal(empty.body.users.length, 0);
    report.cleanup.push({ target: 'local Auth users empty', status: 'passed' });
  } catch { report.cleanup.push({ target: 'local Auth users empty', status: 'failed' }); report.passed = false; }
  messages.length = 0;
  report.finishedAt = new Date().toISOString();
}
return report;
  },
};
}

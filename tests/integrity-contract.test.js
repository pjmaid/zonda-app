const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260809_integridad_concurrencia_auditoria.sql'),
  'utf8'
);
const sharedMigration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260810_registros_checklists_compartidos.sql'),
  'utf8'
);
const permissionsMigration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260810_configuracion_permisos_por_protocolo.sql'),
  'utf8'
);
const aiFunction = fs.readFileSync(
  path.join(root, 'supabase/functions/ia/index.ts'),
  'utf8'
);

test('el JavaScript embebido conserva sintaxis válida', () => {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .filter(script => script.trim());
  assert.ok(scripts.length > 0);
  for (const script of scripts) assert.doesNotThrow(() => new Function(script));
});

test('los controles de calidad se cargan antes de la aplicación y quedan trazados', () => {
  assert.match(html, /<script src="quality-rules\.js"><\/script>/);
  assert.match(html, /qualityGate\(qualityIssues,'guardar la visita'\)/);
  assert.match(html, /qualityGate\(qualityIssues,'guardar el registro'\)/);
  assert.match(html, /controlCalidad=qualityStamp\(qualityIssues\)/);
});

test('las escrituras de entidades pasan por las RPC transaccionales', () => {
  assert.match(html, /rpc\('ec_save_record'/);
  assert.match(html, /rpc\('ec_remove_record'/);
  assert.doesNotMatch(html, /resolution=merge-duplicates,return=minimal/);
  assert.doesNotMatch(html, /updated_at:new Date\(\)\.toISOString\(\)/);
});

test('la auditoría local no se trunca ni ignora errores', () => {
  assert.doesNotMatch(html, /AUDIT\.slice\(-5000\)/);
  assert.match(html, /La auditoría quedó pendiente de sincronización/);
  assert.match(html, /event_id:ev\.id/);
});

test('la migración agrega revisión y hace escritura más auditoría en una transacción', () => {
  assert.match(migration, /add column if not exists rev bigint not null default 1/i);
  assert.match(migration, /create or replace function ec_save_record/i);
  assert.match(migration, /rev = rev \+ 1/i);
  assert.match(migration, /message = 'VERSION_CONFLICT'/);
  assert.match(migration, /insert into ec_audit\(event_id/i);
  assert.match(migration, /ec_audit_org_event_idx/i);
  assert.match(migration, /'replayed', true/i);
});

test('registros y checklists se cargan desde tablas compartidas', () => {
  assert.match(html, /records:'ec_records'/);
  assert.match(html, /checklists:'ec_checklists'/);
  assert.match(html, /records:out\.records\|\|\[\]/);
  assert.match(html, /checklists:out\.checklists\|\|\[\]/);
  assert.doesNotMatch(html, /saveJSON\('ecx_logs',/);
  assert.doesNotMatch(html, /saveJSON\('ecx_chk',/);
  assert.doesNotMatch(html, /function logsSave/);
});

test('todos los guardados de módulos compartidos esperan confirmación del servidor', () => {
  assert.match(html, /await Store\.upsert\('records'/);
  assert.match(html, /await Store\.remove\('records'/);
  assert.match(html, /await Store\.upsert\('checklists'/);
  assert.match(html, /if\(!await guardarLog\(LOG_TIPO, obj/);
  assert.match(html, /await guardarChecklist\(k/);
});

test('la migración compartida crea índices, RLS y amplía las RPC', () => {
  assert.match(sharedMigration, /create table if not exists ec_records/i);
  assert.match(sharedMigration, /create table if not exists ec_checklists/i);
  assert.match(sharedMigration, /record_type text generated always/i);
  assert.match(sharedMigration, /alter table ec_records enable row level security/i);
  assert.match(sharedMigration, /when 'records' then 'ec_records'/i);
  assert.match(sharedMigration, /when 'checklists' then 'ec_checklists'/i);
  assert.match(sharedMigration, /rev = rev \+ 1/i);
  assert.match(sharedMigration, /insert into ec_audit\(event_id/i);
});

test('la migración del navegador conserva respaldo y no pisa conflictos', () => {
  assert.match(html, /ecx_logs_respaldo_pre_migracion/);
  assert.match(html, /ecx_chk_respaldo_pre_migracion/);
  assert.match(html, /conflictosLogs/);
  assert.match(html, /se conservará la versión de la nube/);
});

test('las configuraciones operativas se comparten y no se escriben en localStorage', () => {
  assert.match(html, /settings:'ec_settings'/);
  assert.match(html, /settings:out\.settings\|\|\[\]/);
  assert.match(html, /await Store\.upsert\('settings'/);
  assert.match(html, /await Store\.remove\('settings'/);
  assert.match(html, /function hidratarConfiguracionCompartida/);
  assert.doesNotMatch(html, /saveJSON\('ecx_procclasif'/);
  assert.doesNotMatch(html, /saveJSON\('ecx_labextra'/);
  assert.doesNotMatch(html, /saveJSON\('ecx_tabletclasif'/);
});

test('la migración de configuraciones conserva respaldo y conflictos', () => {
  assert.match(html, /ecx_settings_respaldo_pre_migracion/);
  assert.match(html, /ecx_legacy_settings_migrated_/);
  assert.match(html, /migrarConfiguracionCompartidaLegacy/);
  assert.match(html, /se conservará la versión de la nube/);
});

test('RLS limita datos y archivos a los protocolos asignados', () => {
  assert.match(permissionsMigration, /create table if not exists ec_settings/i);
  assert.match(permissionsMigration, /create or replace function ec_user_study_ids/i);
  assert.match(permissionsMigration, /create or replace function ec_can_study/i);
  assert.match(permissionsMigration, /ec_can_study\(ec_data_study\(data\)\)/i);
  assert.match(permissionsMigration, /current_rol\(\) in \([^\n]*admin[^\n]*medico[^\n]*coord[^\n]*\)/i);
  assert.match(permissionsMigration, /create policy users_ver/i);
  assert.match(permissionsMigration, /create policy ec_docs_protocol/i);
  assert.match(permissionsMigration, /when 'settings' then 'ec_settings'/i);
  assert.match(html, /doc\.path = stId\+'\/'\+doc\.id/);
  assert.match(html, /doc\.path = paciente\.estudioId\+'\/'\+doc\.id/);
});

test('crear protocolos queda reservado al administrador en la interfaz', () => {
  assert.match(html, /estudiosCrear:true/);
  assert.match(html, /medico:\s*\{[^}]*estudiosCrear:false/s);
  assert.match(html, /btnNewStudy[^\n]*!can\('estudiosCrear'\)/);
  assert.match(html, /btnDemoStudy[^\n]*!can\('estudiosCrear'\)/);
});

test('la IA no expone claves ni llama proveedores desde el navegador', () => {
  assert.match(html, /\/functions\/v1\/ia/);
  assert.doesNotMatch(html, /https:\/\/api\.openai\.com/);
  assert.doesNotMatch(html, /https:\/\/api\.anthropic\.com/);
  assert.doesNotMatch(html, /https:\/\/generativelanguage\.googleapis\.com/);
  assert.doesNotMatch(html, /CFG\.aiKey\s*=/);
  assert.doesNotMatch(html, /id="cfgAiKey"/);
  assert.match(html, /delete CFG\.aiKey/);
});

test('cada uso de aiChat declara su finalidad para la auditoría', () => {
  const calls = [...html.matchAll(/await aiChat\(\{([\s\S]*?)\n\s*\}\)/g)];
  assert.equal(calls.length, 12);
  for (const call of calls) assert.match(call[1], /purpose\s*:/);
});

test('la Edge Function autentica, anonimiza y audita antes de devolver la salida', () => {
  assert.match(aiFunction, /\/auth\/v1\/user/);
  assert.match(aiFunction, /ec_members\?select=/);
  assert.match(aiFunction, /DNI\|CUIL\|CUIT/);
  assert.match(aiFunction, /EMAIL OMITIDO/);
  assert.match(aiFunction, /IMAGE_DEIDENTIFICATION_CONFIRMATION_REQUIRED/);
  assert.match(aiFunction, /await appendAudit\(auth, requestId/);
  assert.match(aiFunction, /human_review_required: true/);
  assert.match(aiFunction, /Borrador generado con asistencia de IA/);
});

test('las salidas visibles y exportables identifican el borrador asistido', () => {
  assert.match(html, /Borrador generado con asistencia de IA — requiere revisión humana/);
  assert.match(html, /BORRADOR GENERADO CON ASISTENCIA DE IA — REQUIERE REVISIÓN HUMANA/);
  assert.match(html, /m\.asistida/);
  assert.match(html, /FACT_PROP = \{\s*asistida:true/);
  assert.match(html, /AIR_RES = \{\s*asistida:true/);
});

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const rag=fs.readFileSync(path.join(root,'supabase/functions/rag/index.ts'),'utf8');
const users=fs.readFileSync(path.join(root,'supabase/functions/crear-usuario/index.ts'),'utf8');
const migration=fs.readFileSync(path.join(root,'supabase/migrations/20261113_endurecimiento_funciones_rls.sql'),'utf8');

test('la recuperación valida el enlace y permite definir una clave nueva',()=>{
  assert.match(html,/type!=='recovery'&&type!=='invite'/);
  assert.match(html,/savePersonalPassword\(p1,RECOVERY_TOKEN\)/);
  assert.match(html,/new URLSearchParams\(\{redirect_to:redirectTo\}\)/);
  assert.doesNotMatch(html,/\/auth\/v1\/signup/);
});

test('el borrado de documentos registra la baja antes de retirar bytes sin restauraciones',()=>{
  assert.match(html,/async function storageDel[\s\S]*if\(!r\.ok\)/);
  const removal=html.slice(html.indexOf('async function eliminarDocumentoSeguro('),html.indexOf('async function reintentarBajasDocumentos('));
  assert.ok(removal.indexOf("Store.remove('docs'")<removal.indexOf('retirarArchivoDadoDeBaja(doc.path)'));
  assert.doesNotMatch(removal,/storagePut|createObjectURL|document\.createElement/);
  assert.match(html,/if\(doc\.ragIndexado\|\|doc\.ragPendiente\) await ragBorrar\(doc\)/);
});

test('la depuración histórica exige administración y no transmite contenido clínico',()=>{
  assert.match(rag,/auth\.member\.rol!=="admin"/);
  assert.match(rag,/purgar_legacy/);
  assert.match(rag,/googleDeleteIfPresent\(base\+legacy\)/);
  const purge=rag.slice(rag.indexOf('async function purgeLegacyDocument'),rag.indexOf('async function storageObjects'));
  assert.doesNotMatch(purge,/texto|rawBytes|content:/);
});

test('las mutaciones de acceso fallan si no puede escribirse la auditoría',()=>{
  assert.match(users,/if \(!response\.ok\) throw new Error\("AUDIT_WRITE_FAILED"\)/);
  assert.match(users,/"alta solicitada"[\s\S]*\/auth\/v1/);
  assert.match(users,/"baja solicitada"[\s\S]*\/auth\/v1\/admin\/users/);
});

test('la migración retira ejecución anónima y separa las políticas de organizaciones',()=>{
  assert.match(migration,/revoke execute on function public\.current_org\(\) from public, anon/);
  assert.match(migration,/create policy orgs_super_insert/);
  assert.match(migration,/create policy orgs_super_update/);
  assert.match(migration,/create policy orgs_super_delete/);
});

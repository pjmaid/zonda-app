// PostgreSQL WASM local y descartable. Nunca se conecta a Supabase.
// Ejecutar con ZONDA_PGLITE_MODULE=/ruta/a/pglite/dist/index.js node tests/database-policy-runtime.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
const {PGlite} = await import(process.env.ZONDA_PGLITE_MODULE || '@electric-sql/pglite');
const root = fileURLToPath(new URL('../', import.meta.url));
const read = name => fs.readFileSync(root + 'supabase/migrations/' + name, 'utf8');
const original = read('20260810_configuracion_permisos_por_protocolo.sql');
const contracts = read('20260816_contratos_solo_facturacion.sql');
function definition(source, name) {
  const start=source.indexOf('create or replace function '+name+'(');
  assert.ok(start>=0, 'No se encontró '+name);
  const end=source.indexOf('$$;',source.indexOf('as $$',start))+3;
  return source.slice(start,end);
}
const org='00000000-0000-0000-0000-000000000001';
const otherOrg='00000000-0000-0000-0000-000000000002';
const coord='00000000-0000-0000-0000-000000000101';
const other='00000000-0000-0000-0000-000000000102';
const bound='00000000-0000-0000-0000-000000000103';
const db = new PGlite();
let passed=0;
await db.exec(`
  create role anon; create role authenticated;
  create schema auth; create schema storage;
  grant usage on schema auth,storage,public to authenticated,anon;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.test_uid',true),'')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$
    select jsonb_build_object('email',current_setting('request.test_email',true)) $$;
  create function public.current_org() returns uuid language sql stable as $$
    select nullif(current_setting('request.test_org',true),'')::uuid $$;
  create function public.current_rol() returns text language sql stable as $$
    select current_setting('request.test_role',true) $$;
  create function public.es_superadmin() returns boolean language sql stable as $$ select false $$;
  create table ec_studies(id text primary key,org_id uuid,data jsonb);
  create table ec_patients(id text primary key,org_id uuid,data jsonb);
  create table ec_users(id text primary key,org_id uuid,data jsonb);
  create table ec_docs(id text primary key,org_id uuid,data jsonb);
  create table storage.objects(name text primary key,bucket_id text,owner_id text,metadata jsonb);
  alter table storage.objects enable row level security;
  grant select,insert,update,delete on storage.objects to authenticated,anon;
`);
for(const name of ['ec_user_study_ids','ec_can_study','ec_data_study','ec_is_own_user']) await db.exec(definition(original,name));
for(const name of ['ec_can_facturacion','ec_can_document','ec_can_storage_object']) await db.exec(definition(contracts,name));
await db.exec(`create policy ec_docs_protocol on storage.objects for all to authenticated
  using (bucket_id='ec-docs' and ec_can_storage_object(name))
  with check (bucket_id='ec-docs' and ec_can_storage_object(name));`);
await db.exec(read('20261123_storage_roles_identidad.sql'));
for(const [id,site] of [['s1',org],['s2',org],['foreign',otherOrg]])
  await db.query('insert into ec_studies values ($1,$2,$3)',[id,site,JSON.stringify({id})]);
for(const [id,uid,email,estudios,facturacion] of [
  ['profile',coord,'coord@example.invalid',['s1'],false],
  ['other',other,'same@example.invalid',['s1'],false],
  ['bound',bound,'same@example.invalid',['s2'],true],
  ['legacy',null,'legacy@example.invalid',['s1'],false]
]) await db.query('insert into ec_users values ($1,$2,$3)',[id,org,JSON.stringify({authId:uid,email,estudios,facturacion,activo:true})]);
for(const [id,study,tipo,path] of [
  ['clinical','s1','protocolo','s1/clinical/file.pdf'],
  ['contract','s1','contrato','s1/contract/file.pdf'],
  ['restricted','s2','protocolo','s2/restricted/file.pdf'],
  ['legacy-doc','s1','protocolo','legacy-doc/file.pdf']
]){
  await db.query('insert into ec_docs values ($1,$2,$3)',[id,org,JSON.stringify({id,estudioId:study,tipo,path,storage:'supabase'})]);
  await db.query('insert into storage.objects values ($1,$2,$3,$4)',[org+'/'+path,'ec-docs',coord,'{}']);
}
for(const [path,owner] of [['s1/upload-own/file.pdf',coord],['s1/upload-other/file.pdf',other]])
  await db.query('insert into storage.objects values ($1,$2,$3,$4)',[org+'/'+path,'ec-docs',owner,'{}']);
async function asActor(role,run,{uid=coord,email='coord@example.invalid',site=org,databaseRole='authenticated'}={}){
  assert.ok(['authenticated','anon'].includes(databaseRole));
  await db.exec('begin; set local role '+databaseRole+';');
  try{
    for(const [key,value] of Object.entries({test_role:role,test_uid:uid,test_email:email,test_org:site}))
      await db.query('select set_config($1,$2,true)',['request.'+key,value]);
    return await run();
  }finally{ await db.exec('rollback'); }
}
async function check(name,run){ await run(); passed++; console.log('OK '+name); }
const object = path => org+'/'+path;
const count = async (sql,args=[]) => (await db.query(sql,args)).rows.length;
await check('lector puede leer y no borrar',()=>asActor('lector',async()=>{
  assert.equal(await count('select * from storage.objects where name=$1',[object('s1/clinical/file.pdf')]),1);
  assert.equal(await count('delete from storage.objects where name=$1 returning *',[object('s1/clinical/file.pdf')]),0);
  assert.equal(await count("update storage.objects set metadata='{}' where name=$1 returning *",[object('s1/clinical/file.pdf')]),0);
}));
await check('lector no puede subir',()=>asActor('lector',async()=>{
  await assert.rejects(db.query('insert into storage.objects values ($1,$2,$3,$4)',[object('s1/new/file.pdf'),'ec-docs',coord,'{}']),/row-level security/);
}));
await check('coordinadora edita pero no borra documento clínico publicado',()=>asActor('coord',async()=>{
  assert.equal(await count('insert into storage.objects values ($1,$2,$3,$4) returning *',[object('s1/new/file.pdf'),'ec-docs',coord,'{}']),1);
  assert.equal(await count("update storage.objects set metadata='{}' where name=$1 returning *",[object('s1/clinical/file.pdf')]),1);
  assert.equal(await count('delete from storage.objects where name=$1 returning *',[object('s1/clinical/file.pdf')]),0);
}));
await check('coordinadora compensa solo su carga sin ficha',()=>asActor('coord',async()=>{
  assert.equal(await count('delete from storage.objects where name=$1 returning *',[object('s1/upload-own/file.pdf')]),1);
  assert.equal(await count('delete from storage.objects where name=$1 returning *',[object('s1/upload-other/file.pdf')]),0);
}));
await check('coordinadora sin facturación no accede al contrato',()=>asActor('coord',async()=>{
  assert.equal(await count('select * from storage.objects where name=$1',[object('s1/contract/file.pdf')]),0);
  assert.equal(await count('delete from storage.objects where name=$1 returning *',[object('s1/contract/file.pdf')]),0);
}));
await db.query("update ec_users set data=jsonb_set(data,'{facturacion}','true') where id='profile'");
await check('coordinadora con facturación puede borrar contrato',()=>asActor('coord',async()=>{
  assert.equal(await count('delete from storage.objects where name=$1 returning *',[object('s1/contract/file.pdf')]),1);
}));
await check('médico borra documentos actuales e históricos de su estudio',()=>asActor('medico',async()=>{
  for(const path of ['s1/clinical/file.pdf','legacy-doc/file.pdf'])
    assert.equal(await count('delete from storage.objects where name=$1 returning *',[object(path)]),1);
  assert.equal(await count('select * from storage.objects where name=$1',[object('s2/restricted/file.pdf')]),0);
}));
await check('administrador accede a los estudios de su sitio',()=>asActor('admin',async()=>{
  assert.equal(await count('delete from storage.objects where name=$1 returning *',[object('s2/restricted/file.pdf')]),1);
}));
await check('otro sitio no puede leer ni borrar',()=>asActor('admin',async()=>{
  assert.equal(await count('select * from storage.objects'),0);
  assert.equal(await count('delete from storage.objects returning *'),0);
},{site:otherOrg}));
await check('anónimo no puede leer ni borrar pese a tener grants de tabla',()=>asActor('',async()=>{
  assert.equal(await count('select * from storage.objects'),0);
  assert.equal(await count('delete from storage.objects returning *'),0);
},{uid:'',email:'',site:'',databaseRole:'anon'}));
await check('anónimo no puede subir',()=>asActor('',async()=>{
  await assert.rejects(db.query('insert into storage.objects values ($1,$2,$3,$4)',[object('s1/anon/file.pdf'),'ec-docs',null,'{}']),/row-level security/);
},{uid:'',email:'',site:'',databaseRole:'anon'}));
await check('email reciclado no hereda estudios ni facturación de otro authId',()=>asActor('medico',async()=>{
  const [{studies,billing}]=(await db.query('select ec_user_study_ids() studies, ec_can_facturacion() billing')).rows;
  assert.deepEqual(studies,['s1']); assert.equal(billing,false);
},{uid:other,email:'same@example.invalid'}));
await check('authId conserva acceso aunque cambie su email',()=>asActor('medico',async()=>{
  const [{studies,billing}]=(await db.query('select ec_user_study_ids() studies, ec_can_facturacion() billing')).rows;
  assert.deepEqual(studies,['s2']); assert.equal(billing,true);
},{uid:bound,email:'changed@example.invalid'}));
await check('perfil histórico sigue usando email',()=>asActor('medico',async()=>{
  assert.equal((await db.query("select ec_is_own_user('{\"email\":\"legacy@example.invalid\"}'::jsonb) own")).rows[0].own,true);
},{uid:other,email:'legacy@example.invalid'}));
await check('emails vacíos no conceden permisos',()=>asActor('medico',async()=>{
  assert.equal((await db.query("select ec_is_own_user('{\"email\":\"\"}'::jsonb) own")).rows[0].own,false);
},{uid:other,email:''}));
console.log(`${passed} comprobaciones aprobadas en PostgreSQL local (PGlite).`);
await db.close();

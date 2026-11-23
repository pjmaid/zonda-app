// Optional local PostgreSQL-WASM smoke. This is NOT Supabase integration.
// ZONDA_PGLITE_MODULE=/absolute/path/to/pglite/dist/index.js node tests/schema-bootstrap-runtime.mjs
// Optional JSON evidence: ZONDA_SCHEMA_SMOKE_REPORT=/tmp/schema-smoke.json
// Auth/Storage below are minimal managed-schema stubs, never production data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {renderTestSchema} from '../scripts/render-test-schema.mjs';

const {PGlite}=await import(process.env.ZONDA_PGLITE_MODULE||'@electric-sql/pglite');
const root=fileURLToPath(new URL('../',import.meta.url));
const source=JSON.parse(fs.readFileSync(root+'tests/fixtures/schema-baseline-20261123.json','utf8'));
const sql=renderTestSchema(source);
const catalogSQL=fs.readFileSync(root+'scripts/schema-catalog.sql','utf8');
const db=new PGlite();
const report={scope:'Syntax/catalog smoke with managed-schema STUBS ONLY; NOT Supabase integration',checks:[],declaredDifferences:{extensions:'Managed Supabase extensions are not reproduced by the stubs.',bucket:'No bucket rows are created.',notNullConstraintCatalogEntries:0}};

async function check(name,run){await run();report.checks.push(name);console.log('OK '+name);}
async function aborts(expression){await assert.rejects(db.exec(sql),expression);await db.exec('ROLLBACK');}
async function appObjects(){
  return (await db.query(`select count(*)::integer as n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and left(c.relname,3)='ec_'`)).rows[0].n;
}
function normalize(value,key=''){
  if(typeof value==='string')return value.replace(/\r\n/g,'\n');
  if(Array.isArray(value)){
    const values=value.map(item=>normalize(item));
    // Column order is part of the schema; only set-like collections are sorted.
    return key==='columns'?values:values.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,normalize(value[k],k)]));
  return value;
}
try{
  await db.exec(`
    create role anon; create role authenticated; create role service_role; create role supabase_admin;
    create schema auth; create schema storage; create schema extensions;
    create function extensions.gen_random_uuid() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-000000009999'::uuid $$;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
    create table storage.objects(id uuid,name text,bucket_id text,owner_id text,metadata jsonb);
    create table storage.buckets(id text,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
  `);
  report.version=(await db.query('select version() as version')).rows[0].version;
  const versionNumber=Number((await db.query("select current_setting('server_version_num') as version")).rows[0].version);

  await check('sin autorización explícita aborta y no crea objetos',async()=>{
    await aborts(/ZONDA_TEST_BOOTSTRAP_REQUIRED/);assert.equal(await appObjects(),0);
  });
  await db.exec("SET zonda.test_bootstrap='synthetic-only'");

  await check('rechaza una base preexistente y conserva sus filas, columnas y permisos',async()=>{
    await db.exec("create table public.ec_keep(id integer primary key,value text);insert into public.ec_keep values(1,'synthetic sentinel');grant select on public.ec_keep to authenticated;");
    const before=(await db.query("select c.relacl::text as acl from pg_class c where c.oid='public.ec_keep'::regclass")).rows[0];
    await aborts(/ZONDA_NONEMPTY_DATABASE/);
    assert.equal(await appObjects(),2); // table + primary-key index; no new Zonda objects
    assert.deepEqual((await db.query('select * from public.ec_keep')).rows,[{id:1,value:'synthetic sentinel'}]);
    assert.deepEqual((await db.query("select c.relacl::text as acl from pg_class c where c.oid='public.ec_keep'::regclass")).rows[0],before);
    await db.exec('drop table public.ec_keep');
  });

  await check('no reemplaza funciones preexistentes aunque no haya tablas de la aplicación',async()=>{
    await db.exec('create function public.current_org() returns uuid language sql as $$select null::uuid$$;');
    const before=(await db.query("select pg_get_functiondef('public.current_org()'::regprocedure) as definition")).rows[0];
    await aborts(/ZONDA_EXISTING_FUNCTIONS/);
    assert.equal(await appObjects(),0);
    assert.deepEqual((await db.query("select pg_get_functiondef('public.current_org()'::regprocedure) as definition")).rows[0],before);
    await db.exec('drop function public.current_org()');
  });

  await check('defaults globales inesperados abortan sin modificar sus grants',async()=>{
    await db.exec('alter default privileges for role postgres grant execute on functions to anon;');
    const before=(await db.query("select defaclacl::text as acl from pg_default_acl where defaclnamespace=0 and defaclrole='postgres'::regrole")).rows;
    await aborts(/ZONDA_GLOBAL_DEFAULTS_NOT_CAPTURED/);
    assert.equal(await appObjects(),0);
    assert.deepEqual((await db.query("select defaclacl::text as acl from pg_default_acl where defaclnamespace=0 and defaclrole='postgres'::regrole")).rows,before);
    await db.exec('alter default privileges for role postgres revoke execute on functions from anon;');
  });

  await check('el renderer exige evidencia de globals vacíos y rechaza enteros redondeados',async()=>{
    assert.throws(()=>renderTestSchema({...source,default_acl_global:undefined}),/Missing catalog array/);
    assert.throws(()=>renderTestSchema({...source,default_acl_global:[{role:'postgres'}]}),/Custom global/);
    const bad=structuredClone(source);bad.sequences[0].max=9223372036854775807;
    assert.throws(()=>renderTestSchema(bad),/rounded JSON number/);
  });

  await check('crea esquema completo dentro de la transacción y sin copiar filas',async()=>{
    await db.exec(sql);
    for(const table of source.tables)assert.equal((await db.query(`select count(*)::integer as n from public."${table.name}"`)).rows[0].n,0);
    assert.equal((await db.query('select count(*)::integer as n from storage.buckets')).rows[0].n,0);
  });

  await check('el default UUID enlaza pg_catalog aunque exista una función homónima en extensions',async()=>{
    const binding=(await db.query(`
      select n.nspname as function_schema,p.proname as function_name,
        pg_get_expr(d.adbin,d.adrelid) as expression
      from pg_attrdef d
      join pg_attribute a on a.attrelid=d.adrelid and a.attnum=d.adnum
      join pg_proc p on p.oid=((regexp_match(d.adbin::text,':funcid ([0-9]+)'))[1])::oid
      join pg_namespace n on n.oid=p.pronamespace
      where d.adrelid='public.ec_orgs'::regclass and a.attname='id'
    `)).rows[0];
    assert.deepEqual(binding,{function_schema:'pg_catalog',function_name:'gen_random_uuid',expression:'gen_random_uuid()'});
  });

  const actual=(await db.query(catalogSQL)).rows[0].schema_metadata;
  // PG18+ records NOT NULL constraints separately in pg_constraint. The source
  // snapshot is PG17. Only these redundant entries are removed for this WASM
  // smoke, after matching every entry to an already-verified NOT NULL column.
  // Real PG17/Supabase integration comparison MUST NOT use this normalization.
  if(versionNumber>=180000)for(const table of actual.tables){
    const expected=source.tables.find(item=>item.name===table.name);
    table.constraints=(table.constraints||[]).filter(constraint=>{
      if(constraint.type!=='n')return true;
      assert.ok(expected.columns.some(column=>column.notnull&&constraint.definition==='NOT NULL '+column.name),'Unexpected NOT NULL catalog entry: '+constraint.definition);
      report.declaredDifferences.notNullConstraintCatalogEntries++;
      return false;
    });
  }
  for(const key of ['tables','functions','policies','auth_triggers','sequences','schema_acl','default_acl','default_acl_global']){
    await check('catálogo equivalente: '+key,async()=>{
      assert.deepEqual(normalize(actual[key]??(key==='default_acl_global'?[]:actual[key])),normalize(source[key]));
    });
  }

  await check('conserva ACL de auditoría sin habilitar UPDATE o DELETE a clientes',async()=>{
    for(const role of ['anon','authenticated']){
      const result=(await db.query(`select has_table_privilege($1,'public.ec_audit','SELECT') as read,has_table_privilege($1,'public.ec_audit','UPDATE') as update,has_table_privilege($1,'public.ec_audit','DELETE') as delete,has_table_privilege($1,'public.ec_audit','MAINTAIN') as maintain`,[role])).rows[0];
      assert.deepEqual(result,{read:true,update:false,delete:false,maintain:true});
    }
  });

  await check('defaults, secuencia y columnas generadas funcionan con datos exclusivamente sintéticos',async()=>{
    const organization='00000000-0000-0000-0000-000000000001';
    await db.query('insert into public.ec_orgs(id,nombre) values($1,$2)',[organization,'Synthetic bootstrap test']);
    const row=(await db.query("insert into public.ec_records(id,org_id,data) values('record-test',$1,$2) returning record_type,study_id,patient_id,rev",[organization,JSON.stringify({recordType:'test',estudioId:'study-test',pacienteId:'patient-test'})])).rows[0];
    assert.equal(row.record_type,'test');assert.equal(row.study_id,'study-test');assert.equal(row.patient_id,'patient-test');assert.equal(String(row.rev),'1');
    const audit=(await db.query("insert into public.ec_audit(org_id,accion) values($1,'synthetic') returning id,ts",[organization])).rows[0];
    assert.equal(String(audit.id),'1');assert.ok(audit.ts);
    await aborts(/ZONDA_NONEMPTY_DATABASE/);
    assert.equal((await db.query("select count(*)::integer as n from public.ec_records where id='record-test'")).rows[0].n,1);
  });

  await check('la nueva función de la migración conserva los defaults capturados y los revokes',async()=>{
    await db.exec(fs.readFileSync(root+'supabase/migrations/20261123_storage_roles_identidad.sql','utf8'));
    const acl=(await db.query("select proacl::text as acl from pg_proc where proname='ec_can_delete_storage_object'")).rows[0].acl;
    assert.match(acl,/service_role=X\/postgres/);assert.match(acl,/authenticated=X\/postgres/);
    assert.doesNotMatch(acl,/(?:\{|,)anon=|(?:\{|,)=X/);
    report.newMigrationFunctionAcl=acl;
  });
  report.passed=report.checks.length;report.bootstrap={tables:actual.tables.length,functions:actual.functions.length,policies:actual.policies.length};
  console.log(JSON.stringify(report,null,2));
  if(process.env.ZONDA_SCHEMA_SMOKE_REPORT)fs.writeFileSync(process.env.ZONDA_SCHEMA_SMOKE_REPORT,JSON.stringify(report,null,2)+'\n');
}finally{await db.close();}

// Optional SQL behavior smoke with managed Auth/Storage STUBS. No network.
// Not a replacement for the real Storage/Auth integration harness.
// ZONDA_PGLITE_MODULE=/absolute/path/to/pglite/dist/index.js node tests/storage-private-runtime.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {renderTestSchema} from '../scripts/render-test-schema.mjs';
const {PGlite}=await import(process.env.ZONDA_PGLITE_MODULE||'@electric-sql/pglite');
const read=relative=>fs.readFileSync(new URL('../'+relative,import.meta.url),'utf8');
const migration='20261124002147_documentos_privados';
const db=new PGlite();let passed=0,eventSequence=0;
const org='00000000-0000-0000-0000-000000000001',foreignOrg='00000000-0000-0000-0000-000000000002';
const actors={
  author:{id:'00000000-0000-0000-0000-000000000101',role:'coord',billing:true,org},
  peer:{id:'00000000-0000-0000-0000-000000000102',role:'coord',billing:false,org},
  finance:{id:'00000000-0000-0000-0000-000000000103',role:'coord',billing:true,org},
  medico:{id:'00000000-0000-0000-0000-000000000104',role:'medico',billing:false,org},
  admin:{id:'00000000-0000-0000-0000-000000000105',role:'admin',billing:false,org},
  outsider:{id:'00000000-0000-0000-0000-000000000106',role:'admin',billing:true,org:foreignOrg}
};
const full=id=>org+'/study/'+id+'/file.pdf';
async function asActor(actor,run){
  await db.exec('begin;set local role authenticated;');
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:actor.id,role:'authenticated',email:actor.id+'@example.invalid'})]);
  try{const result=await run();await db.exec('commit');return result;}
  catch(error){await db.exec('rollback');throw error;}
}
async function check(name,run){await run();passed++;console.log('OK '+name);}
function storageDenial(message){
  return error=>{
    assert.equal(error.code,'42501','Storage guards must report authorization denial, not an internal P0001 error.');
    assert.match(error.message,message);
    return true;
  };
}
async function stage(id,actor=actors.author,{upsert=false}={}){
  return asActor(actor,()=>db.query(`insert into storage.objects(bucket_id,name,owner_id,metadata) values('ec-docs',$1,$2,'{"content":"original"}') ${upsert?'on conflict(bucket_id,name) do update set metadata=excluded.metadata':''} returning name`,[full(id),actor.id]));
}
async function saveDoc(id,data,actor,rev=null){
  return asActor(actor,()=>db.query("select public.ec_save_record('docs',$1,$2::jsonb,$3,$4,'alta','Synthetic storage test','') as result",[id,JSON.stringify(data),rev,'storage-test-'+(++eventSequence)]));
}
async function publish(id,actor=actors.author,type='contrato'){
  const data={id,estudioId:'study',tipo:type,storage:'supabase',path:'study/'+id+'/file.pdf'};
  return saveDoc(id,data,actor);
}
async function retire(id,actor){
  return asActor(actor,async()=>{
    const row=(await db.query('select rev from public.ec_docs where id=$1',[id])).rows[0];
    assert.ok(row,'The actor must see the document before retirement.');
    return db.query("select public.ec_remove_record('docs',$1,$2,$3,'Synthetic retirement','Synthetic storage test') as result",[id,row.rev,'storage-test-'+(++eventSequence)]);
  });
}
async function cleanupStatus(id,actor){return asActor(actor,async()=> (await db.query('select public.ec_document_cleanup_status($1) as result',['study/'+id+'/file.pdf'])).rows[0].result);}
async function visible(id,actor){return asActor(actor,async()=> (await db.query("select name from storage.objects where bucket_id='ec-docs' and name=$1",[full(id)])).rows.length);}
try{
  await db.exec(`
    create role anon;create role authenticated;create role service_role bypassrls;create role supabase_admin;create role authenticator noinherit;
    create schema auth;create schema storage;
    create table auth.users(id uuid primary key,email text);
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid() returns uuid language sql stable as $$select nullif(auth.jwt()->>'sub','')::uuid$$;
    create function auth.role() returns text language sql stable as $$select auth.jwt()->>'role'$$;
    grant usage on schema auth,storage to authenticated,anon,service_role;
    create table storage.objects(bucket_id text,name text,owner_id text,metadata jsonb,unique(bucket_id,name));
    create table storage.buckets(id text,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    grant select,insert,update,delete on storage.objects to authenticated,service_role;
    set zonda.test_bootstrap='synthetic-only';
  `);
  await db.exec(renderTestSchema(JSON.parse(read('tests/fixtures/schema-baseline-20261123.json'))));
  await db.exec(read('supabase/migrations/20261123_storage_roles_identidad.sql'));
  await db.query('insert into public.ec_orgs(id,nombre) values($1,$2),($3,$4)',[org,'Synthetic A',foreignOrg,'Synthetic B']);
  await db.query('insert into public.ec_studies(id,org_id,data) values($1,$2,$3),($4,$5,$6)',['study',org,JSON.stringify({id:'study'}),'foreign-study',foreignOrg,JSON.stringify({id:'foreign-study'})]);
  for(const [label,actor] of Object.entries(actors)){
    await db.query('insert into auth.users(id) values($1)',[actor.id]);
    await db.query('insert into public.ec_members(user_id,org_id,rol,activo) values($1,$2,$3,true)',[actor.id,actor.org,actor.role]);
    await db.query('insert into public.ec_users(id,org_id,data) values($1,$2,$3)',[label,actor.org,JSON.stringify({id:label,authId:actor.id,activo:true,estudios:actor.org===org?['study']:['foreign-study'],facturacion:actor.billing})]);
  }
  // Bootstrap synthetic actors before membership/audit guards, exactly as a
  // fresh installation creates its first administrator. All client document
  // mutations below go through the audited RPCs after all three migrations.
  await db.exec(read('supabase/migrations/20261124002116_membresias_seguras.sql'));
  await db.exec(read('supabase/migrations/20261124002135_auditoria_permisos.sql'));
  await db.exec(read('supabase/migrations/'+migration+'.sql'));
  await check('cliente anterior puede insertar con upsert=true una ruta todavía inexistente',async()=>{
    assert.equal((await stage('legacy-client',actors.author,{upsert:true})).rows.length,1);
  });
  await check('contrato recién subido sin ficha es privado incluso frente a pares financieros y administradores',async()=>{
    await stage('contract');
    assert.equal(await visible('contract',actors.author),1);
    for(const label of ['peer','finance','medico','admin','outsider'])assert.equal(await visible('contract',actors[label]),0,label);
  });
  await check('otro usuario no puede apropiarse de un archivo privado mediante su ficha',async()=>{
    await assert.rejects(publish('contract',actors.finance),/DOCUMENT_STORAGE_OWNER_REQUIRED/);
    assert.equal(await visible('contract',actors.author),1);
    assert.equal((await db.query("select count(*)::integer as n from public.ec_docs where id='contract'")).rows[0].n,0);
  });
  await check('al publicar un contrato únicamente lo leen los perfiles con permiso financiero',async()=>{
    await publish('contract');
    for(const label of ['author','finance','admin'])assert.equal(await visible('contract',actors[label]),1,label);
    for(const label of ['peer','medico','outsider'])assert.equal(await visible('contract',actors[label]),0,label);
  });
  await check('un protocolo publicado sigue accesible al equipo asignado',async()=>{
    await stage('protocol');await publish('protocol',actors.author,'protocolo');
    for(const label of ['author','peer','finance','medico','admin'])assert.equal(await visible('protocol',actors[label]),1,label);
    assert.equal(await visible('protocol',actors.outsider),0);
  });
  await check('ningún cliente sobrescribe objetos publicados o privados',async()=>{
    for(const id of ['contract','protocol','legacy-client']){
      await assert.rejects(asActor(actors.author,()=>db.query("insert into storage.objects(bucket_id,name,owner_id,metadata) values('ec-docs',$1,$2,'{\"content\":\"changed\"}') on conflict(bucket_id,name) do update set metadata=excluded.metadata",[full(id),actors.author.id])),/row-level security/);
      const direct=await asActor(actors.admin,()=>db.query("update storage.objects set metadata='{\"content\":\"changed\"}' where name=$1 returning name",[full(id)]));
      assert.equal(direct.rows.length,0);
      assert.equal((await db.query('select metadata from storage.objects where name=$1',[full(id)])).rows[0].metadata.content,'original');
    }
  });
  await check('service_role tampoco reescribe ni renombra otro objeto sobre una ruta publicada',async()=>{
    await db.query("insert into storage.objects(bucket_id,name,owner_id,metadata) values('other-bucket','unrelated.pdf',null,'{\"content\":\"unrelated\"}')");
    for(const query of [
      {sql:"update storage.objects set metadata='{\"content\":\"changed\"}' where bucket_id='ec-docs' and name=$1",args:[full('protocol')]},
      {sql:"update storage.objects set bucket_id='ec-docs',name=$1 where bucket_id='other-bucket' and name='unrelated.pdf'",args:[full('protocol')]}
    ]){
      await db.exec('begin;set local role service_role;');
      await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:'service_role'})]);
      await assert.rejects(db.query(query.sql,query.args),storageDenial(/DOCUMENT_STORAGE_CONTENT_IMMUTABLE/));
      await db.exec('rollback');
    }
    assert.equal((await db.query('select metadata from storage.objects where name=$1',[full('protocol')])).rows[0].metadata.content,'original');
    assert.equal((await db.query("select count(*)::integer as n from storage.objects where bucket_id='other-bucket' and name='unrelated.pdf'")).rows[0].n,1);
  });
  await check('el binario publicado no se borra antes de retirar su ficha, incluso por un administrador',async()=>{
    for(const actor of [actors.author,actors.medico,actors.admin]){
      const result=await asActor(actor,()=>db.query('delete from storage.objects where name=$1 returning name',[full('protocol')]));
      assert.equal(result.rows.length,0);
    }
    await db.exec('begin;set local role service_role;');
    await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:'service_role'})]);
    await assert.rejects(db.query('delete from storage.objects where name=$1',[full('protocol')]),storageDenial(/DOCUMENT_METADATA_DELETE_REQUIRED/));
    await db.exec('rollback');
    assert.equal(await visible('protocol',actors.peer),1);
  });
  await check('la compensación privada se limita al propietario y no modifica otros archivos',async()=>{
    const denied=await asActor(actors.finance,()=>db.query('delete from storage.objects where name=$1 returning name',[full('legacy-client')]));
    assert.equal(denied.rows.length,0);
    // Exercise the trigger's second authorization check independently of RLS,
    // with a user JWT and the local fixture owner's SQL privileges. This is a
    // trigger behavior test, not a claim that an API user can bypass RLS.
    await db.exec('begin;');
    await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:actors.finance.id,role:'authenticated'})]);
    await assert.rejects(db.query('delete from storage.objects where name=$1',[full('legacy-client')]),storageDenial(/DOCUMENT_STORAGE_DELETE_ACCESS_REQUIRED/));
    await db.exec('rollback');
    const removed=await asActor(actors.author,()=>db.query('delete from storage.objects where name=$1 returning name',[full('legacy-client')]));
    assert.equal(removed.rows.length,1);assert.equal(await visible('contract',actors.author),1);
  });
  await check('retirar la ficha queda auditado y limita la limpieza al retirador y al administrador',async()=>{
    await stage('retired');await publish('retired',actors.author,'protocolo');
    const result=await retire('retired',actors.medico);
    assert.equal(result.rows[0].result.deleted,true);
    const event=result.rows[0].result.event_id;
    const audit=(await db.query('select actor_id,operation,source from public.ec_audit where event_id=$1',[event])).rows[0];
    assert.deepEqual(audit,{actor_id:actors.medico.id,operation:'DELETE',source:'database'});
    assert.equal((await cleanupStatus('retired',actors.medico)).deleted,true);
    assert.equal((await cleanupStatus('retired',actors.medico)).cleaned,false);
    for(const actor of [actors.author,actors.peer,actors.finance,actors.outsider])assert.equal(await visible('retired',actor),0);
    await assert.rejects(cleanupStatus('retired',actors.author),/DOCUMENT_CLEANUP_ACCESS_REQUIRED/);
    const pending=await asActor(actors.medico,async()=> (await db.query("select public.ec_pending_document_cleanup('study') as result")).rows[0].result);
    assert.ok(pending.some(item=>item.doc_id==='retired'));
    const denied=await asActor(actors.author,()=>db.query('delete from storage.objects where name=$1 returning name',[full('retired')]));
    assert.equal(denied.rows.length,0);
    await assert.rejects(asActor(actors.medico,()=>db.query('select public.ec_confirm_document_cleanup($1)',['study/retired/file.pdf'])),/DOCUMENT_STORAGE_CLEANUP_PENDING/);
    const removed=await asActor(actors.medico,()=>db.query('delete from storage.objects where name=$1 returning name',[full('retired')]));
    assert.equal(removed.rows.length,1);
    assert.equal((await cleanupStatus('retired',actors.medico)).cleaned,true);
    const confirmed=await asActor(actors.medico,()=>db.query('select public.ec_confirm_document_cleanup($1) as result',['study/retired/file.pdf']));
    assert.equal(confirmed.rows[0].result.ok,true);
    const ledger=(await db.query("select retired_by,cleaned_by,retired_at is not null as retired,cleaned_at is not null as cleaned from zonda_private.document_paths where doc_id='retired'")).rows[0];
    assert.deepEqual(ledger,{retired_by:actors.medico.id,cleaned_by:actors.medico.id,retired:true,cleaned:true});
  });
  await check('retirar y limpiar no libera jamás la ruta ni el identificador ya publicado',async()=>{
    for(const actor of [actors.author,actors.medico,actors.admin])await assert.rejects(stage('retired',actor),storageDenial(/DOCUMENT_STORAGE_PATH_RETIRED/));
    await assert.rejects(publish('retired',actors.admin,'protocolo'),/DOCUMENT_STORAGE_PATH_ALREADY_PUBLISHED/);
    await assert.rejects(saveDoc('retired',{id:'retired',estudioId:'study',tipo:'protocolo',storage:'supabase',path:'study/retired/other.pdf'},actors.admin),/DOCUMENT_STORAGE_PATH_ALREADY_PUBLISHED/);
    await db.exec('begin;set local role service_role;');
    await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:'service_role'})]);
    await assert.rejects(db.query("insert into storage.objects(bucket_id,name,owner_id,metadata) values('ec-docs',$1,null,'{}')",[full('retired')]),storageDenial(/DOCUMENT_STORAGE_PATH_RETIRED/));
    await db.exec('rollback');
    assert.equal((await db.query('select count(*)::integer as n from storage.objects where name=$1',[full('retired')])).rows[0].n,0);
  });
  await check('ruta, clasificación y ámbito no cambian tras publicar, incluso desde service_role',async()=>{
    for(const [key,value] of [['path','study/other/file.pdf'],['tipo','protocolo'],['estudioId','foreign-study'],['pacienteId','patient'],['gastoId','expense'],['storage','idb']]){
      const row=(await db.query("select data,rev from public.ec_docs where id='contract'")).rows[0];
      await assert.rejects(saveDoc('contract',{...row.data,[key]:value},actors.finance,row.rev),/DOCUMENT_STORAGE_IDENTITY_IMMUTABLE/);
    }
    await db.exec('begin;set local role service_role;');await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:'service_role'})]);
    await assert.rejects(db.query("update public.ec_docs set data=jsonb_set(data,'{tipo}','\"protocolo\"') where id='contract'"),/DOCUMENT_STORAGE_IDENTITY_IMMUTABLE/);
    await db.exec('rollback');
  });
  await check('el historial evita alias incluso en una creación administrativa',async()=>{
    await assert.rejects(db.query('insert into public.ec_docs(id,org_id,data) values($1,$2,$3)',['alias',org,JSON.stringify({id:'alias',estudioId:'study',tipo:'protocolo',storage:'supabase',path:'study/contract/file.pdf'})]),/DOCUMENT_STORAGE_PATH_ALREADY_PUBLISHED/);
  });
  await check('un propietario nulo no habilita acceso y las rutas históricas requieren ficha exacta',async()=>{
    const path=org+'/historical/file.pdf';
    await db.query("insert into storage.objects(bucket_id,name,owner_id,metadata) values('ec-docs',$1,null,'{}')",[path]);
    assert.equal((await asActor(actors.admin,()=>db.query('select name from storage.objects where name=$1',[path]))).rows.length,0);
    await db.query('insert into public.ec_docs(id,org_id,data) values($1,$2,$3)',['historical',org,JSON.stringify({id:'historical',estudioId:'study',tipo:'protocolo',path:'historical/file.pdf',storage:'supabase'})]);
    assert.equal((await asActor(actors.peer,()=>db.query('select name from storage.objects where name=$1',[path]))).rows.length,1);
  });
  await check('la restauración de un objeto ausente conserva una ficha activa y permite owner nulo del servicio',async()=>{
    // Models a schema/data restore performed before restoring its object bytes;
    // no published object is deleted or replaced to prepare this fixture.
    await db.query('insert into public.ec_docs(id,org_id,data) values($1,$2,$3)',['restored',org,JSON.stringify({id:'restored',estudioId:'study',tipo:'protocolo',path:'study/restored/file.pdf',storage:'supabase'})]);
    await db.exec('begin;set local role service_role;');
    await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:'service_role'})]);
    await db.query("insert into storage.objects(bucket_id,name,owner_id,metadata) values('ec-docs',$1,null,'{\"content\":\"restored-original\"}')",[full('restored')]);
    await db.exec('commit');
    assert.equal(await visible('restored',actors.peer),1);
    assert.equal((await cleanupStatus('restored',actors.peer)).deleted,false);
  });
  await check('el ledger permanente no es una API de lectura ni escritura directa para clientes o servicio',async()=>{
    for(const role of ['anon','authenticated','service_role']){
      await db.exec('begin;set local role '+role+';');
      await assert.rejects(db.query('select * from zonda_private.document_paths'),/permission denied/);
      await db.exec('rollback');
    }
  });
  await check('fallar la publicación conserva el binario y no deja una ficha visible',async()=>{
    await stage('unconfirmed');
    await assert.rejects(saveDoc('wrong-id',{id:'wrong-id',estudioId:'study',tipo:'contrato',path:'study/unconfirmed/file.pdf',storage:'supabase'},actors.author),/DOCUMENT_STORAGE_PATH_INVALID/);
    assert.equal(await visible('unconfirmed',actors.author),1);assert.equal(await visible('unconfirmed',actors.finance),0);
  });
  await check('rollback rechaza historial poblado y conserva protección, filas, historial y binarios',async()=>{
    const before=(await db.query('select count(*)::integer as n from storage.objects')).rows[0].n;
    const ledgerBefore=(await db.query('select * from zonda_private.document_paths order by org_id,path')).rows;
    await assert.rejects(db.exec(read('supabase/rollback/'+migration+'_down.sql')),/DOCUMENT_HISTORY_ROLLBACK_BLOCKED/);
    await db.exec('rollback');
    assert.equal((await db.query('select count(*)::integer as n from storage.objects')).rows[0].n,before);
    assert.deepEqual((await db.query('select * from zonda_private.document_paths order by org_id,path')).rows,ledgerBefore);
    assert.equal(await visible('unconfirmed',actors.peer),0);
    assert.equal((await db.query("select count(*)::integer as n from public.ec_docs where id='contract'")).rows[0].n,1);
  });
  console.log(JSON.stringify({scope:'SQL smoke with managed Auth/Storage stubs; NOT real integration',passed,version:(await db.query('select version() as version')).rows[0].version},null,2));
}finally{await db.close();}

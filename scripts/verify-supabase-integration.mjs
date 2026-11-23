/* Integración con Auth y Storage reales, exclusivamente en un proyecto de prueba
 * separado y vacío. Sin --execute solo describe el plan: no hace solicitudes.
 * Las credenciales se reciben por entorno; nunca se escriben ni imprimen.
 */
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const PRODUCTION_REF='aqinxboxjklsyvesdcyr';
const PRODUCTION_PUBLIC_KEY='sb_publishable_ypqDPv6T3S4cDuNFi2Yq2A_Lt5rJ68m';
export function isMissingStorageBucket(result){
  if(result.status===404) return true;
  // Storage 1.98.6 conserva HTTP 400 para compatibilidad, pero identifica
  // inequívocamente el 404 semántico. No adoptar otros errores como ausencia.
  return result.status===400 && result.body?.statusCode==='404'
    && result.body.code==='NoSuchBucket' && ['NoSuchBucket','Bucket not found'].includes(result.body.error)
    && result.body.message==='Bucket not found';
}
export function validateTestConfig(env){
  const ref=String(env.ZONDA_TEST_PROJECT_REF||'').trim();
  const mode=env.ZONDA_TEST_MODE||'hosted';
  assert.equal(env.ZONDA_TEST_ENVIRONMENT,'test','Declarar ZONDA_TEST_ENVIRONMENT=test.');
  assert.notEqual(ref,PRODUCTION_REF,'El proyecto productivo está bloqueado.');
  assert.equal(env.ZONDA_TEST_CONFIRM_REF,ref,'ZONDA_TEST_CONFIRM_REF debe coincidir con el proyecto de prueba.');
  const url=new URL(env.ZONDA_TEST_URL||'');
  if(mode==='local'){
    assert.equal(ref,'local-zonda-test','El destino local debe llamarse local-zonda-test.');
    assert.ok(['http:','https:'].includes(url.protocol)&&['127.0.0.1','localhost','[::1]'].includes(url.hostname),'El modo local solo admite loopback.');
  }else{
    assert.equal(mode,'hosted','Modo de prueba inválido.');
    assert.match(ref,/^[a-z0-9]{20}$/,'Falta un project ref válido para prueba.');
    assert.equal(url.origin,`https://${ref}.supabase.co`,'La URL debe corresponder al proyecto de prueba declarado.');
  }
  assert.ok(url.pathname==='/'&&!url.username&&!url.password&&!url.search&&!url.hash,'La URL no debe incluir ruta ni credenciales.');
  const publicKey=String(env.ZONDA_TEST_PUBLIC_KEY||'');
  const serviceKey=String(env.ZONDA_TEST_SERVICE_KEY||'');
  const runtime=readFileSync(new URL('../runtime-config.js',import.meta.url),'utf8');
  const productionRuntime=/environment:\s*['"]production['"]/.test(runtime);
  const runtimeRef=runtime.match(/supaUrl:\s*['"]https:\/\/([a-z0-9]+)\.supabase\.co/);
  const runtimeKey=runtime.match(/supaKey:\s*['"]([^'"]+)['"]/);
  if(productionRuntime&&runtimeRef) assert.notEqual(ref,runtimeRef[1],'El runtime productivo está bloqueado.');
  const forbiddenKeys=[PRODUCTION_PUBLIC_KEY,...(productionRuntime&&runtimeKey?[runtimeKey[1]]:[])];
  if(forbiddenKeys.includes(publicKey)||forbiddenKeys.includes(serviceKey)) throw new Error('No se permiten claves del runtime productivo.');
  assert.ok(publicKey.length>20&&serviceKey.length>20,'Faltan claves del proyecto de prueba en el entorno.');
  if(publicKey===serviceKey) throw new Error('La clave pública y la de servicio deben ser distintas.');
  for(const [key,role] of [[publicKey,'anon'],[serviceKey,'service_role']]){
    if(key.split('.').length===3){
      let payload;
      try{ payload=JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString()); }catch{ throw new Error('Formato JWT de clave inválido.'); }
      assert.equal(payload.role,role,'La clave JWT no tiene el rol esperado.');
      assert.notEqual(payload.ref,PRODUCTION_REF,'No se permiten claves del proyecto productivo.');
      if(mode!=='local'||payload.ref) assert.equal(payload.ref,ref,'Una clave pertenece a otro proyecto.');
    }else{
      assert.ok(key.startsWith(role==='anon'?'sb_publishable_':'sb_secret_'),'Usar una clave Supabase del tipo correcto.');
    }
  }
  return {ref,url:url.origin,publicKey,serviceKey,mode};
}

const fixtureBytes=Buffer.from('%PDF-1.4\n% Zonda synthetic integration fixture. No patient data.\n%%EOF\n');
const changedBytes=Buffer.from('%PDF-1.4\n% Zonda synthetic changed fixture. No patient data.\n%%EOF\n');
const PLAN={
  purpose:'Validar Auth, membresías, aislamiento de sitios y Storage con datos sintéticos.',
  prerequisites:['Proyecto separado vacío y confirmado como test','Esquema real y migración 20261123_storage_roles_identidad aplicados','Bucket ec-docs privado o aún inexistente'],
  creates:['2 organizaciones sintéticas','3 estudios sin pacientes','8 cuentas Auth confirmadas sin enviar email','Fichas y archivos PDF sintéticos'],
  cleanup:'Elimina solamente los IDs y objetos creados en esta ejecución, también ante fallos.',
  limitations:['No valida correos SMTP, Edge Functions ni interfaz web','No aplica migraciones ni crea proyectos','No modifica el proyecto productivo'],
  variables:['ZONDA_TEST_ENVIRONMENT','ZONDA_TEST_MODE (hosted o local)','ZONDA_TEST_PROJECT_REF','ZONDA_TEST_CONFIRM_REF','ZONDA_TEST_URL','ZONDA_TEST_PUBLIC_KEY','ZONDA_TEST_SERVICE_KEY']
};

export async function runIntegration(env,{fetchImpl=fetch,log=console.log}={}){
  const config=validateTestConfig(env);
  const runId='zi_'+Date.now().toString(36)+'_'+randomBytes(4).toString('hex');
  const state={orgs:[],studies:[],docs:[],profiles:[],authIds:[],objects:new Set(),bucketCreated:false};
  const report={runId,projectRef:config.ref,startedAt:new Date().toISOString(),checks:[],cleanup:[],passed:false};
  const actors={};
  const service={key:config.serviceKey,token:config.serviceKey};
  const anonymous={key:config.publicKey};
  async function request(path,{actor=service,method='GET',json,bytes,headers={}}={}){
    assert.ok(path.startsWith('/')&&!path.startsWith('//'),'Ruta API inválida.');
    const h={apikey:actor.key||config.publicKey,...headers};
    if(actor.token) h.Authorization='Bearer '+actor.token;
    if(json!==undefined) h['Content-Type']='application/json';
    const response=await fetchImpl(config.url+path,{method,headers:h,body:json!==undefined?JSON.stringify(json):bytes,
      redirect:'error',signal:AbortSignal.timeout(30000)});
    const raw=Buffer.from(await response.arrayBuffer());
    let body=null; try{ body=JSON.parse(raw.toString()); }catch{}
    return {status:response.status,ok:response.ok,body,raw};
  }
  function requireOK(result,label){ assert.ok(result.ok,`${label}: HTTP ${result.status}.`); return result.body; }
  async function insert(table,row){
    return requireOK(await request('/rest/v1/'+table,{method:'POST',json:row,headers:{Prefer:'return=representation'}}),'Crear fixture '+table);
  }
  async function check(name,fn){
    try{ await fn(); report.checks.push({name,status:'passed'}); log('OK '+name); }
    catch(error){ report.checks.push({name,status:'failed',message:error.message}); throw error; }
  }
  function storagePath(name){ return '/storage/v1/object/ec-docs/'+name.split('/').map(encodeURIComponent).join('/'); }
  async function upload(actor,name,{upsert=false,bytes=fixtureBytes}={}){
    state.objects.add(name);
    return request(storagePath(name),{actor,method:'POST',bytes,headers:{'Content-Type':'application/pdf','x-upsert':String(upsert)}});
  }
  async function download(actor,name){ return request(storagePath(name),{actor}); }
  async function remove(actor,name){ return request('/storage/v1/object/ec-docs',{actor,method:'DELETE',json:{prefixes:[name]}}); }
  function removed(result,name){ return result.ok&&Array.isArray(result.body)&&result.body.some(x=>x.name===name); }
  async function assertPresent(name,bytes=fixtureBytes){
    const result=await download(service,name); requireOK(result,'Verificar archivo'); assert.deepEqual(result.raw,bytes,'El contenido del archivo cambió.');
  }
  function denied(result){ assert.ok([400,401,403,404].includes(result.status),'Se esperaba denegación, HTTP '+result.status+'.'); }
  async function assertDeleteDenied(actor,name,bytes=fixtureBytes){
    const result=await remove(actor,name);
    assert.ok(!removed(result,name),'Se eliminó un archivo que debía estar protegido.');
    if(!result.ok) denied(result);
    await assertPresent(name,bytes);
  }
  async function createActor(label,role,org,studies,{billing=false,legacy=false,profileEmail}={}){
    const email=`${runId}-${label}@example.invalid`;
    const password=randomBytes(28).toString('base64url')+'Aa7!';
    const userBody=requireOK(await request('/auth/v1/admin/users',{method:'POST',json:{email,password,email_confirm:true}}),'Crear cuenta sintética');
    const user=userBody.user||userBody;
    assert.match(user.id,/^[0-9a-f-]{36}$/i,'Auth no devolvió el ID de la cuenta creada.');
    state.authIds.push(user.id);
    await insert('ec_members',{user_id:user.id,org_id:org,rol:role,superadmin:false,activo:true});
    const profileId=runId+'_'+label;
    state.profiles.push(profileId);
    await insert('ec_users',{id:profileId,org_id:org,data:{id:profileId,nombre:'Fixture '+label,email:profileEmail||email,
      ...(legacy?{}:{authId:user.id}),rol:role,estudios:studies,facturacion:billing,activo:true}});
    const session=requireOK(await request('/auth/v1/token?grant_type=password',{actor:anonymous,method:'POST',json:{email,password}}),'Ingresar cuenta sintética');
    assert.ok(session.access_token&&session.user?.id===user.id,'Auth no devolvió una sesión válida.');
    const actor={token:session.access_token,id:user.id,profileId}; actors[label]=actor; return actor;
  }
  async function createDocument(label,study,org,owner,{type='protocolo'}={}){
    const id=runId+'_'+label;
    const relative=study+'/'+id+'/fixture.pdf';
    const path=org+'/'+relative;
    requireOK(await upload(owner,path),'Subir documento sintético');
    state.docs.push(id);
    await insert('ec_docs',{id,org_id:org,data:{id,estudioId:study,tipo:type,path:relative,storage:'supabase',nombre:'fixture.pdf'}});
    return {id,path};
  }
  async function assertApplicationEmpty(){
    for(const table of ['ec_orgs','ec_studies','ec_patients','ec_docs','ec_users','ec_visits','ec_records','ec_checklists','ec_settings','ec_audit','ec_members']){
      const column=table==='ec_members'?'user_id':'id';
      const rows=requireOK(await request('/rest/v1/'+table+'?select='+column+'&limit=1'),'Verificar esquema vacío '+table);
      assert.ok(Array.isArray(rows)&&rows.length===0,'El proyecto de prueba debe estar vacío: '+table+'.');
    }
    const users=requireOK(await request('/auth/v1/admin/users?page=1&per_page=1'),'Verificar Auth vacío');
    assert.ok(Array.isArray(users.users)&&users.users.length===0,'El proyecto de prueba ya contiene usuarios Auth.');
  }
  async function assertBucketEmpty(){
    const bucket=await request('/storage/v1/bucket/ec-docs');
    if(bucket.ok){
      assert.equal(bucket.body.public,false,'El bucket ec-docs debe ser privado.');
      const objects=requireOK(await request('/storage/v1/object/list/ec-docs',{method:'POST',json:{prefix:'',limit:1,offset:0,sortBy:{column:'name',order:'asc'}}}),'Verificar bucket vacío');
      assert.ok(Array.isArray(objects)&&objects.length===0,'El bucket de prueba ya contiene objetos o carpetas.');
    }else assert.ok(isMissingStorageBucket(bucket),'No se pudo verificar el bucket ec-docs: HTTP '+bucket.status+'.');
    return bucket;
  }
  async function cleanup(){
    async function step(label,fn){
      try{ await fn(); report.cleanup.push({name:label,status:'passed'}); }
      catch(error){ report.cleanup.push({name:label,status:'failed',message:error.message}); }
    }
    if(state.objects.size) await step('objetos sintéticos',async()=>requireOK(await request('/storage/v1/object/ec-docs',{method:'DELETE',json:{prefixes:[...state.objects]}}),'Limpiar objetos'));
    for(const [table,ids] of [['ec_docs',state.docs],['ec_users',state.profiles]])
      if(ids.length) await step(table,async()=>requireOK(await request('/rest/v1/'+table+'?id=in.('+ids.join(',')+')',{method:'DELETE'}),'Limpiar '+table));
    if(state.studies.length) await step('ec_studies',async()=>requireOK(await request('/rest/v1/ec_studies?id=in.('+state.studies.join(',')+')',{method:'DELETE'}),'Limpiar estudios'));
    if(state.authIds.length) await step('ec_members',async()=>requireOK(await request('/rest/v1/ec_members?user_id=in.('+state.authIds.join(',')+')',{method:'DELETE'}),'Limpiar membresías'));
    for(const id of state.authIds) await step('cuenta '+id,async()=>requireOK(await request('/auth/v1/admin/users/'+id,{method:'DELETE'}),'Limpiar cuenta'));
    if(state.orgs.length) await step('ec_orgs',async()=>requireOK(await request('/rest/v1/ec_orgs?id=in.('+state.orgs.join(',')+')',{method:'DELETE'}),'Limpiar sitios'));
    if(state.bucketCreated) await step('bucket vacío creado por la prueba',async()=>requireOK(await request('/storage/v1/bucket/ec-docs',{method:'DELETE'}),'Limpiar bucket'));
    await step('verificar destino vacío tras limpieza',async()=>{ await assertApplicationEmpty(); await assertBucketEmpty(); });
  }
  let mutationStarted=false;
  try{
    // Rechaza un destino con datos o cuentas: la prueba exige un entorno nuevo,
    // dedicado y vacío. No se adopta ni limpia ningún objeto preexistente.
    await assertApplicationEmpty();
    const bucket=await assertBucketEmpty();

    mutationStarted=true;
    if(!bucket.ok){ requireOK(await request('/storage/v1/bucket',{method:'POST',json:{id:'ec-docs',name:'ec-docs',public:false}}),'Crear bucket privado de prueba'); state.bucketCreated=true; }
    const orgA=randomUUID(),orgB=randomUUID();
    for(const [id,label] of [[orgA,'A'],[orgB,'B']]){
      state.orgs.push(id); await insert('ec_orgs',{id,nombre:'Zonda integración '+runId+' '+label,activo:true});
    }
    const studyA=runId+'_study_a',studyOther=runId+'_study_other',studyB=runId+'_study_b';
    for(const [id,org] of [[studyA,orgA],[studyOther,orgA],[studyB,orgB]]){
      state.studies.push(id); await insert('ec_studies',{id,org_id:org,data:{id,nombre:'Estudio sintético',codigo:id}});
    }
    await createActor('admin','admin',orgA,[]);
    await createActor('coord','coord',orgA,[studyA]);
    await createActor('finance','coord',orgA,[studyA],{billing:true});
    await createActor('medico','medico',orgA,[studyA]);
    await createActor('outsider','admin',orgB,[]);
    await createActor('recycled','medico',orgA,[studyA]);
    await createActor('bound','medico',orgA,[studyOther],{billing:true,profileEmail:`${runId}-recycled@example.invalid`});
    await createActor('legacy','medico',orgA,[studyA],{legacy:true});
    const clinical=await createDocument('clinical',studyA,orgA,actors.coord);
    const contract=await createDocument('contract',studyA,orgA,actors.finance,{type:'contrato'});
    const restricted=await createDocument('restricted',studyOther,orgA,actors.admin);
    const historical=await createDocument('historical',studyA,orgA,actors.medico);
    // Una ruta histórica se crea con service_role porque la RLS de INSERT
    // necesita su ficha previa; la lectura/baja se prueban con JWT de usuario.
    const legacyId=runId+'_oldpath',legacyPath=orgA+'/'+legacyId+'/fixture.pdf';
    requireOK(await upload(service,legacyPath),'Crear binario histórico sintético');
    state.docs.push(legacyId);
    await insert('ec_docs',{id:legacyId,org_id:orgA,data:{id:legacyId,estudioId:studyA,tipo:'protocolo',path:legacyId+'/fixture.pdf',storage:'supabase'}});

    await check('Auth devuelve la membresía real del usuario',async()=>{
      const rows=requireOK(await request('/rest/v1/ec_members?user_id=eq.'+actors.coord.id,{actor:actors.coord}),'Leer membresía');
      assert.ok(rows.some(x=>x.user_id===actors.coord.id&&x.org_id===orgA&&x.rol==='coord'&&x.activo),'Membresía incorrecta.');
    });
    await check('coordinadora lee y actualiza, sin borrar documento clínico',async()=>{
      const downloaded=await download(actors.coord,clinical.path); requireOK(downloaded,'Descarga'); assert.deepEqual(downloaded.raw,fixtureBytes);
      requireOK(await upload(actors.coord,clinical.path,{upsert:true,bytes:changedBytes}),'Actualizar archivo');
      await assertDeleteDenied(actors.coord,clinical.path,changedBytes);
    });
    await check('compensación borra la carga propia sin ficha y conserva la ajena',async()=>{
      const own=orgA+'/'+studyA+'/'+runId+'_own/fixture.pdf',other=orgA+'/'+studyA+'/'+runId+'_other/fixture.pdf';
      requireOK(await upload(actors.coord,own),'Subida propia'); requireOK(await upload(actors.medico,other),'Subida ajena');
      assert.ok(removed(await remove(actors.coord,own),own),'No se compensó la subida propia.');
      await assertDeleteDenied(actors.coord,other);
    });
    await check('contrato exige facturación y permite su baja autorizada',async()=>{
      denied(await download(actors.coord,contract.path)); await assertDeleteDenied(actors.coord,contract.path);
      const result=await download(actors.finance,contract.path); requireOK(result,'Descarga financiera'); assert.deepEqual(result.raw,fixtureBytes);
      assert.ok(removed(await remove(actors.finance,contract.path),contract.path),'No se permitió la baja financiera.');
    });
    await check('otro sitio no lee, sobrescribe ni borra el archivo',async()=>{
      denied(await download(actors.outsider,clinical.path));
      denied(await upload(actors.outsider,clinical.path,{upsert:true}));
      await assertDeleteDenied(actors.outsider,clinical.path,changedBytes);
    });
    await check('médico respeta asignación y administrador accede a su sitio',async()=>{
      denied(await download(actors.medico,restricted.path));
      const result=await download(actors.admin,restricted.path); requireOK(result,'Descarga admin'); assert.deepEqual(result.raw,fixtureBytes);
    });
    await check('anónimo no lee, sobrescribe ni borra archivos privados',async()=>{
      denied(await download(anonymous,clinical.path)); denied(await upload(anonymous,clinical.path,{upsert:true}));
      await assertDeleteDenied(anonymous,clinical.path,changedBytes);
    });
    await check('email reciclado no hereda estudios ni facturación de otra cuenta',async()=>{
      const studies=requireOK(await request('/rest/v1/rpc/ec_user_study_ids',{actor:actors.recycled,method:'POST',json:{}}),'Consultar estudios');
      const billing=requireOK(await request('/rest/v1/rpc/ec_can_facturacion',{actor:actors.recycled,method:'POST',json:{}}),'Consultar facturación');
      assert.deepEqual(studies,[studyA]); assert.equal(billing,false);
    });
    await check('authId conserva acceso aunque no coincida el email histórico',async()=>{
      assert.deepEqual(requireOK(await request('/rest/v1/rpc/ec_user_study_ids',{actor:actors.bound,method:'POST',json:{}}),'Consultar vínculo'),[studyOther]);
    });
    await check('perfil histórico sin authId conserva su asignación',async()=>{
      assert.deepEqual(requireOK(await request('/rest/v1/rpc/ec_user_study_ids',{actor:actors.legacy,method:'POST',json:{}}),'Consultar ficha histórica'),[studyA]);
    });
    await check('médico puede borrar rutas actuales e históricas autorizadas',async()=>{
      for(const name of [historical.path,legacyPath]){
        const result=await download(actors.medico,name); requireOK(result,'Descarga histórica'); assert.deepEqual(result.raw,fixtureBytes);
        assert.ok(removed(await remove(actors.medico,name),name),'No se permitió una baja autorizada.');
      }
    });
    await check('coordinadora sin asignación no accede al protocolo',async()=>{
      const rows=requireOK(await request('/rest/v1/ec_users?select=data&id=eq.'+actors.coord.profileId),'Leer fixture de perfil');
      assert.equal(rows.length,1,'No se encontró el perfil sintético.');
      const data=rows[0].data;
      requireOK(await request('/rest/v1/ec_users?id=eq.'+actors.coord.profileId,{method:'PATCH',json:{data:{...data,estudios:[]}}}),'Retirar asignación sintética');
      denied(await download(actors.coord,clinical.path));
      requireOK(await request('/rest/v1/ec_users?id=eq.'+actors.coord.profileId,{method:'PATCH',json:{data}}),'Restaurar asignación sintética');
    });
    await check('membresía inactiva invalida acceso con el token ya emitido',async()=>{
      requireOK(await request('/rest/v1/ec_members?user_id=eq.'+actors.coord.id,{method:'PATCH',json:{activo:false}}),'Desactivar fixture');
      denied(await download(actors.coord,clinical.path));
      denied(await upload(actors.coord,orgA+'/'+studyA+'/'+runId+'_inactive/fixture.pdf'));
      denied(await upload(actors.coord,clinical.path,{upsert:true}));
      await assertDeleteDenied(actors.coord,clinical.path,changedBytes);
    });
    await check('cuenta Auth sin membresía no accede a archivos del sitio',async()=>{
      requireOK(await request('/rest/v1/ec_members?user_id=eq.'+actors.coord.id,{method:'DELETE'}),'Retirar membresía sintética');
      const memberships=requireOK(await request('/rest/v1/ec_members?select=user_id&user_id=eq.'+actors.coord.id),'Verificar retiro de membresía');
      assert.ok(Array.isArray(memberships)&&memberships.length===0,'La membresía sintética no se retiró.');
      denied(await download(actors.coord,clinical.path));
      denied(await upload(actors.coord,orgA+'/'+studyA+'/'+runId+'_nomember/fixture.pdf'));
      await assertDeleteDenied(actors.coord,clinical.path,changedBytes);
    });
    report.passed=true;
  }catch(error){ report.error=error.message; }
  finally{
    if(mutationStarted) await cleanup();
    if(report.cleanup.some(x=>x.status==='failed')) report.passed=false;
    report.finishedAt=new Date().toISOString();
    if(!report.passed&&mutationStarted) report.fixtureManifest={orgs:state.orgs,authIds:state.authIds,profiles:state.profiles,docs:state.docs,studies:state.studies,objects:[...state.objects]};
  }
  return report;
}

async function main(){
  if(!process.argv.includes('--execute')){ console.log(JSON.stringify(PLAN,null,2)); return; }
  const result=await runIntegration(process.env,process.argv.includes('--json')?{log:()=>{}}:{});
  console.log(JSON.stringify(result,null,2));
  if(!result.passed) process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(error=>{ console.error(error.message); process.exitCode=1; });

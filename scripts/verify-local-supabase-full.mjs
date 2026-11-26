#!/usr/bin/env node
// No action without --execute. Uses only official runtime binaries prepared in
// a separate local directory. Every run gets a fresh synthetic database; it
// never resets, imports rows from, or connects to a hosted project.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import {randomBytes,timingSafeEqual,createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {renderTestSchema} from './render-test-schema.mjs';
import {startLocalAuthMailCapture} from './verify-auth-recovery-local.mjs';
import {runHardeningIntegration} from './verify-supabase-hardening-local.mjs';
import {runUserAdministrationIntegration} from './verify-user-administration-local.mjs';

const exec=promisify(execFile);
const appRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const MIGRATIONS=['20261124002116_membresias_seguras','20261124002135_auditoria_permisos','20261124002147_documentos_privados'];
const ROLLBACK_FILES={
  '20261124002116_membresias_seguras':'20261124002116_membresias_seguras_down.sql',
  '20261124002135_auditoria_permisos':'20261124002135_auditoria_permisos.sql',
  '20261124002147_documentos_privados':'20261124002147_documentos_privados_down.sql',
};
const VALIDATION_INPUTS=['index.html','tests/auth-runtime.test.js','tests/fixtures/schema-baseline-20261124.json',
  'scripts/verify-local-supabase-full.mjs','scripts/verify-auth-recovery-local.mjs',
  'scripts/synthetic-supabase-fixtures.mjs','scripts/verify-supabase-hardening-local.mjs',
  'scripts/verify-supabase-backup-restore.mjs','scripts/verify-supabase-integration.mjs',
  'scripts/verify-user-administration-local.mjs','supabase/functions/crear-usuario/index.ts',
  'scripts/render-test-schema.mjs','scripts/schema-catalog.sql',
  ...MIGRATIONS.map(name=>'supabase/migrations/'+name+'.sql'),
  ...Object.values(ROLLBACK_FILES).map(name=>'supabase/rollback/'+name)];
const validationInputHashes=()=>VALIDATION_INPUTS.map(file=>({file,sha256:createHash('sha256').update(fs.readFileSync(path.join(appRoot,file))).digest('hex')}));
export function validateNativeOptions({runtimeDir,pgEnv}){
  assert.ok(path.isAbsolute(runtimeDir),'An absolute native runtime directory is required.');
  assert.equal(pgEnv.PGHOST,'127.0.0.1','PostgreSQL must bind loopback.');
  assert.equal(String(pgEnv.PGPORT),'55432','Unexpected native test database port.');
  assert.equal(pgEnv.PGUSER,'postgres','Native bootstrap requires the disposable local postgres owner.');
  assert.equal(pgEnv.PGDATABASE,'postgres','Native private configuration must point at its management database.');
}
export function databaseUrlFor(source,database){
  assert.match(database,/^zonda_(test|restore)_[a-f0-9]{12,32}$/,'Only generated synthetic database names are accepted.');
  const url=new URL(source);
  assert.ok(['postgres:','postgresql:'].includes(url.protocol));
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname),'Database configuration must stay on loopback.');
  assert.equal(url.port,'55432');url.hostname='127.0.0.1';url.pathname='/'+database;
  return url.toString();
}
async function localGateway({port,ports,anonKey,serviceKey}){
  const routes=[['/auth/v1',ports.auth],['/rest/v1',ports.rest],['/storage/v1',ports.storage]];
  const allowed=value=>[anonKey,serviceKey].some(key=>{const a=Buffer.from(value||''),b=Buffer.from(key);return a.length===b.length&&timingSafeEqual(a,b);});
  const server=http.createServer((req,res)=>{
    const route=routes.find(([prefix])=>req.url===prefix||req.url.startsWith(prefix+'/')||req.url.startsWith(prefix+'?'));
    if(!route){res.writeHead(404);res.end();return;}
    if(!allowed(req.headers.apikey)){res.writeHead(401);res.end();return;}
    const [prefix,targetPort]=route;
    const headers={...req.headers,host:'127.0.0.1:'+targetPort};
    if(!headers.authorization)headers.authorization='Bearer '+req.headers.apikey;
    const upstream=http.request({hostname:'127.0.0.1',port:targetPort,path:req.url.slice(prefix.length)||'/',method:req.method,headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
    req.on('aborted',()=>upstream.destroy());req.pipe(upstream);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return server;
}

export async function runFullLocalValidation({runtimeDir,log=console.log,skipBackup=false}={}){
  const native=await import(pathToFileURL(path.join(runtimeDir,'native-service-config.mjs')));
  assert.equal(path.resolve(native.nativeRoot),path.resolve(runtimeDir));
  const privatePg=native.readPrivateEnv('pg.env'),privateAuth=native.readPrivateEnv('auth.env'),privateStorage=native.readPrivateEnv('storage.env');
  validateNativeOptions({runtimeDir,pgEnv:privatePg});
  const {Client}=createRequire(path.join(runtimeDir,'storage-image/app/package.json'))('pg');
  const runId=randomBytes(8).toString('hex'),database='zonda_test_'+runId;
  const reportDir=path.join(runtimeDir,'reports',runId);fs.mkdirSync(reportDir,{recursive:true,mode:0o700});
  const report={startedAt:new Date().toISOString(),runId,database,passed:false,stages:[],sourceFiles:validationInputHashes(),limitations:['Synthetic loopback data only','SMTP capture does not validate public delivery','Managed supabase_vault extension is not installed in the native test cluster']};
  const children=[],activeAPIs=[];let mail,created=false;
  const write=(name,value)=>fs.writeFileSync(path.join(reportDir,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});
  write('runtime-provenance.json',JSON.parse(fs.readFileSync(path.join(runtimeDir,'runtime-provenance.json'))));
  const stage=(name,detail={})=>{report.stages.push({name,at:new Date().toISOString(),...detail});log(name);};
  const pgConfig=db=>({host:'127.0.0.1',port:55432,user:privatePg.PGUSER,password:privatePg.PGPASSWORD,database:db});
  function assertDatabase(db){assert.ok(db==='postgres'||/^zonda_(test|restore)_[a-f0-9]{12,32}$/.test(db),'Database outside the synthetic allowlist.');}
  async function connectSql({database:db=database}={}){assertDatabase(db);const client=new Client(pgConfig(db));await client.connect();return client;}
  async function sql(query,params=[],{database:db=database}={}){const client=await connectSql({database:db});try{return(await client.query(query,params)).rows;}finally{await client.end();}}
  function start(name,command,args,env={},cwd=runtimeDir){
    const file=path.join(reportDir,name+'.log'),fd=fs.openSync(file,'a',0o600);
    const child=spawn(command,args,{env:{...process.env,...env},cwd,stdio:['ignore',fd,fd]});fs.closeSync(fd);
    child.label=name;child.intentionallyStopped=false;children.push(child);return child;
  }
  async function stop(child){
    if(child.intentionallyStopped)return;child.intentionallyStopped=true;
    if(child.exitCode!==null)return;
    child.kill(child.label==='postgres'?'SIGINT':'SIGTERM');
    await Promise.race([new Promise(resolve=>child.once('exit',resolve)),sleep(4000)]);
    if(child.exitCode===null)child.kill('SIGKILL');
  }
  async function ready(name,probe,maxMs=90000){
    const deadline=Date.now()+maxMs;
    while(Date.now()<deadline){
      const dead=children.find(child=>!child.intentionallyStopped&&child.exitCode!==null);
      if(dead)throw new Error(dead.label+' exited; inspect private local log.');
      try{if(await probe()){stage(name+' ready');return;}}catch{}
      await sleep(200);
    }
    throw new Error(name+' readiness timed out; inspect private local log.');
  }
  async function health(url){return(await fetch(url,{signal:AbortSignal.timeout(2000)})).ok;}
  async function psqlFile(file,{database:db=database,bootstrap=false}={}){
    assertDatabase(db);
    try{return(await exec(path.join(native.pgBin,'psql'),['-X','-v','ON_ERROR_STOP=1',...(bootstrap?['-c',"SET zonda.test_bootstrap='synthetic-only'"]:[]),'-f',file],{env:{...process.env,...privatePg,PGDATABASE:db},maxBuffer:8*1024*1024})).stdout;}
    catch(error){fs.writeFileSync(path.join(reportDir,'sql-error.log'),String(error.stderr||'SQL command failed'),{mode:0o600});throw new Error('Local SQL file failed: '+path.basename(file));}
  }
  async function catalog(db=database){const query=fs.readFileSync(path.join(appRoot,'scripts/schema-catalog.sql'),'utf8');return(await sql(query,[],{database:db}))[0].schema_metadata;}
  const {compareSchema}=await import(pathToFileURL(path.join(runtimeDir,'compare-schema.mjs')));
  async function stopRestoredServices(handle){
    if(handle.closed)return;handle.closed=true;
    if(handle.gateway){handle.gateway.closeAllConnections();await new Promise(resolve=>handle.gateway.close(resolve));}
    for(const child of [...handle.children].reverse())await stop(child);
  }
  async function startRestoredServices({database:db,storagePath,ports={auth:60099,storage:55100,rest:53100,gateway:54331},authOverrides={}}){
    assertDatabase(db);assert.notEqual(db,'postgres');
    const resolved=path.resolve(storagePath);assert.ok(resolved.startsWith(path.resolve(runtimeDir)+path.sep),'Storage must remain inside the disposable native directory.');
    fs.mkdirSync(resolved,{recursive:true,mode:0o700});
    const authEnv={...privateAuth,...authOverrides,GOTRUE_DB_DATABASE_URL:databaseUrlFor(privateAuth.GOTRUE_DB_DATABASE_URL,db),GOTRUE_API_HOST:'127.0.0.1',GOTRUE_API_PORT:String(ports.auth)};
    const storageEnv={...privateStorage,DATABASE_URL:databaseUrlFor(privateStorage.DATABASE_URL,db),SERVER_HOST:'127.0.0.1',SERVER_PORT:String(ports.storage),FILE_STORAGE_BACKEND_PATH:resolved,POSTGREST_URL:'http://127.0.0.1:'+ports.rest,STORAGE_PUBLIC_URL:'http://127.0.0.1:'+ports.storage};
    const handle={database:db,children:[],gateway:null,url:'http://127.0.0.1:'+ports.gateway,storageEnv,closed:false};activeAPIs.push(handle);
    handle.children.push(start(db+'-auth',path.join(runtimeDir,'auth/auth'),[],authEnv));
    await ready(db+' Auth',()=>health('http://127.0.0.1:'+ports.auth+'/health'));
    await sql(native.afterAuthSql,[],{database:db});
    handle.children.push(start(db+'-storage',process.execPath,['dist/start/server.js'],storageEnv,path.join(runtimeDir,'storage-image/app')));
    await ready(db+' Storage',()=>health('http://127.0.0.1:'+ports.storage+'/status'));
    handle.children.push(start(db+'-postgrest',path.join(runtimeDir,'postgrest/postgrest'),[],{
      PGRST_DB_URI:`postgresql://authenticator:${encodeURIComponent(privatePg.AUTHENTICATOR_PASSWORD)}@127.0.0.1:55432/${db}`,
      PGRST_DB_SCHEMAS:'public,storage',PGRST_DB_EXTRA_SEARCH_PATH:'public,extensions',PGRST_DB_ANON_ROLE:'anon',
      PGRST_JWT_SECRET:privateAuth.GOTRUE_JWT_SECRET,PGRST_SERVER_HOST:'127.0.0.1',PGRST_SERVER_PORT:String(ports.rest),PGRST_LOG_LEVEL:'error',
    }));
    await ready(db+' PostgREST',()=>health('http://127.0.0.1:'+ports.rest+'/'));
    handle.gateway=await localGateway({port:ports.gateway,ports,anonKey:privateStorage.ANON_KEY,serviceKey:privateStorage.SERVICE_KEY});
    return handle;
  }
  const privateRuntime={nativeRoot:runtimeDir,pgBin:native.pgBin,privatePgEnv:{...privatePg,PGDATABASE:database},storageAppPath:path.join(runtimeDir,'storage-image/app'),connectSql,sql,startRestoredServices,stopRestoredServices};
  try{
    const pg=native.nativeServices().find(service=>service.name==='postgres');start('postgres',pg.command,pg.args,pg.env,pg.cwd);
    await ready('PostgreSQL 17',async()=>{try{await sql('SELECT 1',[],{database:'postgres'});return true;}catch{return false;}});
    await sql('CREATE DATABASE "'+database+'"',[],{database:'postgres'});created=true;stage('Fresh synthetic database created');
    await sql('CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin; CREATE SCHEMA storage AUTHORIZATION supabase_storage_admin; CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions; CREATE EXTENSION "uuid-ossp" WITH SCHEMA extensions; CREATE EXTENSION pg_stat_statements WITH SCHEMA extensions; GRANT USAGE ON SCHEMA extensions TO anon,authenticated,service_role,authenticator;');
    await sql(native.managedRoleSql);
    mail=await startLocalAuthMailCapture({port:55525,authUrl:'http://127.0.0.1:59999',appUrl:'http://127.0.0.1:55526/zonda/'});
    const main=await startRestoredServices({database,storagePath:path.join(runtimeDir,'runs',runId,'storage'),ports:{auth:59999,storage:55000,rest:53000,gateway:54321},authOverrides:mail.authEnv});
    privateRuntime.storageEnv=main.storageEnv;
    const env={ZONDA_TEST_ENVIRONMENT:'test',ZONDA_TEST_MODE:'local',ZONDA_TEST_PROJECT_REF:'local-zonda-test',ZONDA_TEST_CONFIRM_REF:'local-zonda-test',ZONDA_TEST_URL:main.url,ZONDA_TEST_PUBLIC_KEY:privateStorage.ANON_KEY,ZONDA_TEST_SERVICE_KEY:privateStorage.SERVICE_KEY};
    const mailReport=await mail.run(env,{log:message=>log('auth: '+message)});write('auth-recovery-integration.json',mailReport);assert.ok(mailReport.passed,'Real Auth recovery/invitation checks failed.');stage('Real Auth SMTP recovery and invitation passed');
    const expected=JSON.parse(fs.readFileSync(path.join(appRoot,'tests/fixtures/schema-baseline-20261124.json')));
    const bootstrap=path.join(reportDir,'schema-bootstrap.sql');fs.writeFileSync(bootstrap,renderTestSchema(expected),{mode:0o600});await psqlFile(bootstrap,{bootstrap:true});
    const baseline=compareSchema(expected,await catalog());write('schema-baseline-comparison.json',baseline);assert.ok(baseline.passed,'Current baseline schema mismatch: '+baseline.differences.join(','));stage('Current production metadata baseline reproduced exactly');
    async function applyMigrations(label){for(const migration of MIGRATIONS){const file=path.join(appRoot,'supabase/migrations',migration+'.sql');await psqlFile(file);stage(label+' '+migration,{sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')});}}
    await applyMigrations('Applied locally');
    // A pre-use rollback is reversible. Once the append-only ledger records
    // work, restoring the old cascading FK would destroy that retention rule.
    for(const migration of [...MIGRATIONS].reverse())await psqlFile(path.join(appRoot,'supabase/rollback',ROLLBACK_FILES[migration]));
    const rolledBack=compareSchema(expected,await catalog());write('rollback-unused-comparison.json',rolledBack);assert.ok(rolledBack.passed,'Unused rollback schema mismatch: '+rolledBack.differences.join(','));stage('Pre-use rollback restored exact current baseline metadata');
    await applyMigrations('Reapplied locally');
    // The production backfill has existing document paths. A rollback that
    // drops their permanent registry must refuse even before any new app use.
    // Model those 34 ledger entries in an uncommitted synthetic transaction;
    // exercise the exact rollback body under a savepoint and preserve all rows.
    const seededClient=await connectSql();
    try{
      await seededClient.query('BEGIN');
      await seededClient.query("INSERT INTO zonda_private.document_paths(org_id,path,doc_id,study_id,doc_type) SELECT '00000000-0000-4000-8000-000000000034'::uuid,'synthetic_seed/doc_'||g||'/fixture.pdf','synthetic_doc_'||g,'synthetic_seed','protocolo' FROM generate_series(1,34) g");
      const ledgerQuery="SELECT count(*)::int AS n,md5(string_agg(row_to_json(h)::text,E'\\n' ORDER BY org_id,path)) AS hash FROM zonda_private.document_paths h";
      const before=(await seededClient.query(ledgerQuery)).rows;
      const catalogQuery=fs.readFileSync(path.join(appRoot,'scripts/schema-catalog.sql'),'utf8');
      const beforeSchema=(await seededClient.query(catalogQuery)).rows[0].schema_metadata;
      const down=fs.readFileSync(path.join(appRoot,'supabase/rollback',ROLLBACK_FILES['20261124002147_documentos_privados']),'utf8');
      assert.equal((down.match(/^begin;\s*$/gmi)||[]).length,1);assert.equal((down.match(/^commit;\s*$/gmi)||[]).length,1);
      const body=down.replace(/^begin;\s*$/mi,'').replace(/^commit;\s*$/mi,'');
      await seededClient.query('SAVEPOINT seeded_rollback_attempt');
      let guarded;
      try{await seededClient.query(body);}catch(error){guarded=error;}
      assert.ok(guarded,'Seeded document history rollback unexpectedly succeeded.');
      assert.match(guarded.message,/DOCUMENT_HISTORY_ROLLBACK_BLOCKED/);
      await seededClient.query('ROLLBACK TO SAVEPOINT seeded_rollback_attempt');
      assert.deepEqual((await seededClient.query(ledgerQuery)).rows,before);
      assert.deepEqual((await seededClient.query(catalogQuery)).rows[0].schema_metadata,beforeSchema);
      write('rollback-seeded-document-guard.json',{passed:true,syntheticHistoryRows:34,historyAndSchemaUnchanged:true,
        scenario:'Simulated pre-existing backfill entries; exact rollback body refuses to drop permanent document history'});
      stage('Rollback with 34 seeded document paths refused safely');
    }finally{await seededClient.query('ROLLBACK').catch(()=>{});await seededClient.end();}
    await sql("NOTIFY pgrst,'reload schema'");await sleep(500);
    const hardening=await runHardeningIntegration(env,{runtime:privateRuntime,log:message=>log('hardening: '+message)});write('hardening-integration.json',hardening);assert.ok(hardening.passed,'Hardening integration failed: '+hardening.error);stage('Real adversarial REST and SQL concurrency checks passed',{checks:hardening.checks.length});
    const administration=await runUserAdministrationIntegration(env,{preservedAuditOrganizations:hardening.syntheticOrganizations,
      localMailCapture:true,log:message=>log('administration: '+message)});
    write('user-administration-integration.json',administration);assert.ok(administration.passed,'Local user administration integration failed: '+administration.error);
    stage('Real user administration and ten-character temporary password passed',{checks:administration.checks.length});
    if(!skipBackup){
      const {runBackupRestore}=await import('./verify-supabase-backup-restore.mjs');
      const backup=await runBackupRestore(env,{runtime:privateRuntime,preservedAuditOrganizations:[...hardening.syntheticOrganizations,...administration.syntheticOrganizations]});write('backup-restore-integration.json',backup);assert.ok(backup.passed,'Synthetic backup/restore failed at '+(backup.failure?.stage||'unknown stage'));stage('Real database and binary backup/restore passed');
    }else report.limitations.push('Backup stage explicitly skipped for development; this is not a complete release validation.');
    const ledgerSql="SELECT count(*)::int AS n,md5(coalesce(string_agg(row_to_json(a)::text,E'\\n' ORDER BY id),'')) AS hash FROM public.ec_audit a";
    const historyBefore=await sql(ledgerSql),schemaBefore=await catalog();
    let guardedError;
    try{await sql(fs.readFileSync(path.join(appRoot,'supabase/rollback',ROLLBACK_FILES['20261124002135_auditoria_permisos']),'utf8'));}catch(error){guardedError=error;}
    assert.ok(guardedError,'Post-use audit rollback unexpectedly succeeded.');
    assert.match(guardedError.message,/ROLLBACK|AUDIT|HISTORY|LEDGER/,'Post-use rollback failed outside its retention guard.');
    assert.deepEqual(await sql(ledgerSql),historyBefore,'Post-use rollback altered append-only audit history.');
    assert.deepEqual(await catalog(),schemaBefore,'Rejected rollback changed the schema.');
    write('rollback-used-guard.json',{passed:true,sqlState:guardedError.code,historyRows:historyBefore[0].n,historyHash:historyBefore[0].hash,historyAndSchemaUnchanged:true});
    stage('Post-use rollback refused safely and preserved every audit row');
    assert.deepEqual(validationInputHashes(),report.sourceFiles,'Validation source files changed during the integration run.');
    report.passed=!skipBackup;
  }catch(error){report.error=error.message;log('Validation stopped: '+error.message);}
  finally{
    for(const handle of [...activeAPIs].reverse())await stopRestoredServices(handle).catch(()=>{});
    if(mail)await mail.close().catch(()=>{});
    if(created){try{await sql('DROP DATABASE "'+database+'" WITH (FORCE)',[],{database:'postgres'});stage('Synthetic source database removed');}catch{report.passed=false;report.cleanupError='Could not remove the generated synthetic source database.';}}
    for(const child of [...children].reverse())await stop(child);
    report.finishedAt=new Date().toISOString();write('full-runtime-report.json',report);
  }
  return {report,reportDir};
}

async function main(){
  if(!process.argv.includes('--execute')){console.log(JSON.stringify({purpose:'Real local Auth, Storage, SQL concurrency, backup and restore using synthetic data only',required:['--execute','--runtime-dir /absolute/native-runtime'],creates:'Two generated local databases and private temporary fixture files',production:'Blocked; no hosted endpoint or production rows are accepted'},null,2));return;}
  const i=process.argv.indexOf('--runtime-dir');assert.ok(i>=0&&process.argv[i+1],'Missing --runtime-dir');
  const result=await runFullLocalValidation({runtimeDir:path.resolve(process.argv[i+1]),skipBackup:process.argv.includes('--skip-backup')});
  console.log(JSON.stringify({passed:result.report.passed,reportDirectory:result.reportDir,error:result.report.error||null},null,2));
  if(!result.report.passed)process.exitCode=1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Local supervisor configuration failed. Inspect private runtime configuration.');process.exitCode=1;});

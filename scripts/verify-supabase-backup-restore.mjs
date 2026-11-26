/* Real backup/restore exercise for a disposable synthetic Supabase runtime.
 * Requires a supervisor that starts official Auth/Storage/PostgREST locally.
 * Imports are inert; there is no production or hosted execution mode.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createFixtureGraph, createSyntheticClient, sha256, SYNTHETIC_PDF } from './synthetic-supabase-fixtures.mjs';
import { validateTestConfig } from './verify-supabase-integration.mjs';

const here = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(here), '..');
export const RESTORE_PORTS = Object.freeze({ auth:60099, storage:55100, rest:53100, gateway:54331 });
const DATABASE_PATTERN = /^zonda_restore_[a-f0-9]{24}$/;
const MANAGED_SCHEMAS = ['public', 'auth', 'storage', 'zonda_private'];

export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
export function metadataHash(value) { return sha256(Buffer.from(canonicalJson(value))); }
export function quoteIdentifier(value) {
  assert.equal(typeof value, 'string');
  assert.ok(value && !value.includes('\0'), 'Invalid PostgreSQL identifier.');
  return '"' + value.replaceAll('"', '""') + '"';
}
export function validateRestoreDatabase(value) {
  assert.match(value, DATABASE_PATTERN, 'Restore database must have the generated local-only name.');
  return value;
}
function beneath(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function resolvedPath(value) {
  let current = path.resolve(value), tail = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    assert.notEqual(parent, current, 'Cannot resolve local path.');
    tail.unshift(path.basename(current)); current = parent;
  }
  return path.join(fs.realpathSync(current), ...tail);
}
export function assertSeparateStorageRoots(source, destination) {
  const left = resolvedPath(source), right = resolvedPath(destination);
  assert.ok(left !== right && !beneath(left, right) && !beneath(right, left), 'Source and restored Storage directories must be disjoint, including symlinks.');
  return right;
}
export function validateObjectRecord(record) {
  assert.equal(record.bucket_id, 'ec-docs', 'Only the synthetic private bucket is backed up.');
  assert.equal(typeof record.name, 'string');
  assert.ok(record.name.length > 0 && !record.name.includes('\\') && !record.name.includes('\0'));
  assert.ok(record.name.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe Storage object path.');
  assert.match(record.version, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i, 'A concrete Storage version is required.');
  return record;
}
export function verifyBlob(entry, bytes) {
  assert.equal(bytes.length, entry.bytes, 'Backup binary length mismatch.');
  assert.equal(sha256(bytes), entry.sha256, 'Backup binary SHA256 mismatch.');
}
export function validateManifest(manifest) {
  assert.equal(manifest.format,'zonda-synthetic-supabase-backup');
  assert.equal(manifest.version,1);
  assert.equal(manifest.sourceIsSynthetic,true);
  assert.equal(manifest.database?.file,'database.dump');
  assert.equal(manifest.database?.format,'pg_dump custom');
  assert.match(manifest.database?.sha256 || '',/^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(manifest.database.bytes) && manifest.database.bytes>0);
  assert.ok(Array.isArray(manifest.tables) && manifest.tables.length>0);
  const tableNames=new Set();
  for(const table of manifest.tables){
    assert.ok(MANAGED_SCHEMAS.includes(table.schema));
    assert.ok(typeof table.table==='string' && table.table);
    const key=table.schema+'.'+table.table;
    assert.ok(!tableNames.has(key),'Duplicate table in backup manifest.');tableNames.add(key);
    assert.ok(Number.isSafeInteger(table.count) && table.count>=0);
    assert.match(table.sha256,/^[a-f0-9]{64}$/);
  }
  assert.ok(Array.isArray(manifest.objects) && manifest.objects.length>0);
  const names=new Set(),files=new Set();
  for(const object of manifest.objects){
    validateObjectRecord(object.record);
    assert.match(object.file,/^binaries\/[0-9]{4}\.bin$/,'Unsafe backup binary filename.');
    assert.ok(!files.has(object.file),'Duplicate backup binary filename.');files.add(object.file);
    const key=object.record.bucket_id+'/'+object.record.name+'/'+object.record.version;
    assert.ok(!names.has(key),'Duplicate Storage object in backup manifest.');names.add(key);
    assert.ok(Number.isSafeInteger(object.bytes) && object.bytes>=0);
    assert.match(object.sha256,/^[a-f0-9]{64}$/);
    assert.equal(object.metadataSha256,metadataHash(object.record),'Backup object metadata SHA256 mismatch.');
  }
  return manifest;
}
function privateJson(filename, value) {
  fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n', { mode:0o600 });
  fs.chmodSync(filename, 0o600);
}
function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive:true, mode:0o700 });
  assert.equal(fs.lstatSync(directory).isSymbolicLink(), false, 'Private directory may not be a symlink.');
  fs.chmodSync(directory, 0o700);
}
async function fileHash(filename) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
async function command(commandPath, args, {env,cwd,logFile,timeout=120000}) {
  const logFd = fs.openSync(logFile, 'a', 0o600);
  fs.chmodSync(logFile, 0o600);
  const child = spawn(commandPath, args, { cwd,env,stdio:['ignore',logFd,logFd] });
  fs.closeSync(logFd);
  let timer;
  try {
    await new Promise((resolve,reject) => {
      child.once('error', () => reject(new Error('Local backup utility failed to start.')));
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('Local backup utility failed; inspect its private log.')));
      timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Local backup utility timed out.')); }, timeout);
    });
  } finally { clearTimeout(timer); }
}
async function inventory(runtime, database) {
  const tables = await runtime.sql(`select n.nspname as schema,c.relname as name from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname=any($1::text[]) and c.relkind in ('r','p')
    order by n.nspname,c.relname`, [MANAGED_SCHEMAS], {database});
  const result = [];
  for (const table of tables) {
    const rows = await runtime.sql(`select to_jsonb(t) as row from ${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)} t order by to_jsonb(t)::text`, [], {database});
    result.push({schema:table.schema,table:table.name,count:rows.length,sha256:metadataHash(rows.map(row => row.row))});
  }
  return result;
}
function equalInventory(expected, actual) {
  assert.equal(canonicalJson(actual), canonicalJson(expected), 'Restored table counts or canonical metadata hashes differ.');
}
function denied(result) { assert.ok([400,401,403,404].includes(result.status), 'A restored access control did not deny the request.'); }
export function assertUnrestoredBinaryResponse(result,{metadataVisible,binaryTreeEmpty}) {
  assert.equal(metadataVisible,true,'Missing bytes must not be confused with an invisible metadata row.');
  assert.equal(binaryTreeEmpty,true,'The restored physical Storage tree already contains files.');
  const missingObject = [400,404].includes(result.status)
    && ['NoSuchKey','NoSuchObject','NotFound'].includes(result.body?.code);
  // Storage 1.98.6's file backend exposes a raw fs.stat ENOENT as this exact
  // generic 500. Accept it only for the pre-restore absence probe, supported by
  // visible SQL metadata and an empty independent file tree. It is never an
  // accepted RLS denial, and the same API read must succeed after byte recovery.
  const localFileAbsent = result.status===500 && result.body?.statusCode==='500'
    && result.body?.code==='InternalError' && result.body?.error==='Internal'
    && result.body?.message==='Internal Server Error';
  assert.ok(!result.ok && (missingObject || localFileAbsent),'Unexpected response to the unrestored binary probe.');
}
function containsNoFiles(directory) {
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    assert.equal(entry.isSymbolicLink(),false,'A restored Storage directory contains a symlink.');
    if(!entry.isDirectory() || !containsNoFiles(path.join(directory,entry.name)))return false;
  }
  return true;
}

export function validateBackupRuntime(env, runtime) {
  const config = validateTestConfig(env);
  assert.equal(config.mode, 'local', 'Backup/restore verification is loopback-only.');
  assert.ok(runtime && typeof runtime === 'object', 'The local supervisor must supply runtime hooks.');
  for (const key of ['sql','startRestoredServices','stopRestoredServices']) assert.equal(typeof runtime[key], 'function', 'Missing local runtime hook: ' + key);
  const pg = runtime.privatePgEnv;
  assert.equal(pg?.PGHOST, '127.0.0.1');
  assert.equal(String(pg?.PGPORT), '55432');
  assert.match(pg?.PGDATABASE || '', /^zonda_test_[a-f0-9]{12,32}$/, 'The source must be a generated disposable test database.');
  assert.equal(pg?.PGUSER, 'postgres');
  assert.ok(pg.PGPASSWORD);
  assert.equal(runtime.storageEnv?.STORAGE_BACKEND, 'file');
  assert.ok(runtime.storageEnv?.TENANT_ID && runtime.storageEnv?.GLOBAL_S3_BUCKET);
  const storageDatabaseUrl = new URL(runtime.storageEnv.DATABASE_URL);
  assert.equal(storageDatabaseUrl.hostname,'127.0.0.1');
  assert.equal(storageDatabaseUrl.port,'55432');
  assert.equal(storageDatabaseUrl.pathname,'/'+pg.PGDATABASE);
  assert.ok(runtime.storageEnv.ANON_KEY===config.publicKey && runtime.storageEnv.SERVICE_KEY===config.serviceKey,
    'Source API and local Storage must share the same synthetic keys.');
  const nativeRoot = fs.realpathSync(runtime.nativeRoot);
  assert.ok(nativeRoot !== repositoryRoot && !beneath(repositoryRoot,nativeRoot), 'Private backups must stay outside the Git worktree.');
  for (const name of ['pg_dump','pg_restore']) fs.accessSync(path.join(runtime.pgBin,name),fs.constants.X_OK);
  fs.accessSync(path.join(runtime.storageAppPath,'dist/storage/backend/file.js'));
  return {...config,sourceDatabase:pg.PGDATABASE};
}

// Runs in a separate Node child with only the destination Storage configuration.
// It uses the unmodified official file backend to restore versioned object bytes
// and xattrs from API-downloaded backup files, never from the source data tree.
export async function restoreBinaryWorker(jobFile) {
  const jobRoot = fs.realpathSync(path.dirname(jobFile));
  const job = JSON.parse(fs.readFileSync(jobFile,'utf8'));
  const destination = assertSeparateStorageRoots(job.sourceStoragePath,job.destinationStoragePath);
  assert.equal(resolvedPath(process.env.FILE_STORAGE_BACKEND_PATH),destination, 'Worker Storage environment does not point to the restore destination.');
  assert.ok(beneath(jobRoot,destination), 'Restored files must stay within the private backup workspace.');
  assert.ok(Array.isArray(job.objects) && job.objects.length > 0);
  const require = createRequire(path.join(job.storageAppPath,'package.json'));
  const { FileBackend } = require(path.join(job.storageAppPath,'dist/storage/backend/file.js'));
  const { TenantLocation } = require(path.join(job.storageAppPath,'dist/storage/locator.js'));
  const backend = new FileBackend();
  const location = new TenantLocation(job.globalBucket);
  assert.equal(resolvedPath(backend.filePath),destination, 'Official backend resolved a different Storage directory.');
  try {
    for (const entry of job.objects) {
      validateObjectRecord(entry.record);
      assert.equal(entry.metadataSha256,metadataHash(entry.record),'Backup object metadata SHA256 mismatch.');
      assert.match(entry.file,/^binaries\/[0-9]{4}\.bin$/,'Unsafe backup binary filename.');
      const backupFile = resolvedPath(path.join(jobRoot,entry.file));
      assert.ok(beneath(jobRoot,backupFile), 'Backup filename escapes its private directory.');
      const bytes = fs.readFileSync(backupFile);
      verifyBlob(entry,bytes);
      const key = location.getKeyLocation({tenantId:job.tenantId,bucketId:entry.record.bucket_id,objectName:entry.record.name});
      const metadata = entry.record.metadata || {};
      await backend.uploadObject(job.globalBucket,key,entry.record.version,fs.createReadStream(backupFile),
        metadata.mimetype || 'application/octet-stream',metadata.cacheControl || 'no-cache',
        undefined,bytes.length,metadata.contentEncoding || undefined);
    }
  } finally { await backend.close(); }
}

export async function runBackupRestore(env,{runtime,preservedAuditOrganizations=[],log=()=>{}}={}) {
  const config = validateBackupRuntime(env,runtime);
  const sourceDatabase = config.sourceDatabase;
  const runId = 'zbr_' + randomUUID().replaceAll('-','');
  const database = validateRestoreDatabase('zonda_restore_' + randomUUID().replaceAll('-','').slice(0,24));
  const backupDir = path.join(fs.realpathSync(runtime.nativeRoot),'backups',runId);
  assert.ok(!fs.existsSync(backupDir), 'Backup run directory already exists.');
  assert.ok(beneath(fs.realpathSync(runtime.nativeRoot),resolvedPath(backupDir)), 'Backup parent directory escaped the native runtime.');
  privateDirectory(backupDir);
  assert.ok(beneath(fs.realpathSync(runtime.nativeRoot),fs.realpathSync(backupDir)), 'Backup workspace escaped the native runtime.');
  const destinationStoragePath = path.join(backupDir,'restored-storage');
  assertSeparateStorageRoots(runtime.storageEnv.FILE_STORAGE_BACKEND_PATH,destinationStoragePath);
  const binaryDir = path.join(backupDir,'binaries');
  privateDirectory(binaryDir);
  privateDirectory(destinationStoragePath);
  const dumpFile = path.join(backupDir,'database.dump');
  const report = {runId,startedAt:new Date().toISOString(),passed:false,
    scope:'Synthetic local Auth, application SQL and private Storage; no production data',
    checks:[],cleanup:[],preservedAuditOrganizations:[...preservedAuditOrganizations],
    limitations:['Local file backend restore; not a hosted disaster-recovery timing guarantee',
      'PostgreSQL roles already exist in the same local cluster; pg_dump does not back up cluster-global role passwords',
      'Auth table hashes are reconciled before new restored logins modify session state']};
  let graph,handle,createdDatabase=false,stage='verify empty synthetic source';
  const check = label => { report.checks.push({label,status:'passed'}); log('OK: '+label); };
  try {
    const existingObjects = await runtime.sql('select count(*)::int as count from storage.objects',[],{database:sourceDatabase});
    assert.equal(existingObjects[0].count,0,'The local source must not contain Storage objects from another run.');
    const otherBuckets = await runtime.sql("select count(*)::int as count from storage.buckets where id <> 'ec-docs'",[],{database:sourceDatabase});
    assert.equal(otherBuckets[0].count,0,'Unrecognized local bucket found.');
    graph = await createFixtureGraph(env,{preservedAuditOrganizations});
    const orgA = await graph.organization('backup-a'), orgB = await graph.organization('backup-b');
    const studyA = await graph.study(orgA,'allowed'), hiddenStudy = await graph.study(orgA,'restricted'), studyB = await graph.study(orgB,'other-site');
    const adminA = await graph.actor('admin-a','admin',orgA,[]);
    const adminB = await graph.actor('admin-b','admin',orgB,[]);
    const doctorA = await graph.actor('doctor-a','medico',orgA,[studyA]);
    const billingA = await graph.actor('billing-a','medico',orgA,[studyA],{billing:true});
    const doctorB = await graph.actor('doctor-b','medico',orgB,[studyB]);
    const actors = {adminA,adminB,doctorA,billingA,doctorB};
    const fixtureBytes = label => Buffer.concat([SYNTHETIC_PDF,Buffer.from('\nSynthetic backup '+label+'\n')]);
    const protocolA = await graph.document('protocol-a',orgA,studyA,adminA,{bytes:fixtureBytes('protocol-a')});
    const restricted = await graph.document('restricted',orgA,hiddenStudy,adminA,{bytes:fixtureBytes('restricted')});
    const contract = await graph.document('contract',orgA,studyA,adminA,{type:'contrato',bytes:fixtureBytes('contract')});
    const protocolB = await graph.document('protocol-b',orgB,studyB,adminB,{bytes:fixtureBytes('protocol-b')});
    const documents = [protocolA,restricted,contract,protocolB];
    const patientId = graph.runId+'_synthetic_patient';
    for (const [kind,id,data] of [
      ['patients',patientId,{estudioId:studyA,iniciales:'ZZ',screening:'SYNTHETIC-001'}],
      ['visits',graph.runId+'_visit',{estudioId:studyA,pacienteId:patientId,nota:'Synthetic restore fixture'}],
      ['records',graph.runId+'_record',{estudioId:studyA,pacienteId:patientId,recordType:'synthetic_note'}],
      ['checklists',graph.runId+'_checklist',{estudioId:studyA,items:['Synthetic check']}],
      ['settings',graph.runId+'_setting',{estudioId:studyA,valor:'Synthetic setting'}],
    ]) graph.api.ok(await graph.api.save(adminA,kind,id,{id,...data}),'Create synthetic backup record');
    check('Two sites, five real Auth accounts, eleven application tables and four private documents seeded synthetically');

    stage='download binary backup through Storage API';
    const objectRows = await runtime.sql('select to_jsonb(o) as row from storage.objects o order by bucket_id,name,version',[],{database:sourceDatabase});
    assert.equal(objectRows.length,documents.length);
    const objects = [];
    for (const [index,{row:record}] of objectRows.entries()) {
      validateObjectRecord(record);
      const fixture = documents.find(document => document.name === record.name);
      assert.ok(fixture && graph.state.objects.has(record.name),'Nonfixture object cannot enter a backup.');
      const downloaded = await graph.api.download(graph.api.service,record.name);
      graph.api.ok(downloaded,'Download backup bytes from Storage API');
      assert.deepEqual(downloaded.raw,fixture.bytes,'Source bytes do not match the synthetic fixture.');
      const file = 'binaries/'+String(index).padStart(4,'0')+'.bin';
      fs.writeFileSync(path.join(backupDir,file),downloaded.raw,{mode:0o600});
      objects.push({record,file,bytes:downloaded.raw.length,sha256:sha256(downloaded.raw),metadataSha256:metadataHash(record)});
    }
    check('Every Storage object downloaded through the API and reconciled to known synthetic bytes');

    stage='full PostgreSQL custom-format dump';
    const beforeDump = await inventory(runtime,sourceDatabase);
    fs.writeFileSync(dumpFile,'',{mode:0o600});
    await command(path.join(runtime.pgBin,'pg_dump'),['--format=custom','--compress=6','--file='+dumpFile],{
      env:{...process.env,...runtime.privatePgEnv,PGDATABASE:sourceDatabase},cwd:backupDir,logFile:path.join(backupDir,'pg-dump.log')});
    fs.chmodSync(dumpFile,0o600);
    const dumpSha256 = await fileHash(dumpFile);
    equalInventory(beforeDump,await inventory(runtime,sourceDatabase));
    const manifest = {format:'zonda-synthetic-supabase-backup',version:1,createdAt:new Date().toISOString(),runId,
      database:{file:'database.dump',sha256:dumpSha256,bytes:fs.statSync(dumpFile).size,format:'pg_dump custom'},
      tables:beforeDump,objects,sourceIsSynthetic:true};
    privateJson(path.join(backupDir,'manifest.json'),manifest);
    validateManifest(JSON.parse(fs.readFileSync(path.join(backupDir,'manifest.json'),'utf8')));
    report.backup = {dumpSha256,dumpBytes:manifest.database.bytes,objectCount:objects.length,
      binaryBytes:objects.reduce((total,object)=>total+object.bytes,0),manifestSha256:await fileHash(path.join(backupDir,'manifest.json')),
      tables:beforeDump.map(({schema,table,count})=>({schema,table,count}))};
    check('Full Auth/public/Storage database dump and private SHA256 manifest created; source remained stable');

    stage='restore into a new local database';
    assert.equal(await fileHash(path.join(backupDir,'manifest.json')),report.backup.manifestSha256,'Backup manifest checksum mismatch.');
    assert.equal((await runtime.sql('select datname from pg_database where datname=$1',[database],{database:'postgres'})).length,0);
    await runtime.sql('create database '+quoteIdentifier(database)+' template template0',[],{database:'postgres'});
    createdDatabase=true;
    assert.equal(await fileHash(dumpFile),manifest.database.sha256,'Database dump checksum mismatch.');
    await command(path.join(runtime.pgBin,'pg_restore'),['--exit-on-error','--single-transaction','--dbname='+database,dumpFile],{
      env:{...process.env,...runtime.privatePgEnv,PGDATABASE:database},cwd:backupDir,logFile:path.join(backupDir,'pg-restore.log')});
    equalInventory(beforeDump,await inventory(runtime,database));
    check('pg_restore preserved every application, Auth and Storage table count and canonical metadata hash');

    stage='start independent restored services';
    handle = await runtime.startRestoredServices({database,storagePath:destinationStoragePath,ports:RESTORE_PORTS});
    const restoredUrl = new URL(handle.url);
    assert.equal(restoredUrl.hostname,'127.0.0.1');
    assert.equal(restoredUrl.port,String(RESTORE_PORTS.gateway));
    assert.notEqual(restoredUrl.origin,config.url);
    const restoredApi = createSyntheticClient({...env,ZONDA_TEST_URL:restoredUrl.origin});
    const restoredActors={};
    for (const [label,actor] of Object.entries(actors)) {
      const login = await restoredApi.login(actor.email,actor.password);
      assert.equal(login.user.id,actor.id);
      const restoredActor={...actor,token:login.access_token};
      const verified=restoredApi.ok(await restoredApi.request('/auth/v1/user',{actor:restoredActor}),'Validate restored JWT with Auth');
      assert.equal(verified.id,actor.id);
      restoredActors[label]=restoredActor;
    }
    check('All five restored password hashes support real Auth login and verified JWT identities');
    stage='verify isolated restored Storage has no binaries';
    const visibleBeforeRecovery=restoredApi.ok(await restoredApi.request('/rest/v1/ec_docs?select=id&id=eq.'+encodeURIComponent(protocolA.id),
      {actor:restoredActors.doctorA}),'Verify restored metadata before binary recovery');
    assert.deepEqual(visibleBeforeRecovery.map(row=>row.id),[protocolA.id]);
    const missing=await restoredApi.download(restoredActors.doctorA,protocolA.name);
    privateJson(path.join(backupDir,'pre-recovery-probe.json'),{status:missing.status,body:missing.body,metadataVisible:true,binaryTreeEmpty:containsNoFiles(destinationStoragePath)});
    assertUnrestoredBinaryResponse(missing,{metadataVisible:true,binaryTreeEmpty:containsNoFiles(destinationStoragePath)});
    graph.api.ok(await graph.api.download(doctorA,protocolA.name),'Original object remains present');
    check('Restored database cannot read original bytes before binary recovery: independent Storage root verified');

    stage='restore versioned binaries with the official file backend';
    const jobFile=path.join(backupDir,'binary-restore-job.json');
    privateJson(jobFile,{sourceStoragePath:runtime.storageEnv.FILE_STORAGE_BACKEND_PATH,destinationStoragePath,
      storageAppPath:runtime.storageAppPath,tenantId:runtime.storageEnv.TENANT_ID,
      globalBucket:runtime.storageEnv.GLOBAL_S3_BUCKET,objects});
    const storageDatabaseUrl=new URL(runtime.storageEnv.DATABASE_URL);
    assert.equal(storageDatabaseUrl.hostname,'127.0.0.1');
    storageDatabaseUrl.pathname='/'+database;
    await command(process.execPath,[here,'--restore-binary-worker',jobFile],{
      env:{...process.env,...runtime.storageEnv,FILE_STORAGE_BACKEND_PATH:destinationStoragePath,DATABASE_URL:storageDatabaseUrl.href},
      cwd:runtime.storageAppPath,logFile:path.join(backupDir,'binary-restore.log')});
    for (const object of objects) {
      verifyBlob(object,fs.readFileSync(path.join(backupDir,object.file)));
      const restored=await restoredApi.download(restoredApi.service,object.record.name);
      restoredApi.ok(restored,'Download independently restored bytes');
      verifyBlob(object,restored.raw);
    }
    check('All recovered binaries match backup SHA256 and byte counts through the second Storage API');

    stage='verify restored RLS and metadata';
    async function visibleDocs(actor,expected) {
      const rows=restoredApi.ok(await restoredApi.request('/rest/v1/ec_docs?select=id&order=id',{actor}),'Read restored metadata under RLS');
      assert.deepEqual(rows.map(row=>row.id).sort(),expected.map(document=>document.id).sort());
    }
    await visibleDocs(restoredActors.doctorA,[protocolA]);
    await visibleDocs(restoredActors.billingA,[protocolA,contract]);
    await visibleDocs(restoredActors.adminA,[protocolA,restricted,contract]);
    await visibleDocs(restoredActors.doctorB,[protocolB]);
    for (const document of [restricted,contract,protocolB]) denied(await restoredApi.download(restoredActors.doctorA,document.name));
    denied(await restoredApi.download(restoredActors.doctorB,protocolA.name));
    denied(await restoredApi.download(restoredApi.anonymous,protocolA.name));
    verifyBlob(objects.find(object=>object.record.name===contract.name),(await restoredApi.download(restoredActors.billingA,contract.name)).raw);
    const forged=restoredActors.doctorA.token.split('.');
    forged[2]=(forged[2][0]==='a'?'b':'a')+forged[2].slice(1);
    denied(await restoredApi.request('/auth/v1/user',{actor:{...restoredActors.doctorA,token:forged.join('.')}}));
    equalInventory(beforeDump.filter(row=>row.schema!=='auth'),(await inventory(runtime,database)).filter(row=>row.schema!=='auth'));
    check('Restored JWT enforcement, site/study/contract RLS and complete application/Storage metadata integrity verified');
    report.passed=true;
  } catch(error) {
    privateJson(path.join(backupDir,'failure-private.json'),{stage,name:error.name,message:error.message,stack:error.stack});
    report.failure={stage,message:'Verification failed; inspect the private diagnostic file.'};
  } finally {
    const cleanup=async(label,fn)=>{
      try { await fn();report.cleanup.push({label,status:'passed'}); }
      catch { report.cleanup.push({label,status:'failed'});report.passed=false; }
    };
    if(handle)await cleanup('Stop second Auth/Storage/PostgREST/gateway',()=>runtime.stopRestoredServices(handle));
    if(createdDatabase)await cleanup('Remove only the generated restored database',async()=>{
      validateRestoreDatabase(database);
      await runtime.sql('select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()',[database],{database:'postgres'});
      await runtime.sql('drop database '+quoteIdentifier(database),[],{database:'postgres'});
    });
    if(graph){
      await cleanup('Clean source fixtures while retaining append-only audit',async()=>{
        const results=await graph.cleanup();
        report.cleanup.push(...results.map(result=>({label:result.name,status:result.status})));
        assert.ok(results.every(result=>result.status==='passed'),'Some synthetic source fixtures could not be cleaned.');
      });
      report.preservedAuditOrganizations=[...new Set([...preservedAuditOrganizations,...graph.state.orgs])];
    }
    report.finishedAt=new Date().toISOString();
    privateJson(path.join(backupDir,'verification-report.json'),report);
  }
  return report;
}

if(process.argv[1] && path.resolve(process.argv[1])===here){
  if(process.argv[2]==='--restore-binary-worker' && process.argv.length===4){
    try { await restoreBinaryWorker(path.resolve(process.argv[3])); }
    catch(error){
      privateJson(path.join(path.dirname(path.resolve(process.argv[3])),'worker-failure-private.json'),{name:error.name,message:error.message,stack:error.stack});
      console.error('Synthetic binary restore worker failed; inspect its private diagnostic.');process.exitCode=1;
    }
  }else console.log('Import runBackupRestore(env, { runtime, preservedAuditOrganizations }) from the disposable local supervisor. No requests performed.');
}

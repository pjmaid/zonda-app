const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const modulePromise=import(pathToFileURL(path.resolve(__dirname,'../scripts/verify-supabase-backup-restore.mjs')).href);
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function temporary(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'zonda-backup-unit-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return directory;}
const record=()=>({id:'synthetic-object',bucket_id:'ec-docs',name:'org/study/doc/fixture.pdf',version:'11111111-1111-4111-8111-111111111111',metadata:{mimetype:'application/pdf',cacheControl:'no-cache'}});
function keys(){
  const key=role=>'e30.'+Buffer.from(JSON.stringify({role,ref:'local-zonda-test'})).toString('base64url')+'.synthetic-signature';
  return {public:key('anon'),service:key('service_role')};
}
function fixtureRuntime(t){
  const root=temporary(t), pgBin=path.join(root,'pg-bin'),storageAppPath=path.join(root,'app');
  fs.mkdirSync(pgBin);fs.mkdirSync(path.join(storageAppPath,'dist/storage/backend'),{recursive:true});
  for(const name of ['pg_dump','pg_restore'])fs.writeFileSync(path.join(pgBin,name),'#!/bin/sh\nexit 99\n',{mode:0o700});
  fs.writeFileSync(path.join(storageAppPath,'dist/storage/backend/file.js'),'');
  fs.mkdirSync(path.join(root,'source-storage'));
  const pair=keys(),database='zonda_test_0123456789abcdef01234567';
  const env={ZONDA_TEST_ENVIRONMENT:'test',ZONDA_TEST_MODE:'local',ZONDA_TEST_PROJECT_REF:'local-zonda-test',ZONDA_TEST_CONFIRM_REF:'local-zonda-test',ZONDA_TEST_URL:'http://127.0.0.1:54321',ZONDA_TEST_PUBLIC_KEY:pair.public,ZONDA_TEST_SERVICE_KEY:pair.service};
  let calls=0;
  const runtime={nativeRoot:root,pgBin,storageAppPath,privatePgEnv:{PGHOST:'127.0.0.1',PGPORT:'55432',PGUSER:'postgres',PGDATABASE:database,PGPASSWORD:'unit-fixture-placeholder'},
    storageEnv:{STORAGE_BACKEND:'file',TENANT_ID:'local-zonda-test',GLOBAL_S3_BUCKET:'fixture-files',FILE_STORAGE_BACKEND_PATH:path.join(root,'source-storage'),DATABASE_URL:'postgres://fixture:unit-placeholder@127.0.0.1:55432/'+database,ANON_KEY:pair.public,SERVICE_KEY:pair.service},
    sql:async()=>{calls++;return [];},startRestoredServices:async()=>{calls++;},stopRestoredServices:async()=>{calls++;}};
  return {root,env,runtime,calls:()=>calls};
}

test('backup metadata hashing ignores object key order but detects meaningful changes',async()=>{
  const {metadataHash}=await modulePromise;
  assert.equal(metadataHash({b:[{y:2,x:1}],a:null}),metadataHash({a:null,b:[{x:1,y:2}]}));
  assert.notEqual(metadataHash({role:'medico'}),metadataHash({role:'admin'}));
});

test('restore database names cannot select production, the source or injected SQL',async()=>{
  const {validateRestoreDatabase,quoteIdentifier}=await modulePromise;
  assert.equal(validateRestoreDatabase('zonda_restore_'+'a'.repeat(24)),'zonda_restore_'+'a'.repeat(24));
  for(const value of ['postgres','zonda_test_'+'a'.repeat(24),'zonda_restore_x;drop database postgres','zonda_restore_'+'a'.repeat(25)])assert.throws(()=>validateRestoreDatabase(value));
  assert.equal(quoteIdentifier('name"part'),'"name""part"');
  assert.throws(()=>quoteIdentifier('a\0b'));
});

test('Storage restore directories must be disjoint even through symlinks',async t=>{
  const {assertSeparateStorageRoots}=await modulePromise,root=temporary(t),source=path.join(root,'source');
  fs.mkdirSync(source);fs.symlinkSync(source,path.join(root,'alias'));
  assert.equal(assertSeparateStorageRoots(source,path.join(root,'restored')),path.join(root,'restored'));
  for(const destination of [source,path.join(source,'nested'),root,path.join(root,'alias','nested')])assert.throws(()=>assertSeparateStorageRoots(source,destination),/disjoint/);
});

test('only concrete safe synthetic object versions enter the backup',async()=>{
  const {validateObjectRecord}=await modulePromise;
  assert.equal(validateObjectRecord(record()).bucket_id,'ec-docs');
  for(const name of ['../original','org/../original','/absolute','org\\file','org//file','org/./file'])assert.throws(()=>validateObjectRecord({...record(),name}));
  assert.throws(()=>validateObjectRecord({...record(),bucket_id:'unrecognized'}));
  assert.throws(()=>validateObjectRecord({...record(),version:null}));
});

test('binary verification catches both truncation and same-length corruption',async()=>{
  const {verifyBlob}=await modulePromise,bytes=Buffer.from('synthetic bytes'),entry={bytes:bytes.length,sha256:digest(bytes)};
  verifyBlob(entry,bytes);
  assert.throws(()=>verifyBlob(entry,bytes.subarray(1)),/length/);
  assert.throws(()=>verifyBlob(entry,Buffer.from('Synthetic bytes')),/SHA256/);
});

test('pre-recovery probe distinguishes missing local bytes from permission or server failures',async()=>{
  const {assertUnrestoredBinaryResponse}=await modulePromise;
  const evidence={metadataVisible:true,binaryTreeEmpty:true};
  const absent={ok:false,status:500,body:{statusCode:'500',code:'InternalError',error:'Internal',message:'Internal Server Error'}};
  assertUnrestoredBinaryResponse(absent,evidence);
  assertUnrestoredBinaryResponse({ok:false,status:404,body:{code:'NoSuchKey'}},evidence);
  assert.throws(()=>assertUnrestoredBinaryResponse(absent,{...evidence,metadataVisible:false}),/metadata/);
  assert.throws(()=>assertUnrestoredBinaryResponse(absent,{...evidence,binaryTreeEmpty:false}),/already contains/);
  assert.throws(()=>assertUnrestoredBinaryResponse({ok:false,status:500,body:{message:'database unavailable'}},evidence),/Unexpected/);
  assert.throws(()=>assertUnrestoredBinaryResponse({ok:false,status:403,body:{code:'AccessDenied'}},evidence),/Unexpected/);
  assert.throws(()=>assertUnrestoredBinaryResponse({ok:true,status:200,body:null},evidence),/Unexpected/);
});

test('manifest validates binary paths, object metadata hashes and uniqueness',async()=>{
  const {metadataHash,validateManifest}=await modulePromise;
  const make=()=>({format:'zonda-synthetic-supabase-backup',version:1,sourceIsSynthetic:true,database:{file:'database.dump',format:'pg_dump custom',bytes:20,sha256:'a'.repeat(64)},tables:[{schema:'public',table:'ec_docs',count:1,sha256:'b'.repeat(64)}],objects:[{record:record(),file:'binaries/0000.bin',bytes:3,sha256:digest(Buffer.from('abc')),metadataSha256:metadataHash(record())}]});
  validateManifest(make());
  const tampered=make();tampered.objects[0].record.name='org/other/file.pdf';assert.throws(()=>validateManifest(tampered),/metadata SHA256/);
  const outside=make();outside.objects[0].file='../outside.bin';assert.throws(()=>validateManifest(outside),/Unsafe/);
  const duplicate=make();duplicate.objects.push({...duplicate.objects[0]});assert.throws(()=>validateManifest(duplicate),/Duplicate/);
  const unknown=make();unknown.sourceIsSynthetic=false;assert.throws(()=>validateManifest(unknown));
});

test('backup runtime rejects hosted destinations and persistent databases before hooks execute',async t=>{
  const {validateBackupRuntime,runBackupRestore}=await modulePromise,fixture=fixtureRuntime(t);
  assert.equal(validateBackupRuntime(fixture.env,fixture.runtime).sourceDatabase,fixture.runtime.privatePgEnv.PGDATABASE);
  assert.throws(()=>validateBackupRuntime({...fixture.env,ZONDA_TEST_URL:'https://example.invalid'},fixture.runtime));
  const invalid={...fixture.runtime,privatePgEnv:{...fixture.runtime.privatePgEnv,PGDATABASE:'postgres'}};
  await assert.rejects(runBackupRestore(fixture.env,{runtime:invalid}),/disposable/);
  assert.equal(fixture.calls(),0);
  assert.equal(fs.existsSync(path.join(fixture.root,'backups')),false);
});

test('backup runtime refuses a Storage database or key different from the source',async t=>{
  const {validateBackupRuntime}=await modulePromise,fixture=fixtureRuntime(t);
  assert.throws(()=>validateBackupRuntime(fixture.env,{...fixture.runtime,storageEnv:{...fixture.runtime.storageEnv,DATABASE_URL:'postgres://fixture:placeholder@127.0.0.1:55432/postgres'}}));
  assert.throws(()=>validateBackupRuntime(fixture.env,{...fixture.runtime,storageEnv:{...fixture.runtime.storageEnv,SERVICE_KEY:'different-unit-placeholder'}}),/synthetic keys/);
  assert.equal(fixture.calls(),0);
});

test('binary restore worker rejects mismatched destination before loading a backend',async t=>{
  const {restoreBinaryWorker}=await modulePromise,root=temporary(t),source=path.join(root,'source'),jobRoot=path.join(root,'backup');
  fs.mkdirSync(source);fs.mkdirSync(jobRoot);const destination=path.join(jobRoot,'restored');fs.mkdirSync(destination);
  const job=path.join(jobRoot,'job.json');fs.writeFileSync(job,JSON.stringify({sourceStoragePath:source,destinationStoragePath:destination,objects:[{}]}));
  const previous=process.env.FILE_STORAGE_BACKEND_PATH;process.env.FILE_STORAGE_BACKEND_PATH=source;
  try{await assert.rejects(restoreBinaryWorker(job),/environment/);}finally{if(previous===undefined)delete process.env.FILE_STORAGE_BACKEND_PATH;else process.env.FILE_STORAGE_BACKEND_PATH=previous;}
  assert.equal(fs.readdirSync(destination).length,0);
});

test('binary worker supplies the backed-up version and bytes without reading the source data tree',async t=>{
  const {restoreBinaryWorker,metadataHash}=await modulePromise,root=temporary(t),source=path.join(root,'source'),jobRoot=path.join(root,'backup'),app=path.join(root,'app');
  fs.mkdirSync(source);fs.writeFileSync(path.join(source,'original.txt'),'original sentinel must not be copied');
  fs.mkdirSync(path.join(jobRoot,'binaries'),{recursive:true});const destination=path.join(jobRoot,'restored');fs.mkdirSync(destination);
  fs.mkdirSync(path.join(app,'dist/storage/backend'),{recursive:true});fs.writeFileSync(path.join(app,'package.json'),'{}');
  // Unit-only adapter spy. The real integration run imports the official
  // Supabase FileBackend; this spy checks our worker's arguments and boundaries.
  fs.writeFileSync(path.join(app,'dist/storage/backend/file.js'),`const fs=require('node:fs'),path=require('node:path');exports.FileBackend=class{constructor(){this.filePath=process.env.FILE_STORAGE_BACKEND_PATH;}async uploadObject(bucket,key,version,stream,mime,cache,signal,length){const chunks=[];for await(const chunk of stream)chunks.push(chunk);fs.writeFileSync(path.join(this.filePath,'observed.json'),JSON.stringify({bucket,key,version,mime,cache,length,bytes:Buffer.concat(chunks).toString()}));}close(){}};`);
  fs.writeFileSync(path.join(app,'dist/storage/locator.js'),`exports.TenantLocation=class{getKeyLocation({tenantId,bucketId,objectName}){return tenantId+'/'+bucketId+'/'+objectName;}};`);
  const bytes=Buffer.from('API-downloaded backup bytes');fs.writeFileSync(path.join(jobRoot,'binaries/0000.bin'),bytes);
  const object={record:record(),file:'binaries/0000.bin',bytes:bytes.length,sha256:digest(bytes),metadataSha256:metadataHash(record())};
  const job=path.join(jobRoot,'job.json');fs.writeFileSync(job,JSON.stringify({sourceStoragePath:source,destinationStoragePath:destination,storageAppPath:app,tenantId:'local-test',globalBucket:'fixture-files',objects:[object]}));
  const previous=process.env.FILE_STORAGE_BACKEND_PATH;process.env.FILE_STORAGE_BACKEND_PATH=destination;
  try{await restoreBinaryWorker(job);}finally{if(previous===undefined)delete process.env.FILE_STORAGE_BACKEND_PATH;else process.env.FILE_STORAGE_BACKEND_PATH=previous;}
  const observed=JSON.parse(fs.readFileSync(path.join(destination,'observed.json')));
  assert.equal(observed.bytes,bytes.toString());assert.equal(observed.version,record().version);
  assert.equal(observed.key,'local-test/ec-docs/'+record().name);assert.equal(observed.length,bytes.length);
  assert.equal(fs.readFileSync(path.join(source,'original.txt'),'utf8'),'original sentinel must not be copied');
});

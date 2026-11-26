const test=require('node:test');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const path=require('node:path');

test('full validation is a dry plan unless --execute is supplied',()=>{
  const raw=execFileSync(process.execPath,[path.join(__dirname,'../scripts/verify-local-supabase-full.mjs')],{encoding:'utf8'});
  const plan=JSON.parse(raw);
  assert.match(plan.production,/Blocked/);
  assert.deepEqual(plan.required,['--execute','--runtime-dir /absolute/native-runtime']);
});
test('native driver rejects hosted PostgreSQL and unexpected management databases',async()=>{
  const {validateNativeOptions}=await import('../scripts/verify-local-supabase-full.mjs');
  const valid={runtimeDir:'/tmp/synthetic-native',pgEnv:{PGHOST:'127.0.0.1',PGPORT:'55432',PGUSER:'postgres',PGDATABASE:'postgres'}};
  assert.doesNotThrow(()=>validateNativeOptions(valid));
  for(const changes of [{PGHOST:'example.supabase.co'},{PGPORT:'5432'},{PGUSER:'service_role'},{PGDATABASE:'production'}])
    assert.throws(()=>validateNativeOptions({...valid,pgEnv:{...valid.pgEnv,...changes}}));
});
test('database URL rewriting accepts only generated local source and restore databases',async()=>{
  const {databaseUrlFor}=await import('../scripts/verify-local-supabase-full.mjs');
  const fixture='postgresql://fixture:synthetic-only@127.0.0.1:55432/postgres';
  assert.equal(new URL(databaseUrlFor(fixture,'zonda_test_0123456789abcdef')).pathname,'/zonda_test_0123456789abcdef');
  assert.throws(()=>databaseUrlFor(fixture,'postgres'));
  assert.throws(()=>databaseUrlFor(fixture,'zonda_test_x;DROP DATABASE postgres'));
  assert.throws(()=>databaseUrlFor('postgresql://fixture:synthetic-only@db.example.supabase.co:55432/postgres','zonda_restore_0123456789abcdef'));
});
test('synthetic API client rejects production or hosted modes before any request',async()=>{
  const {createSyntheticClient}=await import('../scripts/synthetic-supabase-fixtures.mjs');
  let calls=0;
  const jwt=role=>['eyJhbGciOiJIUzI1NiJ9',Buffer.from(JSON.stringify({role,ref:'local-zonda-test'})).toString('base64url'),'synthetic-signature'].join('.');
  const env={ZONDA_TEST_ENVIRONMENT:'test',ZONDA_TEST_MODE:'local',ZONDA_TEST_PROJECT_REF:'local-zonda-test',ZONDA_TEST_CONFIRM_REF:'local-zonda-test',ZONDA_TEST_URL:'http://127.0.0.1:54321',ZONDA_TEST_PUBLIC_KEY:jwt('anon'),ZONDA_TEST_SERVICE_KEY:jwt('service_role')};
  assert.doesNotThrow(()=>createSyntheticClient(env,{fetchImpl:()=>{calls++;}}));
  assert.throws(()=>createSyntheticClient({...env,ZONDA_TEST_URL:'https://aqinxboxjklsyvesdcyr.supabase.co'},{fetchImpl:()=>{calls++;}}));
  assert.throws(()=>createSyntheticClient({...env,ZONDA_TEST_MODE:'hosted'},{fetchImpl:()=>{calls++;}}));
  assert.equal(calls,0);
});

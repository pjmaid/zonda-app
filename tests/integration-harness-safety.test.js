const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const moduleUrl=pathToFileURL(path.resolve(__dirname,'../scripts/verify-supabase-integration.mjs')).href;
const jwt=body=>'test.'+Buffer.from(JSON.stringify(body)).toString('base64url')+'.testsignature';
const valid=()=>({ZONDA_TEST_ENVIRONMENT:'test',ZONDA_TEST_PROJECT_REF:'abcdefghijklmnopqrst',ZONDA_TEST_CONFIRM_REF:'abcdefghijklmnopqrst',
  ZONDA_TEST_URL:'https://abcdefghijklmnopqrst.supabase.co/',ZONDA_TEST_PUBLIC_KEY:jwt({role:'anon',ref:'abcdefghijklmnopqrst'}),
  ZONDA_TEST_SERVICE_KEY:jwt({role:'service_role',ref:'abcdefghijklmnopqrst'})});

test('harness reconoce solo NoSuchBucket preciso detrás de HTTP 400',async()=>{
  const {isMissingStorageBucket}=await import(moduleUrl);
  const missing={statusCode:'404',code:'NoSuchBucket',error:'NoSuchBucket',message:'Bucket not found'};
  assert.equal(isMissingStorageBucket({status:400,body:missing}),true);
  assert.equal(isMissingStorageBucket({status:400,body:{...missing,error:'Bucket not found'}}),true);
  assert.equal(isMissingStorageBucket({status:404,body:missing}),true);
  for(const status of [401,403,500]) assert.equal(isMissingStorageBucket({status,body:missing}),false);
  assert.equal(isMissingStorageBucket({status:400,body:{message:'Bucket not found'}}),false);
  assert.equal(isMissingStorageBucket({status:400,body:{...missing,code:'AccessDenied'}}),false);
  assert.equal(isMissingStorageBucket({status:400,body:{...missing,statusCode:'400'}}),false);
  assert.equal(isMissingStorageBucket({status:400,body:{...missing,error:'InvalidRequest'}}),false);
  assert.equal(isMissingStorageBucket({status:400,body:null}),false);
});

test('harness bloquea producción antes de cualquier solicitud',async()=>{
  const {runIntegration}=await import(moduleUrl); let calls=0;
  const env={...valid(),ZONDA_TEST_PROJECT_REF:'aqinxboxjklsyvesdcyr',ZONDA_TEST_CONFIRM_REF:'aqinxboxjklsyvesdcyr',ZONDA_TEST_URL:'https://aqinxboxjklsyvesdcyr.supabase.co'};
  await assert.rejects(runIntegration(env,{fetchImpl:async()=>{calls++;}}),/productivo/);
  assert.equal(calls,0);
});
test('harness rechaza URLs ambiguas y claves JWT de otro proyecto',async()=>{
  const {validateTestConfig}=await import(moduleUrl);
  for(const url of ['https://other.supabase.co','https://abcdefghijklmnopqrst.supabase.co/path','https://user:pass@abcdefghijklmnopqrst.supabase.co','https://abcdefghijklmnopqrst.supabase.co/?key=x'])
    assert.throws(()=>validateTestConfig({...valid(),ZONDA_TEST_URL:url}));
  assert.throws(()=>validateTestConfig({...valid(),ZONDA_TEST_SERVICE_KEY:jwt({role:'service_role',ref:'differentprojecttest'})}),/otro proyecto/);
});
test('harness local solo permite loopback y rechaza claves productivas',async()=>{
  const {validateTestConfig}=await import(moduleUrl);
  const local={...valid(),ZONDA_TEST_MODE:'local',ZONDA_TEST_PROJECT_REF:'local-zonda-test',ZONDA_TEST_CONFIRM_REF:'local-zonda-test',ZONDA_TEST_URL:'http://127.0.0.1:54321/',
    ZONDA_TEST_PUBLIC_KEY:jwt({role:'anon'}),ZONDA_TEST_SERVICE_KEY:jwt({role:'service_role'})};
  assert.equal(validateTestConfig(local).mode,'local');
  assert.throws(()=>validateTestConfig({...local,ZONDA_TEST_URL:'http://192.168.1.1:54321'}),/loopback/);
  assert.throws(()=>validateTestConfig({...local,ZONDA_TEST_SERVICE_KEY:jwt({role:'service_role',ref:'aqinxboxjklsyvesdcyr'})}),/productivo/);
  assert.throws(()=>validateTestConfig({...local,ZONDA_TEST_PUBLIC_KEY:'sb_publishable_ypqDPv6T3S4cDuNFi2Yq2A_Lt5rJ68m'}),/productivo/);
});
test('harness aborta si el destino tiene datos sin realizar mutaciones ni limpieza',async()=>{
  const {runIntegration}=await import(moduleUrl); const calls=[];
  const report=await runIntegration(valid(),{log:()=>{},fetchImpl:async(url,options)=>{
    calls.push({url,method:options.method}); return new Response(JSON.stringify([{id:'existing-record'}]),{status:200});
  }});
  assert.equal(report.passed,false); assert.match(report.error,/debe estar vacío/);
  assert.deepEqual(report.cleanup,[]); assert.equal(calls.length,1); assert.equal(calls[0].method,'GET');
});
test('harness no imprime claves coincidentes al rechazar la configuración',async()=>{
  const {validateTestConfig}=await import(moduleUrl); const secret='identical_synthetic_value_should_not_appear';
  let failure; try{validateTestConfig({...valid(),ZONDA_TEST_PUBLIC_KEY:secret,ZONDA_TEST_SERVICE_KEY:secret});}catch(error){failure=error;}
  assert.ok(failure); assert.ok(!failure.message.includes(secret));
});

test('harness verifica las once tablas y rechaza también carpetas preexistentes de Storage',async()=>{
  const {runIntegration}=await import(moduleUrl); const calls=[];
  const report=await runIntegration(valid(),{log:()=>{},fetchImpl:async(url,options)=>{
    const pathname=new URL(url).pathname;
    calls.push({url,method:options.method,body:options.body});
    let body;
    if(pathname.startsWith('/rest/v1/ec_')) body=[];
    else if(pathname==='/auth/v1/admin/users') body={users:[]};
    else if(pathname==='/storage/v1/bucket/ec-docs') body={id:'ec-docs',public:false};
    else if(pathname==='/storage/v1/object/list/ec-docs') body=[{name:'existing-folder',id:null}];
    else throw new Error('No debe crear ni eliminar fixtures.');
    return new Response(JSON.stringify(body),{status:200});
  }});
  assert.equal(report.passed,false); assert.match(report.error,/objetos o carpetas/); assert.deepEqual(report.cleanup,[]);
  const tables=calls.filter(x=>new URL(x.url).pathname.startsWith('/rest/v1/ec_'));
  assert.equal(tables.length,11);
  assert.equal(new URL(tables.find(x=>x.url.includes('/ec_members?')).url).searchParams.get('select'),'user_id');
  const posts=calls.filter(x=>x.method!=='GET');
  assert.equal(posts.length,1); assert.equal(new URL(posts[0].url).pathname,'/storage/v1/object/list/ec-docs');
  assert.equal(JSON.parse(posts[0].body).limit,1);
});

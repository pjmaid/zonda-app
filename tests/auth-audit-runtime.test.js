const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const auditSource=html.slice(html.indexOf("const LS_AUDIT = 'ecx_audit'"),html.indexOf('function auditResumen('));
const logoutSource=html.slice(html.indexOf('function doLogout('),html.indexOf("$('btnLogin').addEventListener('click', doLogin)"));
const copy=value=>JSON.parse(JSON.stringify(value));
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const event=(id,user='user-a',org='org-a')=>({id,org_id:org,auth_user_id:user,ts:'2026-11-23T10:00:00Z',usuario:user,entidad:'paciente',accion:'prueba',refId:id,detalle:'Ficticio',sincronizado:false});

function app(seed=[],fetch=async()=>reply([])){
  const state={saved:[],status:[],timers:[],steps:[]};let n=0;
  const ctx=vm.createContext({
    SESSION:{access_token:'access-a'},MEMBRESIA:{org_id:'org-a',user_id:'user-a'},ME:{email:'a@example.invalid',rol:'admin'},CURRENT_USER:'a@example.invalid',
    Store:{online:()=>true},LS:{SES:'session'},SEC_TIMER:null,SEC_WARN:null,DOC_DELETE_PENDING:new Set(),
    loadJSON:()=>copy(seed),saveJSON(key,value){state.saved.push({key,value:copy(value)});state.steps.push('save');},
    localStorage:{removeItem(key){state.steps.push('remove:'+key);}},
    supaFetch:fetch,uid:()=> 'new-'+(++n),T:value=>value,
    syncStatus:(...args)=>state.status.push(args),
    setTimeout(callback,delay){state.timers.push({callback,delay});return state.timers.length;},clearTimeout(){},
    window:{addEventListener(){}},$:()=>({classList:{contains:()=>true,add(){},remove(){}}}),
    clearPrivateSessionData(){state.steps.push('clear');},initLoginScreen(){},toast(){},
    location:{reload(){assert.equal(ctx.SESSION,null);state.steps.push('reload');}}
  });
  vm.runInContext(auditSource+logoutSource+'\nthis.audit={create:auditEvent,confirm:recordarAuditoriaConfirmada,queue:syncAuditQueue,rows:auditRows,local:auditLocalEvents,pending:auditPendingEvents,all:()=>AUDIT,close:doLogout};',ctx);
  ctx.state=state;
  ctx.account=(user,org)=>{
    ctx.SESSION={access_token:'access-'+user};ctx.MEMBRESIA={user_id:user,org_id:org};ctx.ME={email:user+'@example.invalid',rol:'admin'};ctx.CURRENT_USER=ctx.ME.email;
  };
  return ctx;
}

test('eventos nuevos incluyen usuario y sitio; el logout conserva auditoría y borra sesión antes de recargar',()=>{
  const legacy={id:'legacy',sincronizado:false};
  const ctx=app([legacy]);ctx.Store.online=()=>false;
  const created=ctx.audit.create('sesion','ingreso','','');
  assert.equal(created.org_id,'org-a');assert.equal(created.auth_user_id,'user-a');
  ctx.audit.confirm('paciente','modificación','p-test','Ficticio','','confirmed-test');
  assert.equal(ctx.audit.close(),true);
  const persisted=ctx.state.saved.at(-1).value;
  assert.deepEqual(persisted[0],legacy);
  assert.equal(persisted.find(e=>e.id==='confirmed-test').sincronizado,true);
  const exit=persisted.find(e=>e.accion==='salida');
  assert.equal(exit.org_id,'org-a');assert.equal(exit.auth_user_id,'user-a');assert.equal(exit.sincronizado,false);
  assert.ok(ctx.state.steps.lastIndexOf('save')<ctx.state.steps.indexOf('remove:session'));
  assert.ok(ctx.state.steps.indexOf('remove:session')<ctx.state.steps.indexOf('reload'));
  assert.equal(ctx.audit.local().length,0);
});

test('la cola solo envía pendientes de la cuenta y sitio actuales con org_id explícito; legados quedan intactos',async()=>{
  const legacy={id:'legacy',sincronizado:false},calls=[];
  const ctx=app([event('own'),event('other-user','user-b'),event('other-org','user-a','org-b'),legacy],async(route,opts)=>{
    calls.push({route,payload:JSON.parse(opts.body)});return reply({});
  });
  assert.equal(ctx.audit.pending().length,1);
  await ctx.audit.queue();
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0].payload.map(e=>({id:e.event_id,org:e.org_id})),[{id:'own',org:'org-a'}]);
  assert.equal(ctx.audit.pending().length,0);
  assert.equal(ctx.audit.all().find(e=>e.id==='other-user').sincronizado,false);
  assert.equal(ctx.audit.all().find(e=>e.id==='other-org').sincronizado,false);
  assert.deepEqual(copy(ctx.audit.all().find(e=>e.id==='legacy')),legacy);
  assert.equal(ctx.state.timers.length,0);
});

test('lectura y exportación local excluyen otras cuentas y legados; la consulta remota delimita el sitio',async()=>{
  let requested;
  const ctx=app([event('own'),event('other-user','user-b'),event('other-org','user-a','org-b'),{id:'legacy'}],async route=>{
    requested=new URL(route,'https://test.invalid');
    return reply([{id:'server-own',org_id:'org-a',ts:'2026-11-23T11:00:00Z',ref_id:'server-own'},
      {id:'server-other',org_id:'org-b',ts:'2026-11-23T11:00:00Z',ref_id:'server-other'}]);
  });
  const rows=await ctx.audit.rows();
  assert.equal(requested.searchParams.get('org_id'),'eq.org-a');
  assert.deepEqual(copy(ctx.audit.local()).map(e=>e.id),['own']);
  assert.deepEqual(copy(rows).map(e=>e.id).sort(),['own','srv-server-own']);
});

test('una respuesta pendiente de A no confirma eventos ni muestra errores en B ni bloquea su sincronización',async()=>{
  const first=deferred(),second=deferred();let calls=0;
  const ctx=app([event('a'),event('b','user-b','org-b')],async()=>++calls===1?first.promise:second.promise);
  const syncA=ctx.audit.queue();
  ctx.account('user-b','org-b');
  const syncB=ctx.audit.queue();
  assert.equal(calls,2);
  first.resolve(reply({},503));await syncA;
  assert.equal(ctx.audit.all().find(e=>e.id==='a').sincronizado,false);
  assert.equal(ctx.state.status.some(args=>args[1]==='error'),false);
  second.resolve(reply({}));await syncB;
  assert.equal(ctx.audit.all().find(e=>e.id==='b').sincronizado,true);
  assert.equal(ctx.state.timers.length,0);
});

test('la lectura iniciada por A no entrega datos locales ni remotos después de cambiar a B',async()=>{
  const pending=deferred();
  const ctx=app([event('a')],async()=>pending.promise);
  const rows=ctx.audit.rows();
  ctx.account('user-b','org-b');
  pending.resolve(reply([{id:'old-server',org_id:'org-a',ts:'2026-11-23T11:00:00Z'}]));
  assert.deepEqual(copy(await rows),[]);
  assert.equal(ctx.state.status.length,0);
});

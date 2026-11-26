const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const passwordPolicy=html.slice(html.indexOf('const PASS_MIN ='),html.indexOf('function saveLocalDB('));
const source=html.slice(html.indexOf('async function authJsonRequest('),html.indexOf('async function enterApp('));
const membership=html.slice(html.indexOf('async function cargarMembresia('),html.indexOf('/* llamada a la función del servidor que crea cuentas'));
const temporaryPassword=html.slice(html.indexOf('async function forzarCambioClave('),html.indexOf('function avisarClaveVencida('));
const logoutSource=html.slice(html.indexOf('function doLogout('),html.indexOf("$('btnLogin').addEventListener('click', doLogin)"));
const inactivitySource=html.slice(html.indexOf('let SEC_TIMER ='),html.indexOf('/* ---- pista de auditoría'));
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status});
const json=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};

function app(fetch,url='https://zonda.example.invalid/?lang=es'){
  const elements=new Map();
  function element(id){
    if(!elements.has(id)){
      const hidden=new Set(['hidden']),attributes=new Map(),listeners={};
      elements.set(id,{id,value:'',type:id.toLowerCase().includes('pass')?'password':'text',textContent:id==='btnLogin'?'Ingresar':'',innerHTML:'',className:'',style:{},disabled:false,listeners,
        classList:{add:x=>hidden.add(x),remove:x=>hidden.delete(x),contains:x=>hidden.has(x),toggle:(x,on)=>on?hidden.add(x):hidden.delete(x)},
        setAttribute:(k,v)=>attributes.set(k,v),removeAttribute:k=>attributes.delete(k),getAttribute:k=>attributes.get(k),focus(){this.focused=true;},
        addEventListener:(event,callback)=>{(listeners[event]??=[]).push(callback);}
      });
    }
    return elements.get(id);
  }
  const saved=[];
  const ctx=vm.createContext({
    $,URL,URLSearchParams,AbortController,setTimeout,clearTimeout,fetch,Response,
    CFG:{supaKey:'public-test-key'},LS:{SES:'session'},SESSION:null,CURRENT_USER:'',ME:null,MEMBRESIA:null,DB:{patients:[{id:'previous-session'}]},DOC_RECOVERY_FILES:new Map([['old-doc',{blob:'previous-session'}]]),
    Store:{online:()=>true,resetMeta(){this.metaWasReset=true;}},T:s=>s,location:new URL(url),
    supaBase:()=> 'https://test.supabase.co',
    supaFetch:(route,opts)=>fetch('https://test.supabase.co'+route,opts),
    saveJSON:(_key,value)=>saved.push(json(value)),localStorage:{removeItem:key=>saved.push({removed:key})},
    renderBuildInfo(){},
    enterApp:async()=>{},jwtSub:()=> 'user-test',auditar(){},toast(){},
    document:{addEventListener(){},body:{appendChild(){}},createElement:()=>({innerHTML:'',className:'',querySelector:selector=>element(selector.slice(1)),remove(){}})},
    history:{replaceState(_state,_title,relative){ctx.location=new URL(relative,ctx.location.origin);}}
  });
  function $(id){return element(id);}
  vm.runInContext(passwordPolicy+source+membership+temporaryPassword+inactivitySource+logoutSource+'\nthis.auth={request:authJsonRequest,recover:sendRecoveryEmail,consume:consumeRecoveryLink,login:doLogin,membership:cargarMembresia,temporary:forzarCambioClave,logout:doLogout,inactivity:resetInactividad,getRecoveryToken:()=>RECOVERY_TOKEN};',ctx);
  ctx.element=element;ctx.saved=saved;
  ctx.location.reload=()=>{ctx.reloaded=true;};
  ctx.click=async id=>{for(const fn of element(id).listeners.click||[])await fn({preventDefault(){},currentTarget:element(id)});};
  return ctx;
}

test('recuperación transmite redirect_to en query y nunca en el cuerpo',async()=>{
  const calls=[];const ctx=app(async(url,opts)=>{calls.push({url,body:JSON.parse(opts.body)});return reply({});});
  await ctx.auth.recover('  User@Example.invalid ');
  const sent=new URL(calls[0].url);
  assert.equal(sent.pathname,'/auth/v1/recover');
  assert.equal(sent.searchParams.get('redirect_to'),'https://zonda.example.invalid/');
  assert.deepEqual(calls[0].body,{email:'user@example.invalid'});
});

test('una invitación valida al usuario y retira el token del historial antes de la consulta',async()=>{
  const pending=deferred();let ctx,headers;
  ctx=app(async(_url,opts)=>{assert.equal(ctx.location.hash,'');headers=opts.headers;return pending.promise;},'https://zonda.example.invalid/?lang=es#type=invite&access_token=test-invite&refresh_token=not-retained');
  ctx.SESSION={email:'previous@example.invalid'};
  const result=ctx.auth.consume();
  assert.equal(ctx.location.href,'https://zonda.example.invalid/?lang=es');
  pending.resolve(reply({id:'user-test',email:'invited@example.invalid'}));
  assert.equal(await result,true);
  assert.equal(headers.Authorization,'Bearer test-invite');
  assert.equal(ctx.auth.getRecoveryToken(),'test-invite');
  assert.equal(ctx.SESSION,null);
  assert.deepEqual(json(ctx.DB.patients),[]);
  assert.equal(ctx.DOC_RECOVERY_FILES.size,0);
  assert.equal(ctx.Store.metaWasReset,true);
  assert.equal(ctx.element('loginUser').value,'invited@example.invalid');
  assert.equal(ctx.element('recoveryTitle').textContent,'Activar tu cuenta de Zonda');
  assert.equal(ctx.element('recoveryBox').classList.contains('hidden'),false);
});

test('un enlace vencido queda manejado y no permite restaurar otra sesión automáticamente',async()=>{
  let calls=0;const ctx=app(async()=>{calls++;return reply({});},'https://zonda.example.invalid/?lang=es#error=access_denied&error_description=expired&type=recovery');
  assert.equal(await ctx.auth.consume(),true);
  assert.equal(calls,0);
  assert.equal(ctx.location.hash,'');
  assert.match(ctx.element('loginMsg').textContent,/venció/);
  assert.equal(ctx.auth.getRecoveryToken(),'');
});

test('rechaza token inválido sin dejarlo en la URL ni habilitar cambio de clave',async()=>{
  const ctx=app(async()=>reply({msg:'invalid'},401),'https://zonda.example.invalid/#type=recovery&access_token=invalid-test');
  assert.equal(await ctx.auth.consume(),true);
  assert.equal(ctx.location.hash,'');
  assert.equal(ctx.auth.getRecoveryToken(),'');
  assert.equal(ctx.element('recoveryBox').classList.contains('hidden'),true);
  assert.match(ctx.element('loginMsg').textContent,/venció/);
});

test('parámetros sensibles fuera del fragmento se retiran sin usarlos para iniciar sesión',async()=>{
  let calls=0;
  const ctx=app(async()=>{calls++;return reply({});},'https://zonda.example.invalid/?lang=es&access_token=not-trusted&refresh_token=not-retained');
  assert.equal(await ctx.auth.consume(),true);
  assert.equal(calls,0);
  assert.equal(ctx.location.href,'https://zonda.example.invalid/?lang=es');
  assert.equal(ctx.auth.getRecoveryToken(),'');
});

test('guardar una clave recuperada limpia el indicador temporal y las contraseñas visibles',async()=>{
  let update;
  const ctx=app(async(_url,opts)=>{
    if(opts.method==='PUT'){update=JSON.parse(opts.body);return reply({id:'user-test'});}
    return reply({id:'user-test',email:'user@example.invalid'});
  },'https://zonda.example.invalid/#type=recovery&access_token=recovery-test');
  await ctx.auth.consume();
  ctx.element('recoveryPass').value='Cometa!2026Azul';ctx.element('recoveryPass2').value='Cometa!2026Azul';
  await ctx.click('btnRecoverySave');
  assert.deepEqual(update,{password:'Cometa!2026Azul',data:{clave_temporal:false}});
  assert.equal(ctx.auth.getRecoveryToken(),'');
  assert.equal(ctx.element('recoveryPass').value,'');
  assert.equal(ctx.element('recoveryPass2').value,'');
  assert.equal(ctx.element('recoveryBox').classList.contains('hidden'),true);
  assert.match(ctx.element('loginMsg').textContent,/Clave actualizada/);
});

test('una clave existente se transmite intacta y dos ingresos simultáneos producen una sola solicitud',async()=>{
  let calls=0,sent;const pending=deferred();
  const ctx=app(async(_url,opts)=>{calls++;sent=JSON.parse(opts.body);return pending.promise;});
  ctx.element('loginUser').value=' User@Example.invalid ';ctx.element('loginPass').value=' aB12 ';
  const first=ctx.auth.login();await ctx.auth.login();
  assert.equal(calls,1);
  assert.deepEqual(sent,{email:'user@example.invalid',password:' aB12 '});
  pending.resolve(reply({access_token:'access',refresh_token:'refresh',user:{email:'user@example.invalid'}}));
  await first;
  assert.equal(ctx.element('btnLogin').disabled,false);
  assert.equal(ctx.element('btnLogin').textContent,'Ingresar');
  assert.equal(ctx.element('loginPass').value,'');
});

test('errores de credenciales, servicio y carga se distinguen sin perder controles',async()=>{
  const ctx=app(async()=>reply({error_code:'invalid_credentials',msg:'Invalid login credentials'},400));
  ctx.element('loginUser').value='user@example.invalid';ctx.element('loginPass').value='incorrect';
  await ctx.auth.login();
  assert.match(ctx.element('loginMsg').textContent,/Email o clave incorrectos/);
  assert.equal(ctx.element('btnLogin').disabled,false);
  ctx.fetch=async()=>reply({},503);
  await ctx.auth.login();
  assert.match(ctx.element('loginMsg').textContent,/servicio de acceso no está disponible/);
  ctx.fetch=async()=>reply({},429);
  await ctx.auth.login();
  assert.match(ctx.element('loginMsg').textContent,/límite de intentos/);
  ctx.fetch=async()=>reply({access_token:'access',refresh_token:'refresh',user:{email:'user@example.invalid'}});
  ctx.enterApp=async()=>{throw new Error('No se pudieron cargar los registros.');};
  await ctx.auth.login();
  assert.equal(ctx.element('loginMsg').textContent,'No se pudieron cargar los registros.');
  assert.equal(ctx.element('loginScreen').classList.contains('hidden'),false);
});

test('la verificación de membresía informa errores del servidor sin fingir falta de asignación',async()=>{
  const ctx=app(async()=>reply({},503));
  await assert.rejects(ctx.auth.membership(),/verificar los permisos del sitio \(503\)/);
  assert.equal(ctx.MEMBRESIA,null);
});

test('rechaza sitios desactivados aunque la membresía siga activa',async()=>{
  const ctx=app(async url=>url.includes('ec_members')?reply([{user_id:'user-test',org_id:'org-test',rol:'admin',activo:true}]):reply([{id:'org-test',activo:false}]));
  await assert.rejects(ctx.auth.membership(),/sitio no está activo/);
  assert.equal(ctx.MEMBRESIA,null);
});

test('una solicitud de acceso bloqueada se cancela y devuelve un mensaje recuperable',async()=>{
  let aborted=false;
  const ctx=app(async(_url,opts)=>new Promise((_resolve,reject)=>opts.signal.addEventListener('abort',()=>{aborted=true;reject(new Error('AbortError'));})));
  await assert.rejects(ctx.auth.request('/auth/v1/user',{},false,5),/tardó demasiado/);
  assert.equal(aborted,true);
});

test('el timeout durante la lectura del cuerpo tampoco se confunde con una respuesta válida',async()=>{
  const ctx=app(async(_url,opts)=>({ok:true,status:200,json:()=>new Promise((_resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(new Error('AbortError'))))}));
  await assert.rejects(ctx.auth.request('/auth/v1/user',{},false,5),/tardó demasiado/);
});

test('una clave temporal exige los requisitos antes de actualizar y admite cerrar sesión',async()=>{
  let calls=0;
  const ctx=app(async()=>{calls++;return reply({});});
  const result=ctx.auth.temporary();
  ctx.element('fc_p1').value='SINMINUSCULA!88';ctx.element('fc_p2').value='SINMINUSCULA!88';
  await ctx.click('fc_ok');
  assert.equal(calls,0);
  assert.match(ctx.element('fc_msg').textContent,/minúscula/);
  await ctx.click('fc_cancel');
  assert.equal(await result,false);
});

test('el cambio de clave temporal se guarda una sola vez y permite reintentar tras error',async()=>{
  let calls=0,update;const pending=deferred();
  const ctx=app(async(_url,opts)=>{calls++;update=JSON.parse(opts.body);return calls===1?reply({},503):pending.promise;});
  ctx.SESSION={claveTemp:true};
  const result=ctx.auth.temporary();
  ctx.element('fc_p1').value='Cometa!2026Azul';ctx.element('fc_p2').value='Cometa!2026Azul';
  await ctx.click('fc_ok');
  assert.equal(ctx.SESSION.claveTemp,true);
  assert.equal(ctx.element('fc_ok').disabled,false);
  assert.equal(ctx.element('fc_cancel').disabled,false);
  assert.match(ctx.element('fc_msg').textContent,/servicio de acceso no está disponible/);
  const saving=ctx.click('fc_ok');await ctx.click('fc_ok');
  assert.equal(calls,2);
  pending.resolve(reply({id:'user-test'}));await saving;
  assert.equal(await result,true);
  assert.equal(ctx.SESSION.claveTemp,false);
  assert.deepEqual(update,{password:'Cometa!2026Azul',data:{clave_temporal:false}});
});

test('el arranque bloquea un ingreso concurrente mientras valida el enlace y restaura el botón',async()=>{
  const pending=deferred();let calls=0;
  const ctx=app(async()=>{calls++;return pending.promise;},'https://zonda.example.invalid/#type=recovery&access_token=callback-test');
  ctx.applyLang=()=>{};
  const bootSource=html.slice(html.indexOf('(async function boot(){'),html.indexOf('/* ================= ESTUDIOS'));
  const boot=vm.runInContext(bootSource,ctx);
  assert.equal(ctx.element('btnLogin').disabled,true);
  ctx.element('loginUser').value='other@example.invalid';ctx.element('loginPass').value='existing-key';
  await ctx.auth.login();
  assert.equal(calls,1);
  pending.resolve(reply({id:'user-test',email:'invited@example.invalid'}));
  await boot;
  assert.equal(ctx.element('loginUser').value,'invited@example.invalid');
  assert.equal(ctx.element('btnLogin').disabled,false);
  assert.equal(ctx.element('btnLogin').textContent,'Ingresar');
});

test('cerrar sesión espera la eliminación y recuperación sin borrar sesión ni datos ni auditar una salida falsa',()=>{
  const ctx=app(async()=>reply({})),events=[],messages=[];
  ctx.SESSION={access_token:'test-access'};ctx.CURRENT_USER='user@example.invalid';
  const session=ctx.SESSION,db=ctx.DB;
  ctx.DOC_DELETE_PENDING=new Set(['doc-test']);
  ctx.auditar=(...args)=>events.push(args);ctx.toast=message=>messages.push(message);
  assert.equal(ctx.auth.logout(),false);
  assert.equal(ctx.SESSION,session);assert.equal(ctx.CURRENT_USER,'user@example.invalid');
  assert.equal(ctx.DB,db);assert.equal(ctx.DOC_RECOVERY_FILES.size,1);
  assert.equal(ctx.saved.length,0);assert.equal(events.length,0);
  assert.equal(ctx.reloaded,undefined);
  assert.equal(messages[0],'Esperá a que termine la eliminación y su recuperación antes de cerrar sesión.');
  ctx.DOC_DELETE_PENDING.clear();
  assert.equal(ctx.auth.logout(),true);
  assert.equal(ctx.SESSION,null);assert.equal(ctx.CURRENT_USER,'');
  assert.equal(ctx.DOC_RECOVERY_FILES.size,0);
  assert.equal(events[0][1],'salida');
  assert.equal(ctx.reloaded,true);
});

test('el cierre por inactividad bloqueado se rearma y solo anuncia y audita un cierre real',()=>{
  const ctx=app(async()=>reply({})),timers=[],events=[];
  ctx.SESSION={access_token:'test-access'};ctx.CURRENT_USER='user@example.invalid';
  ctx.DOC_DELETE_PENDING=new Set(['doc-test']);
  ctx.secCfg=()=>({inactividadMin:15});
  ctx.setTimeout=(callback,delay)=>{timers.push({callback,delay});return timers.length;};ctx.clearTimeout=()=>{};
  ctx.auditar=(...args)=>events.push(args);
  ctx.auth.inactivity();
  timers[1].callback();
  assert.equal(timers.length,4);
  assert.equal(ctx.CURRENT_USER,'user@example.invalid');
  assert.equal(ctx.element('loginMsg').textContent,'');assert.equal(events.length,0);
  ctx.DOC_DELETE_PENDING.clear();
  timers[3].callback();
  assert.equal(ctx.SESSION,null);
  assert.match(ctx.element('loginMsg').textContent,/Se cerró la sesión por inactividad/);
  assert.deepEqual(events.map(event=>event[1]),['logout_inactividad','salida']);
});

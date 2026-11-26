const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const source=html.slice(html.indexOf('function renderUsers(){'),html.indexOf('/* ---------- panel de sitios'))+
  html.slice(html.indexOf('function userForm(id){'),html.indexOf("$('btnUserNew').addEventListener"));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};

function app(superadmin=false){
  const nodes=new Map();
  const state={superadmin,emails:[],actions:[],messages:[],persists:[],activation:[]};
  const profiles=[{id:'self-profile',authId:'self-auth',email:'self@example.invalid',nombre:'Propio',rol:'admin',estudios:[],activo:true},
    {id:'other-profile',authId:'other-auth',email:'other@example.invalid',nombre:'Otro',rol:'medico',estudios:[],activo:true}];
  class Element{
    constructor(id='',dataset={}){this.id=id;this.dataset=dataset;this.listeners={};this.disabled=false;this.value='';this.style={};this.children=[];this._html='';this.classList={add(){},remove(){},toggle(){}};}
    set innerHTML(value){
      for(const child of this.children)if(child.id)nodes.delete(child.id);
      this._html=value;this.children=[];
      for(const match of value.matchAll(/<(input|select|div|button|label)\b([^>]*)>/g)){
        const attrs=match[2],id=attrs.match(/\bid="([^"]+)"/)?.[1]||'';
        const dataset=Object.fromEntries([...attrs.matchAll(/\bdata-([a-z]+)="([^"]*)"/g)].map(m=>[m[1],m[2]]));
        if(!id&&!Object.keys(dataset).length)continue;
        const child=new Element(id,dataset);child.value=attrs.match(/\bvalue="([^"]*)"/)?.[1]||'';
        if(match[1]==='select'){
          const options=value.slice(match.index).split('</select>')[0];
          child.value=options.match(/<option value="([^"]+)" selected/)?.[1]||options.match(/<option value="([^"]+)"/)?.[1]||'';
        }
        this.children.push(child);if(id)nodes.set(id,child);
      }
    }
    get innerHTML(){return this._html;}
    querySelectorAll(selector){const key=selector.match(/^\[data-([a-z]+)\]$/)?.[1];return key?this.children.filter(el=>key in el.dataset):[];}
    addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);}
    async click(){if(this.disabled)return;for(const fn of this.listeners.click||[])await fn({currentTarget:this});}
    scrollIntoView(){}
  }
  for(const id of ['usersHint','usersList','userForm'])nodes.set(id,new Element(id));
  const ctx=vm.createContext({
    $:id=>nodes.get(id)||null,T:x=>x,esc:x=>String(x),ME:profiles[0],
    can:()=>true,esSuper:()=>state.superadmin,jwtSub:()=> 'self-auth',miOrgNombre:()=> 'Sitio ficticio',
    usersAll:()=>profiles,getStudy:()=>null,noAnulado:()=>true,visibleStudies:()=>[],
    ROLES:{admin:{n:'Admin',d:'Admin'},medico:{n:'Médico',d:'Médico'},coord:{n:'Coordinación',d:'Coordinación'}},
    Store:{online:()=>true,loadAll:async()=>{},remove:async()=>{throw new Error('No debe usar baja local');}},
    confirm:()=>true,passCheck:()=>({ok:true}),document:{querySelectorAll:()=>[]},
    toast:message=>state.messages.push(message),
    sendRecoveryEmail:async email=>{state.emails.push(email);if(state.recoveryPending)await state.recoveryPending;},
    administrarUsuario:async(action,user,extra)=>{state.actions.push({action,user,extra});return{mensaje:'Aplicado'};},
    activarServidor:async(authId,active)=>{state.activation.push({authId,active});if(state.activationError)throw new Error(state.activationError);},
    persist:async(kind,value)=>state.persists.push({kind,value})
  });
  vm.runInContext(source+'\nthis.ui={render:renderUsers,form:userForm};',ctx);
  return{ctx,state,nodes,profiles,button:(key,id)=>nodes.get('usersList').querySelectorAll(`[data-${key}]`).find(b=>b.dataset[key]===id)};
}

test('admin ordinario conserva desactivación y recuperación explícita, sin baja ni clave ajena',async()=>{
  const {ctx,state,nodes,button}=app();ctx.ui.render();
  assert.equal(button('udel','other-profile'),undefined);
  assert.ok(button('utog','other-profile'));
  ctx.ui.form('other-profile');
  assert.equal(nodes.has('uf_passwordSave'),false);
  assert.ok(nodes.get('uf_reset'));
  assert.equal(state.emails.length,0);
  const pending=deferred();state.recoveryPending=pending.promise;
  const first=nodes.get('uf_reset').click();await nodes.get('uf_reset').click();
  assert.deepEqual(state.emails,['other@example.invalid']);
  assert.equal(nodes.get('uf_reset').disabled,true);
  pending.resolve();await first;
  assert.equal(nodes.get('uf_reset').disabled,false);
  assert.equal(state.actions.length,0);
});

test('superadmin puede asignar una clave ajena y pedir la baja Auth de otra cuenta',async()=>{
  const {ctx,state,nodes,button}=app(true);ctx.ui.render();
  assert.equal(button('udel','self-profile'),undefined);
  assert.ok(button('udel','other-profile'));
  ctx.ui.form('other-profile');
  assert.ok(nodes.get('uf_passwordSave'));
  nodes.get('uf_password').value='Fixture!Clave2026';nodes.get('uf_password2').value='Fixture!Clave2026';
  await nodes.get('uf_passwordSave').click();
  assert.equal(state.actions[0].action,'cambiar_clave');
  assert.equal(state.actions[0].user.authId,'other-auth');
  assert.equal(nodes.get('uf_password').value,'');
  await button('udel','other-profile').click();
  assert.equal(state.actions[1].action,'eliminar_usuario');
  assert.equal(state.emails.length,0);
});

test('admin ordinario puede cambiar su propia clave y no recibe baja de su cuenta',async()=>{
  const {ctx,nodes,button}=app();ctx.ui.render();ctx.ui.form('self-profile');
  assert.ok(nodes.get('uf_passwordSave'));
  assert.equal(button('udel','self-profile'),undefined);
});

test('un botón de baja renderizado con permisos anteriores revalida superadmin al hacer clic',async()=>{
  const {ctx,state,button}=app(true);ctx.ui.render();
  const remove=button('udel','other-profile');state.superadmin=false;
  await remove.click();
  assert.equal(state.actions.length,0);
  assert.match(state.messages.at(-1),/requiere un superadministrador/);
});

test('un rechazo del guard de membresía conserva el acceso visible y evita guardar una ficha divergente',async()=>{
  const {ctx,state,profiles,button}=app();ctx.ui.render();
  state.activationError='LAST_ADMIN_FORBIDDEN';
  await button('utog','other-profile').click();
  assert.equal(profiles[1].activo,true);
  assert.equal(state.persists.length,0);
  assert.match(state.messages.at(-1),/LAST_ADMIN_FORBIDDEN/);
});

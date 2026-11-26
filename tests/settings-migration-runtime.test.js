const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const section = (start, end) => html.slice(html.indexOf(start), html.indexOf(end));
const source = [
  section('function loadJSON(', 'function uid('),
  section('function assertSameSession(', 'async function supaTimedFetch('),
  section('function settingId(', 'async function guardarSetting('),
  section('function datosIguales(', 'function logRows('),
].join('\n');

class Storage {
  get length() { return Object.keys(this).length; }
  key(index) { return Object.keys(this)[index] ?? null; }
  getItem(key) { return this[key] ?? null; }
  setItem(key, value) { this[key] = String(value); }
  removeItem(key) { delete this[key]; }
}

const marker = org => 'ecx_legacy_settings_migrated_' + org;
const backup = 'ecx_settings_respaldo_pre_migracion';
const setting = (key, value) => ({id:'procedure|' + key, settingType:'procedure', settingKey:key, value, estudioId:''});

function fixture() {
  const storage = new Storage();
  const state = {writes:[], insertOnly:[], confirmations:0, status:[], onWrite:null, confirm:true};
  const ctx = vm.createContext({
    localStorage:storage, DB:{settings:[], studies:[], visits:[]},
    miOrgNombre:()=>ctx.MEMBRESIA.org_id,
    confirm(){ state.confirmations++; return state.confirm; },
    alert(){}, toast(){}, hidratarConfiguracionCompartida(){},
    syncStatus(area, level, message){ state.status.push({area,level,message}); },
    Store:{
      online:()=>true,
      async upsert(kind, value, audit, options={}){
        assert.equal(kind, 'settings');
        state.writes.push({org:ctx.MEMBRESIA.org_id, id:value.id});
        state.insertOnly.push(options.soloAlta===true);
        if(state.onWrite) await state.onWrite(value);
        ctx.DB.settings.push(structuredClone(value));
      },
      async refreshOne(){},
    }
  });
  function login(org) {
    ctx.SESSION={access_token:'test-'+org};
    ctx.MEMBRESIA={user_id:'test-user-'+org,org_id:org,rol:'admin'};
    ctx.DB.settings=[];
  }
  login('CIER');
  vm.runInContext(source,ctx);
  return {ctx, state, storage, login, run:()=>ctx.migrarConfiguracionCompartidaLegacy(),
    save:(k,v)=>ctx.saveJSON(k,v), read:k=>ctx.loadJSON(k)};
}

test('la importación confirmada conserva los originales y las preferencias vigentes, e importa una sola vez', async()=>{
  const app=fixture();
  const legacy={eco:'imagen',electro:'cardio'};
  app.save('ecx_procclasif',legacy);
  app.ctx.DB.settings=[setting('eco','otros')];
  await app.run();
  assert.equal(app.state.confirmations,1);
  assert.deepEqual(app.state.writes,[{org:'CIER',id:'procedure|electro'}]);
  assert.deepEqual(app.state.insertOnly,[true]);
  assert.deepEqual(app.ctx.DB.settings.map(s=>s.value),['otros','cardio']);
  assert.deepEqual(JSON.parse(JSON.stringify(app.read(backup).procClasif)),legacy);
  assert.ok(app.read(marker('CIER')));
  await app.run();
  assert.equal(app.state.confirmations,1);
  assert.equal(app.state.writes.length,1);
});

test('una importación en CIER no se repite al entrar a la demo en el mismo navegador',async()=>{
  const app=fixture();
  app.save('ecx_procclasif',{eco:'imagen'});
  await app.run();
  app.login('DEMO');
  await app.run();
  assert.equal(app.state.confirmations,1);
  assert.deepEqual(app.state.writes,[{org:'CIER',id:'procedure|eco'}]);
  assert.equal(app.read(marker('DEMO')),null);
});

test('los marcadores históricos y la asignación anterior a otro centro se respetan',async()=>{
  for(const key of [marker('CIER'),'ecx_legacy_shared_claim','ecx_legacy_settings_claim']){
    const app=fixture();
    app.save('ecx_procclasif',{eco:'imagen'});
    app.save(key,key===marker('CIER')?{configuraciones:1}:{orgId:'CIER'});
    app.login('DEMO');
    await app.run();
    assert.equal(app.state.confirmations,0,key);
    assert.equal(app.state.writes.length,0,key);
    assert.equal(app.read(marker('DEMO')),null,key);
  }
});

test('una fila insertada concurrentemente se conserva y el resto de la cola continúa',async()=>{
  for(const remoteValue of ['imagen','otros']){
    const app=fixture();
    app.save('ecx_procclasif',{eco:'imagen',electro:'cardio'});
    app.state.onWrite=async value=>{
      if(value.settingKey==='eco'){
        // Store.upsert recarga la fila ganadora antes de comunicar VERSION_CONFLICT.
        app.ctx.DB.settings.push(setting('eco',remoteValue));
        throw Object.assign(new Error('VERSION_CONFLICT'),{conflict:true});
      }
    };
    await app.run();
    assert.ok(app.read(marker('CIER')),remoteValue);
    assert.deepEqual(app.ctx.DB.settings.map(s=>s.value),[remoteValue,'cardio']);
    assert.deepEqual(app.state.writes.map(w=>w.id),['procedure|eco','procedure|electro']);
    assert.notEqual(app.state.status.at(-1)?.level,'error');
  }
});

test('una falla sin fila confirmada mantiene el respaldo y permite reintentar',async()=>{
  for(const conflict of [true,false]){
    const app=fixture();
    app.save('ecx_procclasif',{eco:'imagen'});
    app.state.onWrite=async()=>{throw Object.assign(new Error('sin confirmación'),{conflict});};
    await app.run();
    assert.equal(app.read(marker('CIER')),null);
    assert.equal(app.read(backup).procClasif.eco,'imagen');
    assert.equal(app.state.status.at(-1)?.level,'error');
    app.state.onWrite=null;
    await app.run();
    assert.ok(app.read(marker('CIER')));
    assert.equal(app.ctx.DB.settings.length,1);
  }
});

test('cambiar de cuenta durante una escritura impide continuar la migración en el segundo sitio',async()=>{
  const app=fixture();
  app.save('ecx_procclasif',{eco:'imagen',electro:'cardio'});
  let started,release;
  const writing=new Promise(resolve=>{started=resolve;});
  const paused=new Promise(resolve=>{release=resolve;});
  app.state.onWrite=async()=>{
    started();
    await paused;
    throw Object.assign(new Error('sesión reemplazada'),{sessionChanged:true});
  };
  const pending=app.run();
  await writing;
  app.login('DEMO');
  release();
  try{await pending;}catch(e){assert.equal(e.sessionChanged,true);}
  assert.equal(app.state.writes.length,1);
  assert.equal(app.read(marker('CIER')),null);
  assert.equal(app.read(marker('DEMO')),null);
  assert.notEqual(app.state.status.at(-1)?.level,'error');
});

test('cancelar antes de importar deja disponible la elección explícita del centro',async()=>{
  const app=fixture();
  app.save('ecx_procclasif',{eco:'imagen'});
  app.state.confirm=false;
  await app.run();
  assert.equal(app.read(marker('CIER')),null);
  assert.equal(app.read('ecx_legacy_settings_claim'),null);
  assert.equal(app.state.writes.length,0);
  app.login('DEMO');
  app.state.confirm=true;
  await app.run();
  assert.deepEqual(app.state.writes,[{org:'DEMO',id:'procedure|eco'}]);
});

test('una preferencia que aparece mientras se importa la fila anterior conserva su valor',async()=>{
  const app=fixture();
  app.save('ecx_procclasif',{eco:'imagen',electro:'cardio'});
  app.state.onWrite=async value=>{
    if(value.settingKey==='eco') app.ctx.DB.settings.push(setting('electro','otros'));
  };
  await app.run();
  assert.ok(app.read(marker('CIER')));
  assert.deepEqual(app.state.writes.map(w=>w.id),['procedure|eco']);
  assert.equal(app.ctx.DB.settings.find(s=>s.settingKey==='electro').value,'otros');
});

test('sólo asocia opciones de tablet o laboratorio a estudios visibles sin ambigüedad y reintenta las diferidas',async()=>{
  const app=fixture();
  app.ctx.DB.studies=[{id:'s1',visitas:[{id:'v1'}]}];
  app.save('ecx_tabletclasif',{'s2|cuestionario':'paciente','s1|formulario':'medico'});
  app.save('ecx_labextra',{'v2|muestra':true,'v1|muestra':true});
  await app.run();
  assert.deepEqual(app.ctx.DB.settings.map(s=>[s.settingType,s.estudioId]).sort(),[['lab_extra','s1'],['tablet','s1']]);
  assert.ok(app.read(marker('CIER')));
  app.ctx.DB.studies.push({id:'s2',visitas:[{id:'v2'}]},{id:'s3',visitas:[{id:'v2'}]});
  await app.run();
  assert.equal(app.ctx.DB.settings.find(s=>s.id==='tablet|s2|cuestionario').estudioId,'s2');
  assert.equal(app.ctx.DB.settings.some(s=>s.id==='lab_extra|v2|muestra'),false);
  app.ctx.DB.studies.pop();
  await app.run();
  assert.equal(app.ctx.DB.settings.find(s=>s.id==='lab_extra|v2|muestra').estudioId,'s2');
  assert.equal(app.state.writes.length,4);
  assert.equal(app.state.confirmations,1);
});

test('preferencias idénticas ya guardadas completan el proceso sin escrituras ni avisos repetidos',async()=>{
  const app=fixture();
  app.save('ecx_procclasif',{eco:'imagen'});
  app.ctx.DB.settings=[setting('eco','imagen')];
  await app.run();
  assert.ok(app.read(marker('CIER')));
  assert.equal(app.state.writes.length,0);
  assert.equal(app.state.confirmations,0);
  await app.run();
  assert.equal(app.state.writes.length,0);
  assert.equal(app.state.confirmations,0);
});

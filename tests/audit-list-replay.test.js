const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = html.slice(html.indexOf("const LS_AUDIT = 'ecx_audit'"), html.indexOf('function auditResumen('));
const clientTime = '2026-11-26T10:00:00.000Z';
const serverTime = '2026-11-26T10:20:00.000Z';
const user = 'prueba@example.invalid';
const fields = { usuario:user, rol:'coord', entidad:'sesión', accion:'ingreso', ts:clientTime, detalle:'', motivo:'' };

async function list(local, remote) {
  const context = vm.createContext({
    SESSION:{access_token:'sesión-de-prueba'},
    MEMBRESIA:{org_id:'org-a', user_id:'user-a'},
    loadJSON:()=>local.map(e=>({...e, org_id:'org-a', auth_user_id:'user-a'})),
    window:{addEventListener(){}},
    Store:{online:()=>true},
    supaFetch:async()=>({ok:true, json:async()=>remote})
  });
  const rows = await vm.runInContext(source + '\nauditRows()', context);
  return Array.from(rows);
}

test('la copia del servidor reemplaza al mismo evento local aunque se haya sincronizado más tarde', async()=>{
  const local = [
    {...fields, id:'primero', refId:'ref'},
    {...fields, id:'segundo', refId:'ref', sincronizado:true},
    {...fields, id:'pendiente', refId:'ref'}
  ];
  const remote = [
    {...fields, id:10, event_id:'primero', org_id:'org-a', ref_id:'ref', ts:serverTime, client_ts:clientTime},
    {...fields, id:11, event_id:'segundo', org_id:'org-a', ref_id:'ref', ts:serverTime},
    {...fields, id:12, event_id:'pendiente', org_id:'org-b', ref_id:'ref', ts:serverTime}
  ];
  const rows = await list(local, remote);
  assert.deepEqual(rows.map(row=>row.id), ['srv-10','srv-11','pendiente']);
  assert.equal(rows[0].origen, 'servidor');
  assert.equal(rows[0].ts, serverTime);
});

test('los registros históricos sin identificador conservan el criterio anterior y el mismo ID de otro actor no oculta un evento local', async()=>{
  const local = [{...fields, refId:'antiguo'}, {...fields, id:'por-confirmar', refId:'ref'}];
  const remote = [
    {...fields, id:15, event_id:null, org_id:'org-a', ref_id:'antiguo'},
    {...fields, id:16, event_id:'por-confirmar', org_id:'org-a', usuario:'otra@example.invalid', ref_id:'ref', client_ts:clientTime}
  ];
  const rows = await list(local, remote);
  assert.deepEqual(rows.map(row=>row.id).sort(), ['por-confirmar','srv-15','srv-16']);
});

test('una coincidencia de ID con otro detalle conserva el evento pendiente además del registro remoto', async()=>{
  const local = [{...fields, id:'colisión', refId:'ref', detalle:'Texto local'}];
  const remote = [{...fields, id:18, event_id:'colisión', org_id:'org-a', ref_id:'ref', detalle:'Texto remoto', client_ts:clientTime}];
  const rows = await list(local, remote);
  assert.deepEqual(rows.map(row=>row.detalle).sort(), ['Texto local','Texto remoto']);
});

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const trace=require('../flow-trace.js');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');

const flow={
  procs:['Laboratorio','ECG'],
  visitas:[{nombre:'V1',dia:1,venAntes:0,venDesp:0},{nombre:'V2',dia:15,venAntes:2,venDesp:2}],
  matriz:{'0|0':true,'0|1':true,'1|1':true}
};

test('conserva página, fragmento y confianza por celda',()=>{
  const ev=trace.evidence(flow,{method:'visual',pages:[12,13]});
  assert.equal(ev['0|1'].confidence,0.78);
  assert.equal(ev['0|1'].status,'doubtful');
  assert.equal(ev['0|1'].selected,true);
  assert.equal(ev['1|0'].selected,false);
  assert.deepEqual(ev['0|1'].pages,[12,13]);
  assert.match(ev['0|1'].fragment,/Laboratorio × V2/);
});

test('la geometría queda como extracción de alta confianza',()=>{
  const ev=trace.evidence(flow,{method:'geom',pages:[8]});
  assert.equal(ev['1|1'].status,'extracted');
  assert.equal(ev['1|1'].confidence,0.96);
});

test('compara visitas, ventanas y procedimientos entre versiones',()=>{
  const before=trace.currentSnapshot([{nombre:'V1',dia:1,venAntes:0,venDesp:0,tareas:['Laboratorio']}]);
  const after=trace.snapshot(flow);
  const diff=trace.diff(before,after);
  assert.deepEqual(diff.added,['V2']);
  assert.equal(diff.removed.length,0);
  assert.equal(diff.hasChanges,true);
});

test('detecta procedimientos agregados dentro de una visita existente',()=>{
  const before=trace.currentSnapshot([{nombre:'V2',dia:15,venAntes:2,venDesp:2,tareas:['Laboratorio']}]);
  const after=trace.currentSnapshot([{nombre:'V2',dia:15,venAntes:2,venDesp:2,tareas:['Laboratorio','ECG']}]);
  const diff=trace.diff(before,after);
  assert.match(diff.changed[0].details.join(' '),/\+1 procedimiento/);
});

test('la interfaz persiste extracción original, revisión y comparación',()=>{
  assert.match(html,/importacionesProtocolo: EDIT_IMPORTACIONES_PROTOCOLO/);
  assert.match(html,/extraido:FLOW\.original, revisado/);
  assert.match(html,/comparacion:ZondaFlowTrace\.diff/);
  assert.match(html,/Trazabilidad de importaciones/);
});

test('las visitas conservan fuente y evidencia al aplicar y volver a editar',()=>{
  assert.match(html,/trazabilidad: v\.trazabilidad/);
  assert.match(html,/procedimientos:FLOW\.procs\.map/);
  assert.match(html,/confianza/);
  assert.match(html,/pág\./);
});

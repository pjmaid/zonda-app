const test=require('node:test');
const assert=require('node:assert/strict');
const Today=require('../today-rules.js');
const fs=require('node:fs');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');

test('prioriza un EAS sin reportar como urgente',()=>{
  const rows=Today.priorities({today:'2026-08-10',logs:{ea:[{id:'e1',evento:'Neumonía',serio:'Sí',conocido:'2026-08-09',estudioId:'s1',pacienteId:'p1'}]}});
  assert.ok(rows.some(x=>x.recordId==='e1'&&x.level==='bad'&&/reporte/i.test(x.detail)));
});

test('muestra seguimiento de un EA abierto no serio',()=>{
  const rows=Today.priorities({today:'2026-08-10',logs:{ea:[{id:'e2',evento:'Cefalea',serio:'No'}]}});
  assert.ok(rows.some(x=>x.recordId==='e2'&&x.level==='warn'&&/seguimiento/i.test(x.detail)));
});

test('distingue queries vencidas de abiertas',()=>{
  const rows=Today.priorities({today:'2026-08-10',logs:{queries:[
    {id:'q1',texto:'Completar fecha',estado:'Abierta',vencimiento:'2026-08-09'},
    {id:'q2',texto:'Confirmar dosis',estado:'Abierta',vencimiento:'2026-08-12'}
  ]}});
  assert.equal(rows.find(x=>x.recordId==='q1').level,'bad');
  assert.equal(rows.find(x=>x.recordId==='q2').level,'warn');
});

test('omite registros cerrados y expone auditoría pendiente',()=>{
  const rows=Today.priorities({today:'2026-08-10',pendingAudit:2,logs:{
    desvios:[{id:'d1',descripcion:'Omisión',estado:'Cerrada'}],
    tareas:[{id:'t1',tarea:'Responder',estado:'Hecha'}]
  }});
  assert.equal(rows.filter(x=>['d1','t1'].includes(x.recordId)).length,0);
  assert.ok(rows.some(x=>x.kind==='audit'&&x.level==='bad'));
});

test('la pantalla Hoy carga prioridades accionables',()=>{
  assert.match(html,/<script src="today-rules\.js"><\/script>/);
  assert.match(html,/function renderTodayPriorities\(/);
  assert.match(html,/openLogRecord\(a\.recordType,a\.recordId/);
});

test('la visita conserva el borrador al abrir registros relacionados',()=>{
  assert.match(html,/function captureVisitDraft\(/);
  assert.match(html,/function restoreVisitDraft\(/);
  assert.match(html,/openLinkedVisitLog\('ea'/);
  assert.match(html,/openLinkedVisitLog\('conmed'/);
});

test('las omisiones proponen una desviación vinculada y sin duplicados',()=>{
  assert.match(html,/id='desvio-visita-'\+log\.id/);
  assert.match(html,/visitaId:log\.id/);
  assert.match(html,/PROCEDURES_NOT_DONE/);
});

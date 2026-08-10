const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../quality-rules.js');

const study = { id:'s1', visitas:[{id:'v1',nombre:'Randomización',dia:1,venAntes:0,venDesp:2}] };
const patient = { id:'p1', estudioId:'s1', fechaBasal:'2026-08-01' };
const targetFor = ()=>({from:'2026-08-01',to:'2026-08-03',target:'2026-08-01'});
const consent = {id:'c1',pacienteId:'p1',fecha:'2026-07-31',reconsent:'Consentimiento inicial',version:'2.0'};

test('bloquea procedimientos sin consentimiento previo',()=>{
  const issues=Q.visit({visit:{id:'x',fecha:'2026-08-01',visitaId:'v1',tareas:[]},patient,study,today:'2026-08-10',eligibility:'elegible',consents:[],completedVisits:[],targetFor});
  assert.ok(issues.some(x=>x.code==='CONSENT_BEFORE_PROCEDURE'&&x.level==='block'));
});

test('bloquea una visita duplicada',()=>{
  const issues=Q.visit({visit:{id:'x2',fecha:'2026-08-01',visitaId:'v1',tareas:[]},patient,study,today:'2026-08-10',eligibility:'elegible',consents:[consent],completedVisits:[{id:'x1',visitaId:'v1'}],targetFor});
  assert.ok(issues.some(x=>x.code==='VISIT_DUPLICATE'));
});

test('advierte una visita fuera de ventana',()=>{
  const issues=Q.visit({visit:{id:'x',fecha:'2026-08-05',visitaId:'v1',tareas:[]},patient,study,today:'2026-08-10',eligibility:'elegible',consents:[consent],completedVisits:[],targetFor});
  assert.ok(issues.some(x=>x.code==='VISIT_OUTSIDE_WINDOW'&&x.level==='warning'));
});

test('exige motivo para un procedimiento no realizado',()=>{
  const base={visit:{id:'x',fecha:'2026-08-01',visitaId:null,nombreVisita:'Extra',tareas:[{nombre:'ECG',hecha:false,comentario:''}]},patient,study,today:'2026-08-10',eligibility:'elegible',consents:[consent],completedVisits:[],targetFor};
  assert.ok(Q.visit(base).some(x=>x.code==='PROCEDURE_REASON_REQUIRED'&&x.level==='block'));
  base.visit.tareas[0].comentario='Equipo no disponible';
  const issues=Q.visit(base);
  assert.ok(!issues.some(x=>x.code==='PROCEDURE_REASON_REQUIRED'));
  assert.ok(issues.some(x=>x.code==='PROCEDURES_NOT_DONE'&&x.level==='pending'));
});

test('bloquea randomización sin elegibilidad favorable',()=>{
  const issues=Q.randomization({record:{id:'r1',pacienteId:'p1',fecha:'2026-08-01'},patient,today:'2026-08-10',eligibility:'pendiente',consents:[consent],randomizations:[]});
  assert.ok(issues.some(x=>x.code==='RANDOMIZATION_NOT_ELIGIBLE'&&x.level==='block'));
});

test('bloquea randomización sin la versión vigente del consentimiento',()=>{
  const issues=Q.randomization({record:{id:'r1',pacienteId:'p1',fecha:'2026-08-01'},patient,today:'2026-08-10',eligibility:'elegible',consents:[consent],currentIcfVersion:'3.0',randomizations:[]});
  assert.ok(issues.some(x=>x.code==='RANDOMIZATION_CURRENT_CONSENT_MISSING'&&x.level==='block'));
});

test('bloquea fechas incompatibles de un evento adverso',()=>{
  const issues=Q.adverseEvent({record:{inicio:'2026-08-05',fin:'2026-08-04',serio:'No'},today:'2026-08-10'});
  assert.ok(issues.some(x=>x.code==='AE_END_BEFORE_START'&&x.level==='block'));
});

test('un EAS exige fecha de conocimiento pero permite dejar reporte pendiente',()=>{
  const sinConocimiento=Q.adverseEvent({record:{inicio:'2026-08-01',serio:'Sí'},today:'2026-08-10'});
  assert.ok(sinConocimiento.some(x=>x.code==='SAE_AWARENESS_REQUIRED'&&x.level==='block'));
  const pendiente=Q.adverseEvent({record:{inicio:'2026-08-01',serio:'Sí',conocido:'2026-08-02',grado:'3',ctcaeCode:'1001'},today:'2026-08-10'});
  assert.ok(!pendiente.some(x=>x.level==='block'));
  assert.ok(pendiente.some(x=>x.code==='SAE_REPORT_PENDING'&&x.level==='pending'));
});

test('bloquea reporte de EAS anterior al conocimiento',()=>{
  const issues=Q.adverseEvent({record:{inicio:'2026-08-01',serio:'Sí',conocido:'2026-08-03',reportado:'2026-08-02'},today:'2026-08-10'});
  assert.ok(issues.some(x=>x.code==='SAE_REPORT_BEFORE_AWARENESS'));
});

test('valida cronología del proceso de consentimiento',()=>{
  const issues=Q.consent({record:{fecha:'2026-08-01',hora:'11:00',horaFin:'10:30',copia:'Sí',quien:'Investigador'},today:'2026-08-10'});
  assert.ok(issues.some(x=>x.code==='CONSENT_TIME_ORDER'&&x.level==='block'));
});

test('rechaza fechas de calendario imposibles y acepta un día bisiesto válido',()=>{
  const bad=Q.adverseEvent({record:{inicio:'2026-02-30',serio:'No'},today:'2026-08-10'});
  assert.ok(bad.some(x=>x.code==='AE_START_REQUIRED'));
  const leap=Q.adverseEvent({record:{inicio:'2028-02-29',serio:'No'},today:'2028-03-01'});
  assert.equal(leap.length,0);
});

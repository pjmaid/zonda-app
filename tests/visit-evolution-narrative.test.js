const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const policy=require('../visit-evolution-policy.js');

const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const visitForm=html.slice(html.indexOf('id="view-visit-form"'),html.indexOf('id="view-evolution"'));

test('narra cada procedimiento sin inventar resultados',()=>{
  assert.equal(
    policy.describirProcedimiento({nombre:'Test de Schirmer',hecha:true}),
    'Se realizó la prueba de Schirmer prevista para la visita.'
  );
  const ecg=policy.describirProcedimiento({nombre:'ECG de 12 derivaciones',hecha:true,comentario:'Realizado a las 10:08; trazado informado como normal'});
  assert.match(ecg,/electrocardiograma indicado por el protocolo/);
  assert.match(ecg,/Realizado a las 10:08; trazado informado como normal\.$/);
});

test('integra un comentario general o genera un resumen prudente',()=>{
  assert.equal(
    policy.resumenVisita('V5',[{nombre:'ECG',hecha:true}], 'La visita se desarrolló sin incidencias'),
    'La visita se desarrolló sin incidencias.'
  );
  const automatico=policy.resumenVisita('V5',[{nombre:'ECG',hecha:true},{nombre:'Laboratorio',hecha:false}],'');
  assert.match(automatico,/visita V5/);
  assert.match(automatico,/1 procedimiento\(s\)/);
  assert.match(automatico,/efectivamente cargados/);
});

test('la mejora queda aislada en Visitas y evoluciones',()=>{
  assert.match(html,/<script src="visit-evolution-policy\.js"><\/script>/);
  assert.match(visitForm,/id="viProcComentario"/);
  assert.equal((html.match(/id="viProcComentario"/g)||[]).length,1);
  assert.match(html,/procedimientosComentario: \$\('viProcComentario'\)\.value\.trim\(\)/);
  assert.match(html,/ZondaVisitEvolution\.resumenVisita\(log\.nombreVisita, hechas, log\.procedimientosComentario\)/);
  assert.match(html,/ZondaVisitEvolution\.describirProcedimiento\(t\)/);
});

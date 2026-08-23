(function(root, factory){
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  root.ZondaVisitEvolution=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  const clean=v=>String(v||'').replace(/\s+/g,' ').trim();
  const key=v=>clean(v).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const sentence=v=>{
    const text=clean(v);
    return text&&!/[.!?]$/.test(text) ? text+'.' : text;
  };

  function baseDescripcion(nombre){
    const k=key(nombre);
    if(/schirmer/.test(k)) return 'Se realizó la prueba de Schirmer prevista para la visita.';
    if(/flujo salival|prueba de saliva|sialometr/.test(k)) return 'Se realizó la evaluación del flujo salival prevista para la visita.';
    if(/electrocard|\becg\b/.test(k)) return 'Se realizó el electrocardiograma indicado por el protocolo.';
    if(/examen fisico|evaluacion fisica/.test(k)) return 'Se efectuó el examen físico correspondiente a la visita.';
    if(/signos vitales|tension arterial|presion arterial/.test(k)) return 'Se controlaron los signos vitales según el procedimiento de la visita.';
    if(/cuestionario|\besspri\b|\bfacit\b|\beq-?5d\b|\bpss-?qol\b|\bphga\b|\bptga\b/.test(k))
      return 'Se completó la evaluación «'+clean(nombre)+'» prevista por el protocolo.';
    if(/administracion|dosis|producto de investigacion|\bimp\b/.test(k))
      return 'Se realizó «'+clean(nombre)+'» conforme a la indicación del protocolo.';
    if(/muestra|extraccion|farmacocinet|\bpk\b|\bpd\b/.test(k))
      return 'Se obtuvo «'+clean(nombre)+'» según el horario y las condiciones previstos para la visita.';
    return 'Se realizó el procedimiento «'+clean(nombre||'Procedimiento')+'» conforme a lo previsto para esta visita.';
  }

  function describirProcedimiento(task){
    const t=task||{}, base=baseDescripcion(t.nombre), detail=sentence(t.comentario);
    return detail ? base+' '+detail : base;
  }

  function resumenVisita(nombreVisita, tareas, comentario){
    const custom=sentence(comentario);
    if(custom) return custom;
    const hechas=(tareas||[]).filter(t=>t&&t.hecha);
    if(!hechas.length) return 'No se registraron procedimientos realizados en esta visita.';
    const nombre=clean(nombreVisita)||'programada';
    return 'Durante la visita '+nombre+' se realizaron '+hechas.length+
      ' procedimiento(s) previsto(s) por el protocolo. Los detalles, resultados y observaciones efectivamente cargados se describen a continuación.';
  }

  return {describirProcedimiento,resumenVisita};
});

(function(root, factory){
  const api = factory();
  if(typeof module==='object' && module.exports) module.exports=api;
  root.ZondaQuality=api;
})(typeof globalThis!=='undefined'?globalThis:this, function(){
  'use strict';

  const issue=(level,code,message,meta)=>Object.assign({level,code,message},meta||{});
  const iso=v=>String(v||'').trim();
  const isIso=v=>{
    const m=iso(v).match(/^(\d{4})-(\d{2})-(\d{2})$/); if(!m) return false;
    const y=+m[1], mo=+m[2], d=+m[3], dt=new Date(Date.UTC(y,mo-1,d));
    return dt.getUTCFullYear()===y&&dt.getUTCMonth()===mo-1&&dt.getUTCDate()===d;
  };
  const before=(a,b)=>isIso(a)&&isIso(b)&&a<b;
  const after=(a,b)=>isIso(a)&&isIso(b)&&a>b;
  const initialConsent=c=>!c.reconsent || c.reconsent==='Consentimiento inicial';
  const consentBefore=(consents,date)=>{
    const rows=(consents||[]).filter(c=>initialConsent(c)&&isIso(c.fecha)&&(!date||c.fecha<=date));
    return rows.sort((a,b)=>String(b.fecha||'').localeCompare(String(a.fecha||'')))[0]||null;
  };

  function visit(input){
    const x=input||{}, v=x.visit||{}, p=x.patient||{}, st=x.study||{}, out=[];
    if(!isIso(v.fecha)) out.push(issue('block','VISIT_DATE_REQUIRED','La visita necesita una fecha real válida.'));
    else if(x.today&&after(v.fecha,x.today)) out.push(issue('block','VISIT_DATE_FUTURE','La fecha real de la visita no puede ser futura.'));

    const signed=consentBefore(x.consents,v.fecha);
    if(!signed)
      out.push(issue('block','CONSENT_BEFORE_PROCEDURE','No hay un consentimiento inicial registrado antes o en la fecha de la visita.'));
    else if(x.currentIcfVersion && !(x.consents||[]).some(c=>isIso(c.fecha)&&c.fecha<=v.fecha&&String(c.version||'').trim()===String(x.currentIcfVersion).trim()))
      out.push(issue('warning','CURRENT_CONSENT_VERSION_MISSING','No consta la firma de la versión vigente del consentimiento ('+x.currentIcfVersion+').'));

    if(v.visitaId && (x.completedVisits||[]).some(r=>r.id!==v.id&&r.visitaId===v.visitaId))
      out.push(issue('block','VISIT_DUPLICATE','Esta visita del protocolo ya está registrada para el paciente.'));

    const protocolVisit=(st.visitas||[]).find(r=>r.id===v.visitaId);
    if(protocolVisit&&p.fechaBasal&&isIso(v.fecha)&&typeof x.targetFor==='function'){
      const target=x.targetFor(p,st,protocolVisit);
      if(target&&(before(v.fecha,target.from)||after(v.fecha,target.to)))
        out.push(issue('warning','VISIT_OUTSIDE_WINDOW','La visita está fuera de ventana ('+target.from+' a '+target.to+'). Documentá el desvío.',{from:target.from,to:target.to}));
    }

    const missed=(v.tareas||[]).filter(t=>!t.hecha);
    const unexplained=missed.filter(t=>!String(t.comentario||'').trim());
    if(unexplained.length)
      out.push(issue('block','PROCEDURE_REASON_REQUIRED','Hay procedimientos no realizados sin motivo: '+unexplained.map(t=>t.nombre).join(', ')+'.'));
    if(missed.length)
      out.push(issue('pending','PROCEDURES_NOT_DONE',missed.length+' procedimiento(s) no realizado(s) requieren evaluación de desviación.',{count:missed.length}));

    const name=String(v.nombreVisita||protocolVisit&&protocolVisit.nombre||'');
    if(/randomiz/i.test(name)&&x.eligibility!=='elegible')
      out.push(issue('block','RANDOMIZATION_NOT_ELIGIBLE','No se puede registrar una visita de randomización sin elegibilidad completa y favorable.'));
    return out;
  }

  function adverseEvent(input){
    const x=input||{}, r=x.record||{}, out=[];
    if(!isIso(r.inicio)) out.push(issue('block','AE_START_REQUIRED','El evento adverso necesita una fecha de inicio válida.'));
    else if(x.today&&after(r.inicio,x.today)) out.push(issue('block','AE_START_FUTURE','La fecha de inicio del evento adverso no puede ser futura.'));
    if(r.fin&&(!isIso(r.fin)||before(r.fin,r.inicio)))
      out.push(issue('block','AE_END_BEFORE_START','La fecha de fin no puede ser anterior a la fecha de inicio.'));
    if(r.serio==='Sí'){
      if(!isIso(r.conocido)) out.push(issue('block','SAE_AWARENESS_REQUIRED','Un EAS requiere la fecha de conocimiento por el sitio.'));
      if(r.reportado&&(!isIso(r.reportado)||before(r.reportado,r.conocido)))
        out.push(issue('block','SAE_REPORT_BEFORE_AWARENESS','La fecha de reporte no puede ser anterior al conocimiento por el sitio.'));
      if(r.reportado&&x.today&&after(r.reportado,x.today))
        out.push(issue('block','SAE_REPORT_FUTURE','La fecha de reporte del EAS no puede ser futura.'));
      if(!r.reportado) out.push(issue('pending','SAE_REPORT_PENDING','El EAS queda pendiente de reporte al patrocinador.'));
      if(!r.grado) out.push(issue('pending','SAE_GRADE_PENDING','Falta confirmar el grado CTCAE del EAS.'));
      if(!r.ctcaeCode) out.push(issue('pending','SAE_CTCAE_PENDING','Falta confirmar el término CTCAE del EAS.'));
    }
    return out;
  }

  function randomization(input){
    const x=input||{}, r=x.record||{}, out=[];
    if(!x.patient) return [issue('block','RANDOMIZATION_PATIENT_REQUIRED','La randomización requiere un paciente.')];
    if(!isIso(r.fecha)) out.push(issue('block','RANDOMIZATION_DATE_REQUIRED','La randomización requiere una fecha válida.'));
    else if(x.today&&after(r.fecha,x.today)) out.push(issue('block','RANDOMIZATION_DATE_FUTURE','La fecha de randomización no puede ser futura.'));
    if(x.eligibility!=='elegible') out.push(issue('block','RANDOMIZATION_NOT_ELIGIBLE','El paciente no tiene elegibilidad completa y favorable.'));
    if(!consentBefore(x.consents,r.fecha)) out.push(issue('block','RANDOMIZATION_WITHOUT_CONSENT','No hay consentimiento inicial registrado antes o en la fecha de randomización.'));
    else if(x.currentIcfVersion && !(x.consents||[]).some(c=>isIso(c.fecha)&&c.fecha<=r.fecha&&String(c.version||'').trim()===String(x.currentIcfVersion).trim()))
      out.push(issue('block','RANDOMIZATION_CURRENT_CONSENT_MISSING','No consta la firma de la versión vigente del consentimiento ('+x.currentIcfVersion+').'));
    if((x.randomizations||[]).some(q=>q.id!==r.id&&q.pacienteId===r.pacienteId))
      out.push(issue('block','RANDOMIZATION_DUPLICATE','El paciente ya tiene una randomización registrada.'));
    if(!String(r.numero||'').trim()) out.push(issue('pending','RANDOMIZATION_NUMBER_PENDING','Falta registrar el número de randomización.'));
    return out;
  }

  function consent(input){
    const x=input||{}, r=x.record||{}, out=[];
    if(!isIso(r.fecha)) out.push(issue('block','CONSENT_DATE_REQUIRED','El proceso de consentimiento requiere una fecha válida.'));
    else if(x.today&&after(r.fecha,x.today)) out.push(issue('block','CONSENT_DATE_FUTURE','La fecha del consentimiento no puede ser futura.'));
    if(r.hora&&r.horaFin&&r.horaFin<=r.hora)
      out.push(issue('block','CONSENT_TIME_ORDER','La hora de finalización debe ser posterior a la hora de inicio.'));
    if(r.copia!=='Sí') out.push(issue('warning','CONSENT_COPY_NOT_GIVEN','No consta la entrega de una copia firmada al participante.'));
    if(!String(r.quien||'').trim()) out.push(issue('pending','CONSENT_TAKER_PENDING','Falta identificar quién tomó el consentimiento.'));
    return out;
  }

  function byLevel(issues){
    const out={block:[],warning:[],pending:[]};
    for(const i of (issues||[])) (out[i.level]||(out[i.level]=[])).push(i);
    return out;
  }
  return {visit,adverseEvent,randomization,consent,consentBefore,byLevel};
});

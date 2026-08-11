(function(root, factory){
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  root.ZondaToday=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  const openState=v=>!['cerrada','cerrado','hecha','resuelto','finalizado'].includes(String(v||'').trim().toLowerCase());
  const before=(a,b)=>/^\d{4}-\d{2}-\d{2}$/.test(String(a||''))&&String(a)<String(b||'');
  const item=(level,kind,title,detail,r)=>({
    level,kind,title,detail:detail||'',recordType:r&&r.recordType||kind,
    recordId:r&&r.id||'',patientId:r&&r.pacienteId||'',studyId:r&&r.estudioId||''
  });

  function priorities(input){
    const x=input||{}, logs=x.logs||{}, today=String(x.today||''), out=[];
    for(const r of (logs.ea||[]).filter(r=>!r.anulado)){
      const title=(r.evento||'Evento adverso')+(r.serio==='Sí'?' (EAS)':'');
      if(r.serio==='Sí'&&!r.reportado)
        out.push(item('bad','ea',title,'Pendiente de reporte al patrocinador.',Object.assign({recordType:'ea'},r)));
      else if(!r.fin)
        out.push(item('warn','ea',title,'Evento en curso: requiere seguimiento.',Object.assign({recordType:'ea'},r)));
    }
    for(const r of (logs.queries||[]).filter(r=>!r.anulado&&openState(r.estado))){
      const overdue=before(r.vencimiento,today);
      out.push(item(overdue?'bad':'warn','queries',r.texto||r.visita||'Query abierta',
        overdue?'Vencida el '+r.vencimiento+'.':'Pendiente de respuesta.',Object.assign({recordType:'queries'},r)));
    }
    for(const r of (logs.desvios||[]).filter(r=>!r.anulado&&openState(r.estado)))
      out.push(item(r.clase==='Mayor / importante'?'bad':'warn','desvios',r.descripcion||'Desviación abierta',
        r.accion?'Acción correctiva en seguimiento.':'Falta documentar la acción correctiva.',Object.assign({recordType:'desvios'},r)));
    for(const r of (logs.tareas||[]).filter(r=>!r.anulado&&openState(r.estado))){
      const overdue=before(r.vencimiento,today);
      out.push(item(overdue?'bad':'warn','tareas',r.tarea||'Tarea pendiente',
        overdue?'Vencida el '+r.vencimiento+'.':'Pendiente del equipo.',Object.assign({recordType:'tareas'},r)));
    }
    if(+x.pendingAudit>0)
      out.push(item('bad','audit','Auditoría pendiente de sincronización',x.pendingAudit+' evento(s) todavía no confirmados por el servidor.'));
    const weight={bad:0,warn:1,gray:2};
    return out.sort((a,b)=>(weight[a.level]??9)-(weight[b.level]??9)||a.title.localeCompare(b.title));
  }
  return {priorities,openState};
});

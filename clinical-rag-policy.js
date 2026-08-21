(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  root.ZondaClinicalRag=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  const MAX_RETURN_RESULTS=25;
  const ALLOWED_DOCUMENT_TYPES=Object.freeze(['protocolo','manual','enmienda','ci']);
  const allowed=new Set(ALLOWED_DOCUMENT_TYPES);

  function clampMaxReturnResults(value){
    const parsed=Number.parseInt(value,10);
    if(!Number.isFinite(parsed)) return MAX_RETURN_RESULTS;
    return Math.max(1,Math.min(MAX_RETURN_RESULTS,parsed));
  }

  function isClinicalDocument(doc){
    return !!(doc&&doc.estudioId&&allowed.has(String(doc.tipo||''))&&!doc.pacienteId);
  }

  function clinicalDocuments(docs,studyId){
    if(!studyId) return [];
    return (Array.isArray(docs)?docs:[]).filter(doc=>doc.estudioId===studyId&&isClinicalDocument(doc));
  }

  function clinicalQueryPayload(payload){
    const out=Object.assign({},payload||{});
    if(!out.estudio_id) throw new Error('STUDY_SCOPE_REQUIRED');
    if(out.paciente_id) throw new Error('PATIENT_DATA_NOT_ALLOWED');
    out.max_fragmentos=clampMaxReturnResults(out.max_fragmentos);
    out.tipos_documento=ALLOWED_DOCUMENT_TYPES.slice();
    return out;
  }

  function citationDocument(citation){
    return String((citation&&(citation.documento||citation.titulo||citation.title))||'').trim();
  }

  function citationPage(citation){
    const value=citation&&(citation.pagina??citation.page??citation.pageNumber??citation.pageIdentifier);
    const parsed=Number.parseInt(String(value||'').replace(/\D+/g,''),10);
    return Number.isFinite(parsed)&&parsed>0?parsed:null;
  }

  function verifiedCitations(citations,documents){
    const titles=new Set((Array.isArray(documents)?documents:[]).filter(isClinicalDocument)
      .map(doc=>String(doc.filename||'').trim().toLowerCase()).filter(Boolean));
    return (Array.isArray(citations)?citations:[]).map(c=>Object.assign({},c,{
      documento:citationDocument(c),pagina:citationPage(c)
    })).filter(c=>c.documento&&c.pagina&&titles.has(c.documento.toLowerCase()));
  }

  function requireCitedClinicalAnswer(answer,documents){
    const citations=verifiedCitations(answer&&answer.citas,documents);
    if(!String((answer&&answer.respuesta)||'').trim()||!citations.length)
      throw new Error('CLINICAL_CITATIONS_REQUIRED');
    return Object.assign({},answer,{citas:citations});
  }

  return {MAX_RETURN_RESULTS,ALLOWED_DOCUMENT_TYPES,clampMaxReturnResults,isClinicalDocument,
    clinicalDocuments,clinicalQueryPayload,verifiedCitations,requireCitedClinicalAnswer};
});

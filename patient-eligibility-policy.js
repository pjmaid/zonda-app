(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  root.ZondaPatientEligibility=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  function escapeRegExp(value){
    return String(value||'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  }

  function deidentifyText(value,identifiers){
    let text=String(value||''),replacements=0;
    const replace=(pattern,label)=>{
      text=text.replace(pattern,()=>{ replacements++; return label; });
    };
    replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,'[EMAIL OMITIDO]');
    replace(/\b(?:DNI|CUIL|CUIT|documento|doc\.?)[\s:#-]*(?:\d[ .-]?){7,11}\b/gi,'[DOCUMENTO OMITIDO]');
    replace(/\b(?:tel(?:e(?:fono|fono))?|cel(?:ular)?|whatsapp)[\s:+()-]*(?:\d[\s().-]?){7,15}\b/gi,'[TELÉFONO OMITIDO]');
    replace(/\b(?:HC|historia\s+cl[ií]nica|n[°ºo]\s*de\s*historia)[\s:#-]*[A-Z0-9-]{4,}\b/gi,'[HISTORIA CLÍNICA OMITIDA]');
    for(const raw of (Array.isArray(identifiers)?identifiers:[]).slice(0,50)){
      const identifier=String(raw||'').trim();
      if(identifier.length<2||identifier.length>100) continue;
      replace(new RegExp(escapeRegExp(identifier),'giu'),'[IDENTIFICADOR OMITIDO]');
    }
    return {text,replacements};
  }

  function citationDocument(citation){
    return String((citation&&(citation.documento||citation.titulo||citation.title))||'').trim();
  }

  function citationPage(citation){
    const value=citation&&(citation.pagina??citation.page??citation.pageNumber??citation.pageIdentifier);
    const parsed=Number.parseInt(String(value||'').replace(/\D+/g,''),10);
    return Number.isFinite(parsed)&&parsed>0?parsed:null;
  }

  function citationKey(citation){
    const document=citationDocument(citation).toLowerCase();
    const page=citationPage(citation);
    return document&&page?document+'#'+page:'';
  }

  function verifiedCriterionCitations(items,verifiedCitations){
    const allowed=new Set((Array.isArray(verifiedCitations)?verifiedCitations:[]).map(citationKey).filter(Boolean));
    const out={};
    for(const item of (Array.isArray(items)?items:[])){
      const key=String(item&&item.clave||'').toLowerCase();
      const citation={documento:citationDocument(item),pagina:citationPage(item),cita:String(item&&item.cita||'').trim()};
      if(/^[ie]\d{1,2}$/.test(key)&&citation.cita&&allowed.has(citationKey(citation))) out[key]=citation;
    }
    return out;
  }

  function applyCitationGate(results,citationsByCriterion){
    return (Array.isArray(results)?results:[]).map(result=>{
      const key=String(result&&result.clave||'').trim().toLowerCase();
      const response=String(result&&result.respuesta||'').toLowerCase().replace('í','i');
      const citation=(citationsByCriterion||{})[key]||null;
      const valid=/^[ie]\d{1,2}$/.test(key)&&['si','no','pendiente'].includes(response);
      return Object.assign({},result,{clave:key,respuesta:valid&&citation?response:'pendiente',citaProtocolo:citation,confiable:!!(valid&&citation)});
    }).filter(result=>/^[ie]\d{1,2}$/.test(result.clave));
  }

  return {deidentifyText,citationDocument,citationPage,citationKey,verifiedCriterionCitations,applyCitationGate};
});

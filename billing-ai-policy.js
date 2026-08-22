(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  root.ZondaBillingAI=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  function normalize(value){
    return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  }

  function allowedContracts(documents,studyId){
    const expected=String(studyId||'');
    return (Array.isArray(documents)?documents:[]).filter(doc=>doc&&doc.tipo==='contrato'&&String(doc.estudioId||'')===expected);
  }

  function documentTokens(doc){
    const filename=String(doc&&doc.filename||'').trim();
    const base=filename.replace(/\.[^.]+$/,'');
    return [filename,base].map(normalize).filter(token=>token.length>=4);
  }

  function hasLocation(citation){
    const text=String(citation||'');
    return /(?:p(?:a|á)g(?:ina)?\.?|p\.)\s*\d{1,5}\b/i.test(text) ||
      /\b(?:cl[aá]usula|secci[oó]n|apartado|anexo)\s+[a-z0-9][a-z0-9.()\-]{0,30}/i.test(text);
  }

  function citationDocument(citation,documents){
    const normalized=normalize(citation);
    return (Array.isArray(documents)?documents:[]).find(doc=>documentTokens(doc).some(token=>normalized.includes(token)))||null;
  }

  function verifyCitation(citation,documents,studyId){
    const allowed=allowedContracts(documents,studyId);
    const doc=citationDocument(citation,allowed);
    return {
      valid:!!(doc&&hasLocation(citation)),
      document:doc||null,
      location:hasLocation(citation),
      text:String(citation||'').trim()
    };
  }

  function verifyAnswer(answer,documents,studyId){
    const brackets=String(answer||'').match(/\[[^\]\r\n]{4,500}\]/g)||[];
    const citations=brackets.map(text=>verifyCitation(text,documents,studyId));
    return {trusted:citations.some(item=>item.valid),citations};
  }

  function gateTariffRows(rows,documents,studyId){
    return (Array.isArray(rows)?rows:[]).map(row=>{
      const citation=verifyCitation(row&&row.cita,documents,studyId);
      return Object.assign({},row,{citaValida:citation.valid,fuenteVerificada:citation.document||null});
    });
  }

  return {normalize,allowedContracts,hasLocation,citationDocument,verifyCitation,verifyAnswer,gateTariffRows};
});

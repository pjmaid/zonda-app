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
      const value=row&&row.valor;
      const valorValido=value!==null&&value!==undefined&&String(value).trim()!==''&&Number.isFinite(Number(value));
      return Object.assign({},row,{citaValida:citation.valid&&valorValido,valorValido,fuenteVerificada:citation.document||null});
    });
  }

  function visitKey(value){
    const text=normalize(value);
    const numbered=text.match(/\b(?:v|visita)\s*0*(\d+)\b/);
    if(numbered) return 'v'+Number(numbered[1]);
    if(/\b(?:seleccion|preseleccion|screening|screen)\b/.test(text)) return 'seleccion';
    return text;
  }

  function reconcileTariffRows(rows,studyVisits,documents,studyId){
    const pending=gateTariffRows(rows,documents,studyId).slice();
    const result=[];
    for(const visit of (Array.isArray(studyVisits)?studyVisits:[])){
      const name=String(typeof visit==='string'?visit:(visit&&visit.nombre)||'').trim();
      if(!name) continue;
      const key=visitKey(name);
      const index=pending.findIndex(row=>visitKey(row&&row.nombre)===key);
      if(index>=0){
        const matched=pending.splice(index,1)[0];
        result.push(Object.assign({},matched,{nombre:name,faltante:false}));
      }else result.push({nombre:name,valor:null,cita:'',citaValida:false,valorValido:false,fuenteVerificada:null,faltante:true});
    }
    return result.concat(pending.map(row=>Object.assign({},row,{faltante:false})));
  }

  function contractTariffExcerpt(text,maxChars){
    const source=String(text||''), limit=Math.max(1000,Number(maxChars)||0);
    if(source.length<=limit) return source;
    const ranges=[
      [0,Math.min(source.length,Math.floor(limit*.12))],
      [Math.max(0,source.length-Math.floor(limit*.20)),source.length]
    ];
    const strong=/(?:tarif|presupuest|budget|payment|pago|honorario|fee schedule|financial|anexo)/gi;
    let match, guard=0;
    while((match=strong.exec(source))&&guard++<40)
      ranges.push([Math.max(0,match.index-700),Math.min(source.length,match.index+6500)]);
    ranges.sort((a,b)=>a[0]-b[0]);
    const merged=[];
    for(const range of ranges){
      const last=merged[merged.length-1];
      if(last&&range[0]<=last[1]) last[1]=Math.max(last[1],range[1]); else merged.push(range.slice());
    }
    let out='';
    for(const [start,end] of merged){
      if(out.length>=limit) break;
      const room=limit-out.length;
      out+=(out?'\n\n[…continuación relevante…]\n\n':'')+source.slice(start,Math.min(end,start+room));
    }
    return out.slice(0,limit);
  }

  return {normalize,allowedContracts,hasLocation,citationDocument,verifyCitation,verifyAnswer,gateTariffRows,visitKey,reconcileTariffRows,contractTariffExcerpt};
});

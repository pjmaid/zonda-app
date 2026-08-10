(function(root, factory){
  const api = factory();
  if(typeof module==='object' && module.exports) module.exports=api;
  else root.ZondaRelease=api;
})(typeof globalThis!=='undefined'?globalThis:this, function(){
  'use strict';
  const BACKUP_SCHEMA_VERSION=5;
  const REQUIRED_COLLECTIONS=['studies','patients','visits'];
  const OPTIONAL_COLLECTIONS=['docs','settings'];
  const FORBIDDEN_KEYS=new Set(['__proto__','prototype','constructor']);

  function escapeHtml(value){
    return String(value==null?'':value).replace(/[&<>"']/g, c=>({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  function assertPlain(value, path, seen){
    if(value===null || typeof value!=='object') return;
    if(seen.has(value)) throw new Error('El respaldo contiene una referencia circular en '+path+'.');
    seen.add(value);
    if(Array.isArray(value)) value.forEach((item,i)=>assertPlain(item,path+'['+i+']',seen));
    else {
      const proto=Object.getPrototypeOf(value);
      if(proto!==Object.prototype && proto!==null) throw new Error('Objeto no válido en '+path+'.');
      for(const key of Object.keys(value)){
        if(FORBIDDEN_KEYS.has(key)) throw new Error('Clave no permitida en '+path+'.');
        assertPlain(value[key],path+'.'+key,seen);
      }
    }
    seen.delete(value);
  }

  function normalizeBackup(raw){
    if(!raw || typeof raw!=='object') throw new Error('El archivo no contiene un objeto JSON válido.');
    assertPlain(raw,'respaldo',new Set());
    if(raw.manifest && raw.payload) return {manifest:raw.manifest,payload:raw.payload,legacy:false};
    if(Array.isArray(raw.studies) && Array.isArray(raw.patients) && Array.isArray(raw.visits)){
      return {manifest:{app:raw.app||'evoluciones-ec',schemaVersion:Number(raw.version||4),legacy:true},payload:raw,legacy:true};
    }
    throw new Error('El archivo no parece un respaldo de Zonda válido.');
  }

  function validateCollection(name, value, required){
    if(value==null && !required) return [];
    if(!Array.isArray(value)) throw new Error('La colección '+name+' debe ser una lista.');
    const ids=new Set();
    for(let i=0;i<value.length;i++){
      const item=value[i];
      if(!item || typeof item!=='object' || Array.isArray(item)) throw new Error(name+'['+i+'] no es un registro válido.');
      if(typeof item.id!=='string' || !item.id.trim()) throw new Error(name+'['+i+'] no tiene un ID válido.');
      if(ids.has(item.id)) throw new Error('El respaldo contiene un ID duplicado en '+name+': '+item.id+'.');
      ids.add(item.id);
    }
    return value;
  }

  function validateBackup(raw){
    const normalized=normalizeBackup(raw), payload=normalized.payload;
    const app=String(normalized.manifest.app||'').toLowerCase();
    if(app && app!=='zonda' && app!=='evoluciones-ec') throw new Error('El archivo pertenece a otra aplicación.');
    const schema=Number(normalized.manifest.schemaVersion||0);
    if(schema>BACKUP_SCHEMA_VERSION) throw new Error('El respaldo fue creado por una versión más nueva de Zonda.');
    for(const name of REQUIRED_COLLECTIONS) validateCollection(name,payload[name],true);
    for(const name of OPTIONAL_COLLECTIONS) validateCollection(name,payload[name],false);
    if(payload.logs!=null && (typeof payload.logs!=='object' || Array.isArray(payload.logs))) throw new Error('La colección logs no es válida.');
    if(payload.checklists!=null && (typeof payload.checklists!=='object' || Array.isArray(payload.checklists))) throw new Error('La colección checklists no es válida.');
    return normalized;
  }

  function countLogRecords(logs){
    return Object.values(logs||{}).reduce((n,list)=>n+(Array.isArray(list)?list.length:0),0);
  }

  function restorePlan(payload,current){
    const result={collections:{},creates:0,updates:0,unchanged:0};
    for(const name of ['studies','patients','visits','docs','settings']){
      const incoming=Array.isArray(payload[name])?payload[name]:[];
      const existing=new Map((Array.isArray(current[name])?current[name]:[]).map(x=>[x.id,x]));
      let creates=0,updates=0,unchanged=0;
      for(const item of incoming){
        if(!existing.has(item.id)) creates++;
        else if(JSON.stringify(existing.get(item.id))===JSON.stringify(item)) unchanged++;
        else updates++;
      }
      result.collections[name]={total:incoming.length,creates,updates,unchanged};
      result.creates+=creates; result.updates+=updates; result.unchanged+=unchanged;
    }
    result.logRecords=countLogRecords(payload.logs);
    result.checklists=Object.keys(payload.checklists||{}).length;
    return result;
  }

  function canonicalStringify(value){
    if(value===undefined) return 'null';
    if(value===null || typeof value!=='object') return JSON.stringify(value);
    if(Array.isArray(value)) return '['+value.map(canonicalStringify).join(',')+']';
    return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonicalStringify(value[k])).join(',')+'}';
  }

  return {BACKUP_SCHEMA_VERSION,escapeHtml,normalizeBackup,validateBackup,restorePlan,canonicalStringify};
});

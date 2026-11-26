const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
const requestSource=html.slice(html.indexOf('function storagePrefijo('),html.indexOf('const DOC_UPLOAD_FILES='));
const uploadSource=html.slice(html.indexOf('const DOC_UPLOAD_FILES='),html.indexOf('async function docBlob('));
const file=()=>Object.assign(new Blob(['original'],{type:'application/pdf'}),{name:'contrato.pdf'});
const documentDraft=(id='d1')=>({id,estudioId:'s1',tipo:'contrato',filename:'contrato.pdf',storage:'supabase',path:''});
function context(extra={}){
  const ctx=vm.createContext({SESSION:{id:'s'},MEMBRESIA:{org_id:'org1',user_id:'u1'},DB:{docs:[]},Blob,crypto:webcrypto,
    assertSameSession(session){if(ctx.SESSION!==session){const e=new Error('La sesión cambió');e.sessionChanged=true;throw e;}},...extra});
  return ctx;
}
test('sube sin upsert y codifica cada segmento de una ruta histórica',async()=>{
  const calls=[],ctx=context({supaFetch:async(path,options)=>{calls.push({path,options});return new Response('{}');}});
  vm.runInContext(requestSource,ctx);await ctx.storagePut('estudio/id/archivo #1.pdf',file());
  assert.equal(calls[0].options.headers['x-upsert'],'false');
  assert.equal(calls[0].path,'/storage/v1/object/ec-docs/org1/estudio/id/archivo%20%231.pdf');
});
test('un conflicto con bytes idénticos confirma el reintento sin reemplazar el original',async()=>{
  const calls=[],blob=file(),ctx=context({supaFetch:async(path,options)=>{
    calls.push(options.method);
    return options.method==='POST'?new Response(JSON.stringify({code:'Duplicate',statusCode:'409'}),{status:400}):new Response(blob);
  }});
  vm.runInContext(requestSource,ctx);await ctx.storagePut('s1/d1/contrato.pdf',blob);
  assert.deepEqual(calls,['POST','GET']);
});
test('un conflicto con bytes distintos conserva ambos archivos sin ejecutar UPDATE',async()=>{
  const calls=[],ctx=context({supaFetch:async(path,options)=>{
    calls.push(options.method);
    return options.method==='POST'?new Response('{}',{status:409}):new Response(new Blob(['distinto']));
  }});
  vm.runInContext(requestSource,ctx);
  await assert.rejects(ctx.storagePut('s1/d1/contrato.pdf',file()),/no se sobrescribió/);
  assert.deepEqual(calls,['POST','GET']);
});
test('un cambio de sesión durante la respuesta de conflicto no lee el objeto con otra cuenta',async()=>{
  let calls=0;const ctx=context({supaFetch:async()=>{
    calls++;return {ok:false,status:409,json:async()=>{ctx.SESSION={id:'other'};return {};}};
  }});
  vm.runInContext(requestSource,ctx);await assert.rejects(ctx.storagePut('s1/d1/contrato.pdf',file()),/sesión cambió/);
  assert.equal(calls,1);
});
function uploader(extra={}){
  const calls=[];const ctx=context({calls,storagePut:async path=>{calls.push(['file',path]);},
    Store:{online:()=>true,async refreshOne(){calls.push(['refresh']);},async upsert(kind,doc){calls.push(['metadata',doc.id]);ctx.DB.docs=[{...doc}];}},...extra});
  vm.runInContext(uploadSource,ctx);return ctx;
}
test('la publicación de metadatos ocurre después de subir y no elimina un archivo ante respuesta incierta',async()=>{
  const ctx=uploader();ctx.Store.upsert=async()=>{ctx.calls.push(['metadata-failed']);throw Error('Respuesta perdida');};
  await assert.rejects(ctx.guardarDocumentoArchivo(documentDraft(),file()),/Respuesta perdida/);
  assert.deepEqual(ctx.calls,[['file','s1/d1/contrato.pdf'],['metadata-failed']]);
});
test('un reintento reconcilia una ficha ya confirmada sin duplicar archivo ni documento',async()=>{
  const ctx=uploader(),blob=file();let committed;
  ctx.Store.upsert=async(kind,doc)=>{committed={...doc};throw Error('Respuesta perdida');};
  ctx.Store.refreshOne=async(kind,id)=>{assert.equal(id,'d1');ctx.DB.docs=[committed];};
  await assert.rejects(ctx.guardarDocumentoArchivo(documentDraft(),blob),/Respuesta perdida/);
  const retry=documentDraft('d2');await ctx.guardarDocumentoArchivo(retry,blob);
  assert.equal(retry.id,'d1');assert.equal(ctx.DB.docs.length,1);
  assert.equal(ctx.calls.filter(c=>c[0]==='file').length,1);
});
test('si la ficha no se confirmó reintenta con el mismo ID y la misma ruta privada',async()=>{
  const ctx=uploader(),blob=file();let attempts=0;const save=ctx.Store.upsert;
  ctx.Store.upsert=async(kind,doc)=>{if(++attempts===1)throw Error('Sin confirmar');return save(kind,doc);};
  await assert.rejects(ctx.guardarDocumentoArchivo(documentDraft(),blob),/Sin confirmar/);
  const retry=documentDraft('d2');await ctx.guardarDocumentoArchivo(retry,blob);
  assert.equal(retry.id,'d1');assert.equal(ctx.DB.docs.length,1);
  assert.deepEqual(ctx.calls.filter(c=>c[0]==='file').map(c=>c[1]),['s1/d1/contrato.pdf','s1/d1/contrato.pdf']);
});
test('la carga fallida no publica una ficha y un cambio de sesión impide continuar',async()=>{
  const ctx=uploader();ctx.storagePut=async()=>{throw Error('Sin conexión');};
  await assert.rejects(ctx.guardarDocumentoArchivo(documentDraft(),file()),/Sin conexión/);
  assert.equal(ctx.DB.docs.length,0);
  ctx.storagePut=async()=>{ctx.SESSION={id:'other'};};
  await assert.rejects(ctx.guardarDocumentoArchivo(documentDraft(),file()),/sesión cambió/);
  assert.equal(ctx.DB.docs.length,0);
});
test('la memoria de reintentos no reutiliza una ficha al cambiar de organización o autor',async()=>{
  const ctx=uploader(),blob=file();ctx.Store.upsert=async()=>{throw Error('Sin confirmar');};
  await assert.rejects(ctx.guardarDocumentoArchivo(documentDraft(),blob));
  ctx.MEMBRESIA={org_id:'org2',user_id:'u2'};ctx.Store.upsert=async(kind,doc)=>{ctx.DB.docs=[{...doc}];};
  const next=documentDraft('d2');await ctx.guardarDocumentoArchivo(next,blob);
  assert.equal(next.id,'d2');assert.equal(next.path,'s1/d2/contrato.pdf');
});

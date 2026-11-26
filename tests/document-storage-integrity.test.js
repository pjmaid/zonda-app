const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {stripTypeScriptTypes} = require('node:module');
const {webcrypto} = require('node:crypto');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const edge = fs.readFileSync(path.join(root, 'supabase/functions/rag/index.ts'), 'utf8');
const clinical = require(path.join(root, 'clinical-rag-policy.js'));
const clone = x => JSON.parse(JSON.stringify(x));
const reply = (body, status = 200) => new Response(JSON.stringify(body), {status});
const doc = () => ({id:'d1', estudioId:'s1', tipo:'protocolo', filename:'protocolo.pdf', storage:'supabase', path:'s1/d1/protocolo.pdf', ragIndexado:'2026-01-01'});

function frontend(overrides = {}) {
  const stored = doc(), calls = [], blob = new Blob(['original']);
  const ctx = vm.createContext({
    SESSION:{id:'session'}, MEMBRESIA:{rol:'admin',org_id:'org1'}, DB:{docs:[stored]},
    ZondaClinicalRag:clinical, calls, Blob, URL, setTimeout:()=>{}, T:x=>x,
    document:{createElement:()=>({click(){calls.push('download');}})},
    assertSameSession(session){if(session!==ctx.SESSION){const error=new Error('La sesión cambió');error.sessionChanged=true;throw error;}},
    auditResumen:()=>'', canFact:()=>true, ragActivo:()=>false,
    ragDocId:d=>'doc-'+d.id, ragLlamar:async input=>{calls.push(input.accion);return {ok:true};},
    storageGet:async()=>blob, storageDel:async()=>{calls.push('delete-file');},
    storagePut:async(_path, restored)=>{assert.equal(restored,blob);calls.push('restore-file');},
    Store:{online:()=>true,
      async upsert(_kind, value){calls.push('save-marker');ctx.DB.docs=[clone(value)];},
      async remove(){calls.push('delete-record');ctx.DB.docs=[];}
    }, ...overrides
  });
  vm.runInContext(html.slice(html.indexOf('async function docBlob('),html.indexOf("$('btnUploadDoc').addEventListener"))+
    html.slice(html.indexOf('function ragFallo('),html.indexOf('/* consulta con recuperación:'))+
    '\nthis.removeDocument=eliminarDocumentoSeguro;this.clearIndex=ragBorrar;this.indexDocument=ragIndexarDetalle;this.recovery=DOC_RECOVERY_FILES;',ctx);
  return ctx;
}

test('el PDF de muestra se abre en su centro y se conserva si falla la eliminación de su ficha', async()=>{
  const pdf='%PDF-1.4\nPDF de muestra\n%%EOF';
  const sample={id:'zd26-doc-1',estudioId:'zd26-s1',storage:'demo-pdf',mime:'application/pdf',
    demoPdfBase64:Buffer.from(pdf).toString('base64'), size:pdf.length};
  const ctx=frontend({atob,MEMBRESIA:{rol:'admin',org_id:'55e431c7-c6a9-4e71-91a0-5fea8b21a184'},DB:{docs:[sample]}});
  assert.equal(await (await ctx.docBlob(sample)).text(),pdf);
  assert.equal(await ctx.docBlob({...sample,size:sample.size+1}),null);
  ctx.Store.remove=async()=>{throw Error('Conflicto');};
  await assert.rejects(ctx.removeDocument(sample),/Conflicto/);
  assert.equal(await (await ctx.docBlob(sample)).text(),pdf);
  assert.deepEqual(ctx.calls,[]);
  ctx.MEMBRESIA.org_id='otro-centro';
  assert.equal(await ctx.docBlob(sample),null);
});

test('no elimina registros ni índices si el original no se puede respaldar', async()=>{
  const ctx=frontend({storageGet:async()=>null});
  await assert.rejects(ctx.removeDocument(ctx.DB.docs[0]),/copia del archivo/);
  assert.deepEqual(ctx.calls,[]);
  assert.equal(ctx.DB.docs.length,1);
});

test('un fallo de desindexación conserva el original y el registro',async()=>{
  const ctx=frontend({ragLlamar:async()=>{throw Error('Índice inaccesible');}});
  await assert.rejects(ctx.removeDocument(ctx.DB.docs[0]),/Índice inaccesible/);
  assert.deepEqual(ctx.calls,[]);
  assert.ok(ctx.DB.docs[0].ragIndexado);
});

test('compensa el fallo de metadatos y permite reintentar sin marcador obsoleto',async()=>{
  const ctx=frontend();let fail=true;
  ctx.Store.remove=async()=>{ctx.calls.push('delete-record');if(fail)throw Error('Conflicto');ctx.DB.docs=[];};
  await assert.rejects(ctx.removeDocument(ctx.DB.docs[0]),/archivo fue restaurado/);
  assert.equal(ctx.DB.docs[0].ragIndexado,undefined);
  assert.deepEqual(ctx.calls,['borrar','save-marker','delete-file','delete-record','restore-file']);
  fail=false;await ctx.removeDocument(ctx.DB.docs[0]);
  assert.equal(ctx.DB.docs.length,0);
  assert.equal(ctx.calls.filter(x=>x==='borrar').length,1);
});

test('una respuesta perdida de Storage también activa la restauración',async()=>{
  const ctx=frontend({storageDel:async()=>{throw Error('Respuesta perdida');}});
  await assert.rejects(ctx.removeDocument(ctx.DB.docs[0]),/archivo fue restaurado/);
  assert.ok(ctx.calls.includes('restore-file'));
  assert.ok(!ctx.calls.includes('delete-record'));
});

test('si falla la restauración conserva una copia y no muestra éxito',async()=>{
  const ctx=frontend({storagePut:async()=>{throw Error('Sin red');}});
  ctx.Store.remove=async()=>{throw Error('Fallo de metadatos');};
  await assert.rejects(ctx.removeDocument(ctx.DB.docs[0]),/copia de recuperación/);
  assert.equal(ctx.recovery.size,1);
  assert.ok(ctx.calls.includes('download'));
});

test('el cambio de sesión no restaura el archivo dentro de otra organización',async()=>{
  const ctx=frontend();
  ctx.storageDel=async()=>{ctx.SESSION={id:'otra-sesion'};};
  await assert.rejects(ctx.removeDocument(ctx.DB.docs[0]),/La sesión cambió/);
  assert.ok(!ctx.calls.includes('restore-file'));
  assert.ok(!ctx.calls.includes('delete-record'));
  assert.ok(!ctx.calls.includes('download'));
  assert.equal(ctx.recovery.size,0);
});

test('dos eliminaciones simultáneas no duplican las operaciones',async()=>{
  let resolve;const waiting=new Promise(done=>{resolve=done;});
  const ctx=frontend({storageGet:async()=>waiting});const original=ctx.DB.docs[0];
  const first=ctx.removeDocument(original);
  await assert.rejects(ctx.removeDocument(original),/ya se está eliminando/);
  resolve(new Blob(['original']));await first;
  assert.equal(ctx.calls.filter(x=>x==='delete-record').length,1);
});

test('los documentos históricos no clínicos se depuran con RAG desactivado',async()=>{
  const ctx=frontend();const historical={...ctx.DB.docs[0],tipo:'historia',pacienteId:'p1'};
  await ctx.clearIndex(historical);
  assert.deepEqual(ctx.calls,['purgar_legacy','save-marker']);
  assert.equal(ctx.DB.docs[0].ragIndexado,undefined);
});

test('un fallo al guardar el marcador no declara una indexación completa',async()=>{
  const ctx=frontend({ragActivo:()=>true});
  const source={...ctx.DB.docs[0]};delete source.ragIndexado;
  ctx.Store.upsert=async()=>{throw Error('No se guardó');};
  const result=await ctx.indexDocument(source,'Texto de prueba suficientemente extenso para enviarlo al índice externo.');
  assert.equal(result.ok,false);assert.equal(result.etapa,'registro');
  assert.equal(source.ragIndexado,undefined);
  assert.ok(!ctx.calls.includes('indexar'));
});

test('un envío confirmado remotamente conserva la intención si falla el guardado final y puede retirarse',async()=>{
  const ctx=frontend({ragActivo:()=>true});
  const source={...ctx.DB.docs[0]};delete source.ragIndexado;ctx.DB.docs=[source];
  const save=ctx.Store.upsert;let saves=0;
  ctx.Store.upsert=async(kind,value)=>{if(++saves===2)throw Error('Confirmación perdida');await save(kind,value);};
  const result=await ctx.indexDocument(source,'Texto de prueba suficientemente extenso para enviarlo al índice externo.');
  assert.equal(result.etapa,'registro');assert.ok(ctx.DB.docs[0].ragPendiente);
  assert.equal(ctx.DB.docs[0].ragIndexado,undefined);
  await ctx.removeDocument(ctx.DB.docs[0]);
  assert.ok(ctx.calls.includes('borrar'));assert.equal(ctx.DB.docs.length,0);
});

test('una respuesta externa perdida deja un envío pendiente y el reintento reutiliza el documento',async()=>{
  const ctx=frontend({ragActivo:()=>true});let attempt=0;
  ctx.ragLlamar=async input=>{assert.equal(input.source_doc_id,'d1');if(++attempt===1)throw Error('Respuesta perdida');return {ok:true};};
  const text='Texto de prueba suficientemente extenso para enviarlo al índice externo.';
  assert.equal((await ctx.indexDocument(ctx.DB.docs[0],text)).etapa,'envio');
  assert.ok(ctx.DB.docs[0].ragPendiente);
  assert.equal((await ctx.indexDocument(ctx.DB.docs[0],text)).ok,true);
  assert.equal(ctx.DB.docs.length,1);assert.equal(ctx.DB.docs[0].ragPendiente,undefined);
});

test('desindexar nunca guarda metadatos de la sesión anterior con una sesión nueva',async()=>{
  const ctx=frontend();ctx.ragLlamar=async()=>{ctx.SESSION={id:'new'};return {ok:true};};
  await assert.rejects(ctx.clearIndex(ctx.DB.docs[0]),/La sesión cambió/);
  assert.ok(!ctx.calls.includes('save-marker'));
});

test('indexar no registra el resultado remoto en otra sesión',async()=>{
  const ctx=frontend({ragActivo:()=>true});
  ctx.ragLlamar=async()=>{ctx.SESSION={id:'new'};return {ok:true};};
  await assert.rejects(ctx.indexDocument(ctx.DB.docs[0],'Texto de prueba suficientemente extenso para enviarlo al índice externo.'),/La sesión cambió/);
  assert.equal(ctx.calls.filter(x=>x==='save-marker').length,1);
});

test('cambiar sesión durante el registro previo impide enviar el documento',async()=>{
  const ctx=frontend({ragActivo:()=>true});
  ctx.Store.upsert=async()=>{ctx.SESSION={id:'new'};};
  await assert.rejects(ctx.indexDocument(ctx.DB.docs[0],'Texto de prueba suficientemente extenso para enviarlo al índice externo.'),/La sesión cambió/);
  assert.ok(!ctx.calls.includes('indexar'));
});

test('un fallo al guardar la desindexación conserva el original y permite reintentar',async()=>{
  const ctx=frontend();ctx.Store.upsert=async()=>{throw Error('Conflicto al guardar');};
  await assert.rejects(ctx.removeDocument(ctx.DB.docs[0]),/Conflicto al guardar/);
  assert.deepEqual(ctx.calls,['borrar']);assert.ok(ctx.DB.docs[0].ragIndexado);
});

test('abrir un adjunto HTML o SVG lo descarga sin ejecutar contenido activo',async()=>{
  const opened=[],downloaded=[];
  const ctx=vm.createContext({DB:{docs:[{id:'d1',filename:'adjunto.html'}]},Blob,URL,setTimeout:()=>{},
    docBlob:async()=>new Blob(['<script>bad()</script>'],{type:'text/html'}),
    document:{createElement:()=>({click(){downloaded.push(this.download);}})},window:{open:(...args)=>opened.push(args)}
  });
  vm.runInContext(html.slice(html.indexOf('async function openDoc('),html.indexOf('async function downloadDoc(')),ctx);
  await ctx.openDoc('d1');assert.equal(opened.length,0);assert.deepEqual(downloaded,['adjunto.html']);
  ctx.docBlob=async()=>new Blob(['<svg/>'],{type:'image/svg+xml'});await ctx.openDoc('d1');assert.equal(opened.length,0);
  ctx.docBlob=async()=>new Blob(['%PDF'],{type:'application/pdf'});await ctx.openDoc('d1');assert.equal(opened[0][2],'noopener,noreferrer');
});

test('si falla la eliminación del comprobante restaura el gasto antes de informar el error',async()=>{
  const calls=[],gasto={id:'g1',detalle:'Traslado'},receipt=doc();
  const ctx=vm.createContext({SESSION:{id:'session'},FACT_GASTOS:{gasto_remis:{titulo:'Gasto de remís'}},
    $:()=>({value:'s1'}),factGastos:()=>[gasto],factGastoComprobante:()=>receipt,canFact:()=>true,confirm:()=>true,
    assertSameSession:()=>{},eliminarDocumentoSeguro:async()=>{calls.push('remove-doc');throw Error('Archivo conservado');},
    Store:{remove:async()=>{calls.push('remove-expense');},upsert:async(_kind,value)=>{assert.equal(value,gasto);calls.push('restore-expense');}},
    renderFactGasto:()=>{},toast:()=>{throw Error('No debe declarar éxito');},alert:()=>{calls.push('error');},T:x=>x
  });
  vm.runInContext(html.slice(html.indexOf('async function factEliminarGasto('),html.indexOf('function factTarifas(')),ctx);
  await ctx.factEliminarGasto('gasto_remis','g1');
  assert.deepEqual(calls,['remove-expense','remove-doc','restore-expense','error']);
});

test('Storage usa eliminación por prefijos y exige la confirmación del objeto exacto',async()=>{
  const calls=[];let response=[];
  const ctx=vm.createContext({storagePrefijo:()=> 'org1/',supaFetch:async(url,options)=>{calls.push({url,options});return reply(response);}});
  vm.runInContext(html.slice(html.indexOf('async function storageDel('),html.indexOf('async function docBlob(')),ctx);
  await assert.rejects(ctx.storageDel('s1/d1/file.pdf'),/no confirmó/);
  response=[{name:'org1/s1/d1/file.pdf'}];await ctx.storageDel('s1/d1/file.pdf');
  assert.equal(calls[1].url,'/storage/v1/object/ec-docs');
  assert.deepEqual(JSON.parse(calls[1].options.body),{prefixes:['org1/s1/d1/file.pdf']});
});

function backend(fetch) {
  const variables={SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'service-test',RAG_PROJECT_ID:'p',RAG_DATA_STORE_ID:'ds',RAG_ENGINE_ID:'engine'};
  const ctx=vm.createContext({fetch,Response,Request,URL,TextEncoder,TextDecoder,URLSearchParams,crypto:webcrypto,btoa,atob,
    Deno:{env:{get:name=>variables[name]},serve:handler=>{ctx.handler=handler;}},
    requiredEnv:(read,name,legacy)=>read(name)||read(legacy)||(()=>{throw Error('MISSING_CONFIG');})(),
    resolveEnv:(read,name,legacy)=>read(name)||read(legacy)
  });
  const source=edge.replace(/^import .*\n/,'');
  vm.runInContext(stripTypeScriptTypes(source)+'\nthis.api={storageOrphans,listDocuments,purgeLegacyDocument,deleteDocument,indexDocument,status};tokenCache={value:"google-test",expires:Date.now()+3600000};',ctx);
  return ctx;
}
const auth=rol=>({supabaseUrl:'https://example.supabase.co',serviceKey:'service-test',anonKey:'public-test',authorization:'Bearer user-test',user:{id:'u1'},member:{org_id:'org1',rol}});

test('inventario admin pagina todos los registros y objetos aunque el servidor recorte las páginas',async()=>{
  const old=new Date(Date.now()-48*3600000).toISOString(),recent=new Date().toISOString();
  const records=[{id:'a',data:{path:'first.pdf'}},{id:'b',data:{path:'last.pdf'}}];
  const objects=[
    {id:'1',name:'first.pdf',created_at:old}, {id:'2',name:'last.pdf',created_at:old},
    {id:'3',name:'orphan.pdf',created_at:old,metadata:{size:123}},
    {id:'4',name:'upload.pdf',created_at:recent}, {id:'5',name:'unknown.pdf'}
  ];
  const calls=[];
  const ctx=backend(async(url,options={})=>{
    calls.push({url,options});
    if(url.includes('/rest/v1/ec_docs')){
      assert.equal(options.headers.Authorization,'Bearer service-test');
      const params=new URL(url).searchParams;assert.equal(params.get('org_id'),'eq.org1');
      const cursor=(params.get('id')||'gt.').slice(3);return reply(records.filter(row=>row.id>cursor).slice(0,1));
    }
    assert.equal(options.method,'POST');assert.ok(url.endsWith('/object/list/ec-docs'));
    const request=JSON.parse(options.body);assert.equal(request.prefix,'org1');
    return reply(objects.slice(request.offset,request.offset+2));
  });
  const result=await ctx.api.storageOrphans(auth('admin'),{ejecutar:false});
  assert.equal(result.total,1);assert.equal(result.bytes,123);assert.equal(result.soloLectura,true);
  assert.equal(result.omitidosRecientesOSinFecha,2);
  assert.equal(calls.filter(c=>c.url.includes('/ec_docs')).length,3);
  assert.equal(calls.filter(c=>c.url.includes('/object/list')).length,4);
  assert.equal(calls.filter(c=>c.options.method==='DELETE').length,0);
});

test('nunca ejecuta limpieza destructiva ni permite inventario a roles no admin',async()=>{
  const ctx=backend(async()=>{throw Error('No debe hacer solicitudes');});
  await assert.rejects(ctx.api.storageOrphans(auth('admin'),{ejecutar:true}),/CLEANUP_DISABLED/);
  await assert.rejects(ctx.api.storageOrphans(auth('coord'),{}),/ADMIN_REQUIRED/);
});

test('una página fallida o un cursor que no avanza aborta el inventario',async()=>{
  let page=0;
  const ctx=backend(async()=>++page===1?reply([{id:'a',data:{path:'file'}}]):reply({},503));
  await assert.rejects(ctx.api.storageOrphans(auth('admin'),{}),/DOCUMENT_LIST_FAILED/);
  const stalled=backend(async()=>reply([{id:'a',data:{path:'file'}}]));
  await assert.rejects(stalled.api.storageOrphans(auth('admin'),{}),/DOCUMENT_PAGINATION_FAILED/);
});

test('listado exige un estudio accesible y no confunde el registro de envíos con disponibilidad',async()=>{
  const ctx=backend(async(url,options)=>{
    assert.equal(options.headers.Authorization,'Bearer user-test');
    if(url.includes('/ec_studies'))return reply([{id:'s1'}]);
    const params=new URL(url).searchParams;assert.equal(params.get('data->>estudioId'),'eq.s1');
    if(params.has('id'))return reply([]);
    return reply([{id:'d1',data:{...doc()}},{id:'d2',data:{...doc(),id:'d2',tipo:'historia',pacienteId:'p1'}}]);
  });
  await assert.rejects(ctx.api.listDocuments(auth('medico'),{}),/STUDY_SCOPE_REQUIRED/);
  const result=await ctx.api.listDocuments(auth('medico'),{estudio_id:'s1'});
  assert.equal(result.total,1);assert.equal(result.verificado,false);assert.match(result.mensaje,/todavía debe verificarse/);
  const denied=backend(async()=>reply([]));
  await assert.rejects(denied.api.listDocuments(auth('medico'),{estudio_id:'s2'}),/STUDY_ACCESS_REQUIRED/);
});

test('la depuración valida organización, rol y documento; tolera ausencias para reintentar',async()=>{
  const calls=[];
  const ctx=backend(async(url,options={})=>{
    calls.push({url,options});
    if(url.includes('/ec_docs')){
      const params=new URL(url).searchParams;assert.equal(params.get('org_id'),'eq.org1');assert.equal(params.get('id'),'eq.d1');
      return reply([{id:'d1',org_id:'org1',data:{tipo:'historia',pacienteId:'p1',ragIndexado:'2026-01-01'}}]);
    }
    if(url.includes('/ec_audit'))return reply({});
    assert.equal(options.method,'DELETE');return reply({},404);
  });
  await assert.rejects(ctx.api.purgeLegacyDocument(auth('medico'),{source_doc_id:'d1'}),/ADMIN_REQUIRED/);
  assert.equal(calls.length,0);
  for(let retry=0;retry<2;retry++)assert.equal((await ctx.api.purgeLegacyDocument(auth('admin'),{source_doc_id:'d1'})).ok,true);
  assert.equal(calls.filter(c=>c.options.method==='DELETE').length,4);
  const denied=backend(async()=>reply([]));
  await assert.rejects(denied.api.purgeLegacyDocument(auth('admin'),{source_doc_id:'foreign'}),/NOT_MARKED_INDEXED/);
});

test('un rol de lectura no puede escribir ni eliminar el índice mediante una llamada directa',async()=>{
  const ctx=backend(async()=>{throw Error('No debe hacer solicitudes');});
  await assert.rejects(ctx.api.indexDocument(auth('monitor'),{estudio_id:'s1'}),/WRITE_ACCESS_REQUIRED/);
  await assert.rejects(ctx.api.deleteDocument(auth('coord'),{estudio_id:'s1'}),/DELETE_ACCESS_REQUIRED/);
});

test('probar conexión comprueba ambos recursos y falla si el proveedor rechaza el acceso',async()=>{
  const calls=[];const ctx=backend(async url=>{calls.push(url);return reply({});});
  assert.equal((await ctx.api.status()).ok,true);
  assert.ok(calls[0].endsWith('/dataStores/ds'));assert.ok(calls[1].endsWith('/engines/engine'));
  const unavailable=backend(async()=>reply({},403));
  await assert.rejects(unavailable.api.status(),/GOOGLE_RAG_HTTP_403/);
});

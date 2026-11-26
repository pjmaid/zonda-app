/* Archivo de reportes de seguridad de un estudio. El anfitrión aporta los datos y permisos. */
(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  root.ZondaSafetyReports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  const pageSize = 25;
  const categories = ['SUSAR', 'DSUR', 'Carta de seguridad', 'Listado periódico', 'Otro'];
  const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const categoryOf = report => categories.includes(report.safetyCategory) ? report.safetyCategory : 'Otro';
  const dateOf = report => String(report.safetyDate || report.subido || '').slice(0,10);
  const readableDate = date => /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.split('-').reverse().join('/') : '—';

  function selectPage(reports, filters = {}){
    const query = normalize(filters.search).split(/\s+/).filter(Boolean);
    const matches = reports.filter(report => {
      if(filters.category && filters.category !== categoryOf(report)) return false;
      const date = dateOf(report);
      if((filters.from && date < filters.from) || (filters.to && (!date || date > filters.to))) return false;
      const fields = normalize([report.filename,report.safetyReference,report.version].filter(Boolean).join(' '));
      return query.every(term => fields.includes(term));
    });
    matches.sort((a,b) => dateOf(b).localeCompare(dateOf(a)) ||
      String(b.subido || '').localeCompare(String(a.subido || '')) ||
      String(a.filename || '').localeCompare(String(b.filename || ''),'es') || String(a.id).localeCompare(String(b.id)));
    const total = matches.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(pages, Math.max(1, Math.trunc(Number(filters.page)) || 1));
    return {items:matches.slice((page-1)*pageSize, page*pageSize), total, page, pages};
  }

  function mount(host, options){
    const doc = host.ownerDocument;
    let alive = true, busy = false, uploading = false, stopRequested = false, page = 1;
    const queue = [];
    const active = () => alive && options.isActive();
    const writable = () => active() && options.canManage();

    function el(tag, content, cls){
      const node = doc.createElement(tag);
      if(content !== undefined && content !== null) node.textContent = content;
      if(cls) node.className = cls;
      return node;
    }
    function named(node, name){ node.setAttribute('data-safety',name); return node; }
    function button(text, action, cls){
      const node = el('button',text,cls);
      node.type = 'button'; node.addEventListener('click',action); return node;
    }
    function input(type){ const node = el('input'); node.type = type; return node; }
    function choice(value, label){ const node = el('option',label); node.value = value; return node; }
    function categoryMenu(filter){
      const node = el('select');
      if(filter) node.append(choice('','Todos los tipos'));
      for(const value of categories) node.append(choice(value,value));
      node.value = filter ? '' : 'Otro'; return node;
    }
    function field(title, control){
      const label = el('label',undefined,'grow'); label.append(el('span',title),control); return label;
    }
    function details(title){ const node=el('details'); node.append(el('summary',title)); return node; }
    function status(name){
      const node = named(el('p',undefined,'small muted'),name);
      node.setAttribute('role','status'); node.setAttribute('aria-live','polite'); return node;
    }
    function tell(message){ if(active()) notice.textContent = message; }
    function messageOf(error){ return error && error.message ? error.message : 'Volvé a intentar.'; }
    async function read(action){
      if(!active()) return;
      try{ await action(); }catch(error){ tell(messageOf(error)); }
    }
    function ask(message){ return doc.defaultView.confirm(message); }

    const container = el('div'); host.replaceChildren(container);
    const notice = status('notice');
    const admin = el('div',undefined,'card');
    const uploadPanel = details('Cargar reportes');
    const uploadFields = el('div',undefined,'row');
    const files = named(input('file'),'files'); files.multiple = true;
    const uploadCategory = categoryMenu(false), uploadDate = input('date');
    uploadFields.append(field('Archivos (hasta 50 MB cada uno)',files),field('Tipo del lote',uploadCategory),field('Fecha del reporte (opcional)',uploadDate));
    const queueSummary = status('queueSummary');
    const queueList = named(el('ul'),'queue'); queueList.hidden = true;
    queueList.style.cssText = 'max-height:18rem;overflow:auto;padding-inline-start:1.5rem;overflow-wrap:anywhere';
    const uploadBtn = named(button('Cargar seleccionados',()=>runBatch('pending'),'primary'),'upload');
    const retryBtn = named(button('Reintentar fallidos',()=>runBatch('failed')),'retry');
    const stopBtn = named(button('Detener después del archivo actual',()=>{
      if(!uploading || !active()) return;
      stopRequested=true; stopBtn.disabled=true;
      queueSummary.textContent='El lote se detendrá al terminar el archivo actual.';
    }),'stop');
    const clearBtn = button('Limpiar selección',()=>{
      if(!writable() || busy) return;
      queue.length=0; files.value=''; queueList.replaceChildren(); queueSummary.textContent=''; updateQueueControls();
    },'ghost');
    const uploadActions = el('div',undefined,'toolbar'); uploadActions.append(uploadBtn,retryBtn,stopBtn,clearBtn);
    uploadPanel.append(uploadFields,queueSummary,queueList,uploadActions);

    const legacyPanel = details('Trasladar desde documentos «Otro»');
    const legacySearch = input('text'), legacySelect = named(el('select'),'legacySelect');
    let legacyPage = 1, legacyPageDocs = [], legacyPages = 1, legacyMatches = 0;
    const selectedDocs = new Set();
    legacySelect.multiple=true; legacySelect.size=6;
    legacySearch.placeholder = 'Nombre o versión';
    const legacyCategory = categoryMenu(false), legacyDate = input('date'), legacyReference = input('text');
    const legacyFields = el('div',undefined,'row');
    legacyFields.append(field('Buscar documento',legacySearch),field('Documento del estudio',legacySelect));
    const legacyMeta = el('div',undefined,'row');
    legacyMeta.append(field('Tipo de reporte',legacyCategory),field('Fecha del reporte (opcional)',legacyDate),field('Referencia (opcional)',legacyReference));
    const legacyBtn = named(button('Trasladar a reportes de seguridad',moveLegacy),'legacyMove');
    const legacyAll=named(button('Seleccionar esta página',()=>{
      if(!writable()||busy) return;
      for(const d of legacyPageDocs) selectedDocs.add(d.id);
      renderLegacy();
    }),'legacyAll');
    const legacyNone=named(button('Quitar selección',()=>{
      if(!writable()||busy) return;
      selectedDocs.clear(); renderLegacy();
    }),'legacyNone');
    const legacyPrev=named(button('Anterior',()=>{legacyPage--;renderLegacy();}),'legacyPrev');
    const legacyNext=named(button('Siguiente',()=>{legacyPage++;renderLegacy();}),'legacyNext');
    const legacyNav=el('div',undefined,'toolbar'); legacyNav.append(legacyPrev,legacyNext,legacyAll,legacyNone);
    const legacyCount = named(el('p',undefined,'small muted'),'legacyCount');
    const legacyResult = status('legacyResult');
    const legacyErrors = el('ul'); legacyErrors.style.cssText='max-height:12rem;overflow:auto;overflow-wrap:anywhere';
    legacyPanel.append(legacyFields,legacyNav,legacyCount,legacyMeta,legacyBtn,legacyResult,legacyErrors);
    admin.append(uploadPanel,legacyPanel);

    const archive = el('div',undefined,'card');
    const filterRow = el('div',undefined,'row');
    const search = named(input('text'),'search'), category = categoryMenu(true), from = input('date'), to = input('date');
    search.placeholder = 'Nombre, referencia o versión';
    const reset = button('Limpiar filtros',()=>{
      search.value=''; category.value=''; from.value=''; to.value=''; filterChanged();
    },'ghost');
    filterRow.append(field('Buscar reporte',search),field('Tipo',category),field('Desde',from),field('Hasta',to),reset);
    const dateHelp = el('div','Las fechas corresponden al reporte o, si falta esa fecha, a la carga.','small muted');
    let editing=null;
    const editor=el('section',undefined,'card'); editor.hidden=true;
    const editTitle=el('h3'), editFields=el('div',undefined,'row');
    const editCategory=named(categoryMenu(false),'editCategory'), editDate=named(input('date'),'editDate');
    const editReference=named(input('text'),'editReference');
    editFields.append(field('Tipo de reporte',editCategory),field('Fecha del reporte',editDate),field('Referencia',editReference));
    const editSave=named(button('Guardar datos',saveMetadata,'primary'),'editSave');
    const editCancel=named(button('Cancelar',()=>{if(!busy) closeEditor();}),'editCancel');
    const editActions=el('div',undefined,'toolbar'); editActions.append(editSave,editCancel);
    editor.append(editTitle,editFields,editActions);
    const count = status('count'), tableWrap = el('div',undefined,'tablewrap');
    const table = el('table'); table.setAttribute('aria-label','Reportes de seguridad del estudio');
    const thead = el('thead'), headings = el('tr'), tbody = el('tbody');
    for(const heading of ['Archivo / referencia','Tipo','Fecha','Acciones']){
      const th = el('th',heading); th.scope='col'; headings.append(th);
    }
    thead.append(headings); table.append(thead,tbody); tableWrap.append(table);
    const pager = el('div',undefined,'toolbar'); pager.setAttribute('aria-label','Páginas de reportes');
    const prev = button('Anterior',()=>{ if(page>1){ page--; renderArchive(); } });
    const next = button('Siguiente',()=>{ page++; renderArchive(); });
    const pageLabel = el('span',undefined,'small'); pager.append(prev,pageLabel,next);
    archive.append(filterRow,dateHelp,editor,count,tableWrap,pager);
    container.append(admin,notice,archive);

    async function mutate(action, success){
      if(busy || !writable()) return;
      busy = true; syncControls();
      try{ await action(); tell(success); }
      catch(error){ tell(messageOf(error)); }
      finally{ busy=false; refresh(); }
    }
    function metadataOf(report){
      return {category:categoryOf(report),reportDate:report.safetyDate||'',reference:report.safetyReference||''};
    }
    function openEditor(report){
      if(!writable()||busy||!options.updateMetadata) return;
      const meta=metadataOf(report);
      editing={id:report.id,original:meta};
      editTitle.textContent=`Editar datos de ${report.filename || 'este reporte'}`;
      editCategory.value=meta.category; editDate.value=meta.reportDate; editReference.value=meta.reference;
      editor.hidden=false; editCategory.focus();
    }
    function closeEditor(){ editing=null; editor.hidden=true; }
    async function saveMetadata(){
      if(!editing||!writable()||busy) return;
      const current=options.getReports().find(report=>report.id===editing.id);
      if(!current){closeEditor();tell('El reporte ya no está en esta sección.');refresh();return;}
      const baseline=metadataOf(current);
      if(Object.keys(baseline).some(key=>baseline[key]!==editing.original[key])){
        openEditor(current); tell('Los datos cambiaron. Revisá los valores actuales antes de guardar.'); return;
      }
      const metadata={category:editCategory.value,reportDate:editDate.value,reference:editReference.value.trim()};
      await mutate(async()=>{
        await options.updateMetadata(current.id,metadata);
        if(active()) closeEditor();
      },'Datos del reporte guardados.');
    }
    function filterChanged(){ page=1; renderArchive(); }
    search.addEventListener('input',filterChanged);
    [category,from,to].forEach(control=>control.addEventListener('change',filterChanged));
    function renderArchive(){
      if(!active()) return;
      const reports = options.getReports();
      const result = selectPage(reports,{search:search.value,category:category.value,from:from.value,to:to.value,page});
      page = result.page; tbody.replaceChildren();
      tableWrap.hidden = !result.total; pager.hidden = result.pages===1;
      pager.style.display = pager.hidden ? 'none' : '';
      count.textContent = !reports.length ? 'Todavía no hay reportes de seguridad en este estudio.' :
        !result.total ? 'No hay reportes que coincidan con estos filtros.' :
        `Mostrando ${(page-1)*pageSize+1}–${Math.min(page*pageSize,result.total)} de ${result.total} reportes`+
        (result.total===reports.length ? '.' : ` (${reports.length} en este estudio).`);
      pageLabel.textContent = `Página ${page} de ${result.pages}`;
      prev.disabled=page===1; next.disabled=page===result.pages;
      for(const report of result.items){
        const row = el('tr'), fileCell = el('td'); fileCell.style.overflowWrap='anywhere';
        fileCell.append(el('strong',report.filename || 'Archivo adjunto'));
        const ref = [report.safetyReference,report.version].filter((value,i,a)=>value&&a.indexOf(value)===i).join(' · ');
        if(ref) fileCell.append(el('div',ref,'small muted'));
        const dateCell=el('td',readableDate(dateOf(report)));
        if(!report.safetyDate) dateCell.append(el('div','Fecha de carga','small muted'));
        const actions=el('td');
        for(const [label,handler] of [['Ver',options.open],['Descargar',options.download]]){
          const action=button(label,()=>read(()=>handler(report.id)),'ghost');
          action.setAttribute('aria-label',`${label} ${report.filename || 'reporte'}`); actions.append(action);
        }
        if(writable() && options.updateMetadata){
          const edit=named(button('Editar datos',()=>openEditor(report),'ghost'),'edit-'+report.id);
          edit.setAttribute('aria-label',`Editar datos de ${report.filename || 'reporte'}`); edit.disabled=busy;
          actions.append(edit);
        }
        if(writable() && options.restore && report.tipo==='otro' && report.safetyReport===true){
          const restore=button('Devolver a «Otro»',()=>{
            if(busy || !writable() || !ask(`¿Devolver «${report.filename}» a los documentos «Otro» de este estudio?`)) return;
            return mutate(()=>options.restore(report.id),'El archivo volvió a documentos «Otro».');
          },'ghost');
          restore.disabled=busy; actions.append(restore);
        }
        row.append(fileCell,el('td',categoryOf(report)),dateCell,actions); tbody.append(row);
      }
    }

    function renderLegacy(){
      if(!writable()) return;
      const all=options.getOtherDocs(), available=new Set(all.map(d=>d.id));
      for(const id of selectedDocs) if(!available.has(id)) selectedDocs.delete(id);
      const term=normalize(legacySearch.value);
      const matches=all.filter(d=>normalize([d.filename,d.version].join(' ')).includes(term));
      legacyMatches=matches.length;
      legacyPages=Math.max(1,Math.ceil(matches.length/pageSize));
      legacyPage=Math.max(1,Math.min(legacyPage,legacyPages));
      legacyPageDocs=matches.slice((legacyPage-1)*pageSize,legacyPage*pageSize);
      legacySelect.replaceChildren();
      for(const d of legacyPageDocs){
        const option=choice(d.id,[d.filename,d.version].filter(Boolean).join(' · '));
        option.selected=selectedDocs.has(d.id); legacySelect.append(option);
      }
      updateLegacySelection();
    }
    function updateLegacySelection(){
      legacyCount.textContent=(legacyMatches ? `Página ${legacyPage} de ${legacyPages} · ${legacyMatches} documento(s). ` : 'No hay documentos «Otro» para esta búsqueda. ')+
        `${selectedDocs.size} seleccionado(s) en total.`;
      legacyPrev.disabled=busy || legacyPage<=1; legacyNext.disabled=busy || legacyPage>=legacyPages;
      legacyAll.disabled=busy || !legacyPageDocs.length || legacyPageDocs.every(d=>selectedDocs.has(d.id));
      legacyNone.disabled=busy || !selectedDocs.size;
      legacyReference.disabled=busy || selectedDocs.size!==1;
      if(selectedDocs.size!==1) legacyReference.value='';
      legacyBtn.disabled=busy || !selectedDocs.size;
    }
    legacySearch.addEventListener('input',()=>{ legacyPage=1; renderLegacy(); });
    legacySelect.addEventListener('change',()=>{
      if(!writable()||busy) return;
      for(const option of legacySelect.options){
        if(option.selected) selectedDocs.add(option.value);
        else selectedDocs.delete(option.value);
      }
      updateLegacySelection();
    });
    async function moveLegacy(){
      if(!writable()||busy) return;
      const selected=options.getOtherDocs().filter(d=>selectedDocs.has(d.id));
      const n=selected.length;
      if(!n || !ask(`¿Trasladar ${n===1?'«'+selected[0].filename+'»':n+' documentos seleccionados'} a los reportes de seguridad de este estudio?`)) return;
      const metadata={category:legacyCategory.value, reportDate:legacyDate.value, reference:n===1?legacyReference.value.trim():''};
      let moved=0, failed=0;
      busy=true; syncControls(); renderLegacy(); legacyErrors.replaceChildren();
      try{
        for(const d of selected){
          if(!writable()) break;
          legacyResult.textContent=`Trasladando ${moved+failed+1} de ${n}.`;
          try{
            await options.reclassify(d.id,metadata);
            if(!active()) break;
            selectedDocs.delete(d.id); moved++;
          }catch(error){
            if(!active()) break;
            failed++; legacyErrors.append(el('li',`${d.filename}: ${messageOf(error)}`));
          }
        }
        if(active()){
          legacyResult.textContent=(moved===1 && n===1?'Documento trasladado a reportes de seguridad.':`${moved} documento(s) trasladado(s).`)+
            (failed?` ${failed} con error. Los fallidos siguen seleccionados para reintentar.`:'');
          if(!selectedDocs.size){ legacyDate.value=''; legacyReference.value=''; legacyCategory.value='Otro'; }
          if(!failed) tell(legacyResult.textContent);
        }
      }finally{ busy=false; refresh(); }
    }

    function updateQueueControls(){
      const canWrite=writable() && !busy;
      uploadBtn.disabled=!canWrite || !queue.some(item=>item.state==='pending');
      retryBtn.hidden=!queue.some(item=>item.state==='failed'); retryBtn.disabled=!canWrite;
      stopBtn.hidden=!uploading; stopBtn.disabled=stopRequested || !uploading;
      clearBtn.disabled=!canWrite||!queue.length; queueList.hidden=!queue.length;
    }
    function syncControls(){
      admin.hidden=!writable();
      if(!writable()) closeEditor();
      [files,uploadCategory,uploadDate,legacySearch,legacySelect,legacyCategory,legacyDate,legacyReference,editCategory,editDate,editReference,editSave,editCancel].forEach(node=>{node.disabled=busy;});
      legacyBtn.disabled=busy || !selectedDocs.size;
      updateQueueControls();
    }
    files.addEventListener('change',()=>{
      if(!writable() || busy) return;
      const existing=new Set(queue.map(item=>item.signature));
      let duplicates=0;
      for(const file of Array.from(files.files || [])){
        const signature=JSON.stringify([file.name,file.size,file.lastModified]);
        if(existing.has(signature)){ duplicates++; continue; }
        existing.add(signature);
        const row=el('li'), line=el('span'), reference=input('text');
        reference.placeholder='Referencia (opcional)'; reference.setAttribute('aria-label',`Referencia de ${file.name}`);
        const invalid=file.size>50*1048576;
        const item={file,signature,state:invalid?'invalid':'pending',reference,line,meta:null,retryKey:{}};
        line.textContent=invalid?'Supera 50 MB por archivo.':'Pendiente de carga';
        row.append(el('strong',file.name),el('span',' · '),line);
        if(!invalid) row.append(reference);
        queueList.append(row); queue.push(item);
      }
      files.value='';
      queueSummary.textContent=`${queue.length} archivo(s) en la selección.`+(duplicates ? ` Se omitieron ${duplicates} repetido(s).` : '');
      updateQueueControls();
    });
    async function runBatch(state){
      if(!writable() || busy) return;
      const batch=queue.filter(item=>item.state===state);
      if(!batch.length) return;
      const category=uploadCategory.value, reportDate=uploadDate.value;
      busy=true; uploading=true; stopRequested=false; syncControls();
      for(const item of batch) item.reference.disabled=true;
      let complete=0;
      try{
        for(const item of batch){
          if(!writable() || stopRequested) break;
          if(!item.meta) item.meta={category,reportDate,reference:item.reference.value.trim()};
          queueSummary.textContent=`Cargando ${complete+1} de ${batch.length}.`;
          item.line.textContent='Cargando…';
          try{
            await options.upload(item.file,item.meta,item.retryKey);
            if(!active()) break;
            item.state='saved'; item.file=null; item.retryKey=null; item.line.textContent='Guardado';
          }catch(error){
            if(!active()) break;
            item.state='failed'; item.line.textContent=`Falló la carga. ${messageOf(error)}`;
          }
          complete++;
        }
      }finally{
        busy=false; uploading=false;
        if(active()){
          for(const item of batch) if(item.state==='pending') item.reference.disabled=false;
          const saved=queue.filter(item=>item.state==='saved').length;
          const failed=queue.filter(item=>item.state==='failed').length;
          const invalid=queue.filter(item=>item.state==='invalid').length;
          const pending=queue.filter(item=>item.state==='pending').length;
          queueSummary.textContent=`${saved} guardado(s) · ${failed} fallido(s)`+(invalid ? ` · ${invalid} supera(n) 50 MB` : '')+(pending ? ` · ${pending} pendiente(s) de carga` : '')+'.';
          refresh();
        }
      }
    }
    function refresh(){ if(active()){ syncControls(); renderArchive(); renderLegacy(); } }
    function destroy(){ alive=false; queue.length=0; container.remove(); }
    refresh();
    return {refresh,destroy,isBusy:()=>busy};
  }
  return Object.freeze({mount,selectPage});
});

(function(root, factory){
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  root.ZondaFlowTrace=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  const key=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[^a-z0-9]/g,'');
  const sorted=a=>(a||[]).map(String).sort((x,y)=>x.localeCompare(y));
  const sameList=(a,b)=>JSON.stringify(sorted(a))===JSON.stringify(sorted(b));

  function confidence(method){
    return ({geom:0.96,visual:0.78,texto:0.64,paste:0.55,manual:1})[method]||0.6;
  }

  function snapshot(flow){
    const f=flow||{}, visits=f.visitas||[], procedures=f.procs||[], cells=[];
    for(let i=0;i<procedures.length;i++) for(let j=0;j<visits.length;j++)
      if(f.matriz&&f.matriz[i+'|'+j]) cells.push({procedure:procedures[i],visit:visits[j].nombre});
    return {
      visits:visits.map(v=>({name:v.nombre,day:v.dia,before:v.venAntes||0,after:v.venDesp||0})),
      procedures:procedures.slice(), cells
    };
  }

  function evidence(flow, source){
    const out={}, f=flow||{}, base=confidence(source&&source.method);
    for(let i=0;i<(f.procs||[]).length;i++) for(let j=0;j<(f.visitas||[]).length;j++){
      const k=i+'|'+j;
      out[k]={
        confidence:base,
        status:base<0.8?'doubtful':'extracted',
        selected:!!(f.matriz&&f.matriz[k]),
        pages:(source&&source.pages||[]).slice(),
        fragment:(f.procs[i]||'')+' × '+((f.visitas[j]||{}).nombre||'')
      };
    }
    return out;
  }

  function visitMap(snapshotValue){
    const m=new Map();
    for(const v of (snapshotValue&&snapshotValue.visits||[])) m.set(key(v.name),v);
    return m;
  }

  function cellsByVisit(snapshotValue){
    const m=new Map();
    for(const c of (snapshotValue&&snapshotValue.cells||[])){
      const k=key(c.visit); if(!m.has(k)) m.set(k,[]); m.get(k).push(c.procedure);
    }
    return m;
  }

  function diff(before, after){
    const a=before||{visits:[],cells:[]}, b=after||{visits:[],cells:[]};
    const am=visitMap(a), bm=visitMap(b), ac=cellsByVisit(a), bc=cellsByVisit(b);
    const added=[], removed=[], changed=[];
    for(const [k,v] of bm) if(!am.has(k)) added.push(v.name);
    for(const [k,v] of am) if(!bm.has(k)) removed.push(v.name);
    for(const [k,av] of am){
      const bv=bm.get(k); if(!bv) continue;
      const fields=[];
      if(av.day!==bv.day) fields.push('día '+av.day+' → '+bv.day);
      if(av.before!==bv.before||av.after!==bv.after)
        fields.push('ventana −'+av.before+'/+'+av.after+' → −'+bv.before+'/+'+bv.after);
      const oldP=ac.get(k)||[], newP=bc.get(k)||[];
      if(!sameList(oldP,newP)){
        const addP=newP.filter(p=>!oldP.some(x=>key(x)===key(p)));
        const delP=oldP.filter(p=>!newP.some(x=>key(x)===key(p)));
        if(addP.length) fields.push('+'+addP.length+' procedimiento(s)');
        if(delP.length) fields.push('−'+delP.length+' procedimiento(s)');
      }
      if(fields.length) changed.push({visit:bv.name,details:fields});
    }
    return {added,removed,changed,hasChanges:!!(added.length||removed.length||changed.length)};
  }

  function currentSnapshot(visits){
    const flow={procs:[],visitas:[],matriz:{}}, procIndex=new Map();
    for(const v of (visits||[])){
      const j=flow.visitas.length;
      flow.visitas.push({nombre:v.nombre,dia:v.dia,venAntes:v.venAntes||0,venDesp:v.venDesp||0});
      for(const p of (v.tareas||[])){
        const k=key(p); let i=procIndex.get(k);
        if(i===undefined){ i=flow.procs.length; procIndex.set(k,i); flow.procs.push(p); }
        flow.matriz[i+'|'+j]=true;
      }
    }
    return snapshot(flow);
  }

  return {confidence,snapshot,evidence,diff,currentSnapshot,key};
});

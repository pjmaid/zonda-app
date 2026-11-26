// Real REST/Auth/Storage and concurrent PostgreSQL checks. Requires the native
// supervisor's loopback-only SQL factory; imports never execute tests.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createFixtureGraph,SYNTHETIC_PDF,sha256} from './synthetic-supabase-fixtures.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deny=result=>assert.ok([400,401,403,404,409].includes(result.status),'Expected denial, HTTP '+result.status);
const claims=actor=>JSON.parse(Buffer.from(actor.token.split('.')[1],'base64url').toString());
const removed=(result,name)=>result.ok&&Array.isArray(result.body)&&result.body.some(row=>row.name===name);

export async function runHardeningIntegration(env,{runtime,preservedAuditOrganizations=[],log=()=>{}}={}){
  assert.ok(runtime?.connectSql&&runtime?.sql,'A real loopback SQL runtime is required.');
  const report={startedAt:new Date().toISOString(),checks:[],cleanup:[],passed:false,syntheticOrganizations:[]};
  let graph;
  async function check(name,run){
    try{await run();report.checks.push({name,status:'passed'});log('OK '+name);}
    catch(error){report.checks.push({name,status:'failed',message:error.message});throw error;}
  }
  async function sqlFails(query,parameters,{actor,role='authenticated',code}={}){
    const client=await runtime.connectSql();
    try{
      await client.query('BEGIN');
      assert.ok(['authenticated','service_role','anon'].includes(role));
      await client.query('SET LOCAL ROLE '+role);
      if(actor)await client.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify(claims(actor))]);
      let error;try{await client.query(query,parameters);}catch(caught){error=caught;}
      assert.ok(error,'Forbidden SQL unexpectedly succeeded.');
      if(code)assert.equal(error.code,code);
    }finally{await client.query('ROLLBACK').catch(()=>{});await client.end();}
  }
  try{
    graph=await createFixtureGraph(env,{preservedAuditOrganizations});
    const {api,runId}=graph;
    const org=await graph.organization('main'),otherOrg=await graph.organization('other');
    const study=await graph.study(org,'study'),otherStudy=await graph.study(otherOrg,'other_study');
    const admin=await graph.actor('admin','admin',org);
    const admin2=await graph.actor('admin2','admin',org);
    const superadmin=await graph.actor('superadmin','admin',org,[],{superadmin:true});
    const coord=await graph.actor('coord','coord',org,[study]);
    const doctor=await graph.actor('doctor','medico',org,[study]);
    const finance=await graph.actor('finance','coord',org,[study],{billing:true});
    const finance2=await graph.actor('finance2','coord',org,[study],{billing:true});
    const outsider=await graph.actor('outsider','admin',otherOrg,[otherStudy]);
    const recordId=runId+'_record',recordData={id:recordId,estudioId:study,recordType:'delegacion',detalle:'Synthetic audit fixture'};
    const firstEvent=randomUUID();

    await check('controlled RPC writes data and server-derived audit together',async()=>{
      api.ok(await api.save(coord,'records',recordId,recordData,{eventId:firstEvent}),'Save controlled record');
      const rows=await api.rows('ec_records','id=eq.'+recordId);
      const audit=await api.rows('ec_audit','event_id=eq.'+firstEvent);
      assert.equal(rows.length,1);assert.equal(audit.length,1);
      assert.equal(rows[0].org_id,org);assert.equal(audit[0].org_id,org);
      assert.equal(audit[0].usuario,coord.email);assert.equal(audit[0].rol,'coord');
    });
    await check('authenticated direct REST mutations cannot bypass the audited RPC',async()=>{
      for(const table of ['ec_studies','ec_patients','ec_visits','ec_docs','ec_users','ec_records','ec_checklists','ec_settings']){
        const id=runId+'_forged_'+table;
        deny(await api.request('/rest/v1/'+table,{actor:admin,method:'POST',json:{id,org_id:org,data:{id,estudioId:study}}}));
        deny(await api.request('/rest/v1/'+table+'?id=eq.'+id,{actor:admin,method:'PATCH',json:{data:{id}}}));
        deny(await api.request('/rest/v1/'+table+'?id=eq.'+id,{actor:admin,method:'DELETE'}));
        assert.equal((await api.rows(table,'id=eq.'+id)).length,0);
      }
    });
    await check('direct forged audit insertion and history mutation are denied',async()=>{
      deny(await api.request('/rest/v1/ec_audit',{actor:coord,method:'POST',json:{org_id:org,event_id:randomUUID(),usuario:admin.email,rol:'admin',accion:'forged'}}));
      for(const actor of [coord,api.service])for(const method of ['PATCH','DELETE']){
        const result=await api.request('/rest/v1/ec_audit?event_id=eq.'+firstEvent,{actor,method,...(method==='PATCH'?{json:{detalle:'forged'}}:{})});
        assert.ok(!result.ok,'Audit mutation unexpectedly succeeded.');
      }
      assert.equal((await api.rows('ec_audit','event_id=eq.'+firstEvent)).length,1);
      for(const role of ['authenticated','service_role'])await sqlFails('TRUNCATE public.ec_audit',[],{actor:coord,role});
    });
    await check('client audit batches cannot impersonate database mutations or another actor',async()=>{
      const event=randomUUID(),payload={event_id:event,org_id:org,auth_user_id:coord.id,usuario:admin.email,rol:'admin',actor_id:admin.id,source:'database',operation:'DELETE',entidad:'records',accion:'baja',ref_id:recordId,detalle:'Synthetic client event'};
      const send=p_events=>api.request('/rest/v1/rpc/ec_append_audit_events',{actor:coord,method:'POST',json:{p_events}});
      assert.deepEqual(api.ok(await send([payload]),'Append client event').accepted,[event]);
      api.ok(await send([payload]),'Replay client event');
      const rows=await api.rows('ec_audit','client_event_id=eq.'+event);
      assert.equal(rows.length,1);assert.equal(rows[0].actor_id,coord.id);assert.equal(rows[0].usuario,coord.email);assert.equal(rows[0].rol,'coord');
      assert.equal(rows[0].source,'client');assert.equal(rows[0].operation,'EVENT');assert.equal(rows[0].accion,'evento de cliente');
      assert.ok(!(await send([{...payload,event_id:randomUUID(),org_id:otherOrg}])).ok);
      assert.ok(!(await send([{...payload,event_id:randomUUID(),auth_user_id:admin.id}])).ok);
      assert.ok(!(await send([{...payload,detalle:'Different event content'}])).ok);
    });
    await check('authenticated callers cannot access private receipts or supply database event prefixes',async()=>{
      await sqlFails('SELECT * FROM zonda_private.write_receipts LIMIT 1',[],{actor:coord,code:'42501'});
      await sqlFails('SELECT * FROM zonda_private.write_context LIMIT 1',[],{actor:coord,code:'42501'});
      for(const prefix of ['client:','db:','service:'])assert.ok(!(await api.save(coord,'records',runId+'_reserved',{...recordData,id:runId+'_reserved'},{eventId:prefix+randomUUID()})).ok);
      assert.equal((await api.rows('ec_records','id=eq.'+runId+'_reserved')).length,0);
    });
    await check('TRUNCATE cannot bypass entity and membership row checks',async()=>{
      for(const table of ['ec_records','ec_members'])for(const role of ['authenticated','service_role']){
        await sqlFails('TRUNCATE public.'+table,[],{actor:admin,role,code:'42501'});
      }
      assert.equal((await api.rows('ec_records','id=eq.'+recordId)).length,1);
    });
    await check('idempotent replay is bound to actor and exact request payload',async()=>{
      const replay=api.ok(await api.save(coord,'records',recordId,recordData,{eventId:firstEvent}),'Replay exact mutation');
      assert.equal(replay.rev,1);
      assert.ok(!(await api.save(coord,'records',recordId,{...recordData,detalle:'Different payload'},{eventId:firstEvent})).ok,'Changed payload reused a mutation receipt.');
      assert.ok(!(await api.save(doctor,'records',recordId,recordData,{eventId:firstEvent})).ok,'Another actor reused a mutation receipt.');
      assert.equal((await api.rows('ec_audit','event_id=eq.'+firstEvent)).length,1);
    });
    await check('simultaneous identical RPC events produce one record and one audit event',async()=>{
      const id=runId+'_parallel',event=randomUUID(),data={...recordData,id};
      const replies=await Promise.all([api.save(coord,'records',id,data,{eventId:event}),api.save(coord,'records',id,data,{eventId:event})]);
      replies.forEach(result=>api.ok(result,'Concurrent idempotent write'));
      assert.equal((await api.rows('ec_records','id=eq.'+id)).length,1);
      assert.equal((await api.rows('ec_audit','event_id=eq.'+event)).length,1);
    });
    await check('stale revisions leave both data and audit unchanged',async()=>{
      const before=await api.rows('ec_records','id=eq.'+recordId),event=randomUUID();
      assert.ok(!(await api.save(coord,'records',recordId,{...recordData,detalle:'stale'},{expectedRev:99,eventId:event})).ok);
      assert.deepEqual(await api.rows('ec_records','id=eq.'+recordId),before);
      assert.equal((await api.rows('ec_audit','event_id=eq.'+event)).length,0);
    });
    await check('audit insertion failure rolls back the entity mutation atomically',async()=>{
      const client=await runtime.connectSql(),id=runId+'_audit_failure',event=randomUUID();
      try{
        await client.query('BEGIN');
        // Local disposable transaction only: no trigger is disabled and the
        // injected constraint disappears on the outer ROLLBACK.
        await client.query("ALTER TABLE public.ec_audit ADD CONSTRAINT synthetic_audit_failure CHECK (ref_id <> '"+id+"') NOT VALID");
        await client.query('SET LOCAL ROLE authenticated');
        await client.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify(claims(coord))]);
        await client.query('SAVEPOINT operation');
        let error;try{await client.query('SELECT public.ec_save_record($1,$2,$3::jsonb,$4,$5,$6,$7,$8)',
          ['records',id,JSON.stringify({...recordData,id}),null,event,'alta','Synthetic audit failure','Synthetic atomicity check']);}catch(caught){error=caught;}
        assert.ok(error,'Audit failure injection did not reject the write.');
        assert.equal(error.code,'23514');
        await client.query('ROLLBACK TO SAVEPOINT operation');
        const rows=await client.query('SELECT id FROM public.ec_records WHERE id=$1',[id]);
        assert.equal(rows.rows.length,0);
      }finally{await client.query('ROLLBACK').catch(()=>{});await client.end();}
      assert.equal((await api.rows('ec_audit','event_id=eq.'+event)).length,0);
    });
    await check('caller-controlled skip flags cannot suppress service audit triggers',async()=>{
      const client=await runtime.connectSql(),id=runId+'_skip_attempt';
      try{
        await client.query('BEGIN');await client.query('SET LOCAL ROLE service_role');
        for(const key of ['zonda.skip_audit','app.skip_audit','zonda.audit_suppressed'])await client.query('SELECT set_config($1,$2,true)',[key,'true']);
        await client.query('INSERT INTO public.ec_records(id,org_id,data) VALUES($1,$2,$3::jsonb)',[id,org,JSON.stringify({...recordData,id})]);
        await client.query('COMMIT');
      }finally{await client.query('ROLLBACK').catch(()=>{});await client.end();}
      assert.ok((await api.rows('ec_audit','ref_id=eq.'+id)).length>=1,'Service write was not audited.');
    });
    await check('authenticated database identity cannot SET ROLE authenticator',async()=>{
      const client=await runtime.connectSql();
      try{
        await client.query('SET SESSION AUTHORIZATION authenticated');
        let error;try{await client.query('SET ROLE authenticator');}catch(caught){error=caught;}
        assert.ok(error);assert.equal(error.code,'42501');
      }finally{await client.query('RESET SESSION AUTHORIZATION').catch(()=>{});await client.end();}
    });

    await check('site administrators cannot mutate a superadministrator row or member identity',async()=>{
      const before=await api.rows('ec_members','user_id=eq.'+superadmin.id);
      for(const json of [{activo:false},{creado_en:'2000-01-01T00:00:00Z'},{rol:'coord'}]){
        const result=await api.request('/rest/v1/ec_members?user_id=eq.'+superadmin.id,{actor:admin,method:'PATCH',json});
        assert.ok(!result.ok || (Array.isArray(result.body)&&result.body.length===0));
      }
      assert.deepEqual(await api.rows('ec_members','user_id=eq.'+superadmin.id),before);
      deny(await api.request('/rest/v1/ec_members?user_id=eq.'+coord.id,{actor:admin,method:'PATCH',json:{org_id:otherOrg}}));
      assert.equal((await api.rows('ec_members','user_id=eq.'+coord.id))[0].org_id,org);
    });
    await check('unsupported transaction isolation fails closed before membership changes',async()=>{
      for(const isolation of ['REPEATABLE READ','SERIALIZABLE']){
        const client=await runtime.connectSql();
        try{
          await client.query('BEGIN ISOLATION LEVEL '+isolation);
          let error;try{await client.query('UPDATE public.ec_members SET activo=activo WHERE user_id=$1',[admin2.id]);}catch(caught){error=caught;}
          assert.ok(error);assert.equal(error.code,'0A000');assert.match(error.message,/MEMBERSHIP_ISOLATION_UNSUPPORTED/);
        }finally{await client.query('ROLLBACK').catch(()=>{});await client.end();}
      }
    });
    await check('bulk administrator removal rolls back every row and its audit entries',async()=>{
      const bulkOrg=await graph.organization('bulk');await graph.actor('bulk_a','admin',bulkOrg);await graph.actor('bulk_b','admin',bulkOrg);
      const before=await api.rows('ec_audit','org_id=eq.'+bulkOrg+'&order=id');
      await sqlFails('UPDATE public.ec_members SET activo=false WHERE org_id=$1',[bulkOrg],{role:'service_role',code:'23514'});
      assert.equal((await runtime.sql("SELECT count(*)::int n FROM public.ec_members WHERE org_id=$1 AND rol='admin' AND activo",[bulkOrg]))[0].n,2);
      assert.deepEqual(await api.rows('ec_audit','org_id=eq.'+bulkOrg+'&order=id'),before);
    });
    await check('inactive sites still cannot lose their final administrator through service SQL',async()=>{
      const inactiveOrg=await graph.organization('inactive_admin'),last=await graph.actor('inactive_admin','admin',inactiveOrg);
      api.ok(await api.request('/rest/v1/ec_orgs?id=eq.'+inactiveOrg,{method:'PATCH',json:{activo:false}}));
      await sqlFails('DELETE FROM public.ec_members WHERE user_id=$1',[last.id],{role:'service_role',code:'23514'});
      assert.equal((await api.rows('ec_members','user_id=eq.'+last.id)).length,1);
    });
    for(const operation of ['deactivate','demote','delete_member','delete_auth']){
      await check('READ COMMITTED concurrent '+operation+' preserves the last active administrator',async()=>{
        const raceOrg=await graph.organization('race_'+operation);
        const a=await graph.actor(operation+'_a','admin',raceOrg),b=await graph.actor(operation+'_b','admin',raceOrg);
        const statements={deactivate:'UPDATE public.ec_members SET activo=false WHERE user_id=$1',demote:"UPDATE public.ec_members SET rol='coord' WHERE user_id=$1",delete_member:'DELETE FROM public.ec_members WHERE user_id=$1',delete_auth:'DELETE FROM auth.users WHERE id=$1'};
        const first=await runtime.connectSql(),second=await runtime.connectSql();
        try{
          await first.query('BEGIN ISOLATION LEVEL READ COMMITTED');await second.query('BEGIN ISOLATION LEVEL READ COMMITTED');
          await first.query(statements[operation],[a.id]);
          let settled=false;
          const pending=second.query(statements[operation],[b.id]).then(value=>{settled=true;return{value};},error=>{settled=true;return{error};});
          let observedWait=false;
          for(let attempt=0;attempt<100&&!settled;attempt++){
            const locks=await runtime.sql("SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted",[second.processID]);
            if(locks.length){observedWait=true;break;}
            await sleep(20);
          }
          assert.ok(observedWait,'The second transaction did not wait on the membership advisory lock.');
          await first.query('COMMIT');
          const outcome=await pending;
          assert.ok(outcome.error,'Both administrator removals committed.');
          assert.equal(outcome.error.code,'23514');assert.match(outcome.error.message,/LAST_ADMIN_FORBIDDEN/);
          await second.query('ROLLBACK');
          const count=await runtime.sql("SELECT count(*)::int AS n FROM public.ec_members WHERE org_id=$1 AND rol='admin' AND activo",[raceOrg]);
          assert.equal(count[0].n,1);
        }finally{await first.query('ROLLBACK').catch(()=>{});await second.query('ROLLBACK').catch(()=>{});await first.end();await second.end();}
      });
    }
    await check('Auth API cascade cannot delete the last administrator; parent organization deletion can',async()=>{
      const lastOrg=await graph.organization('last_auth'),last=await graph.actor('last_auth_admin','admin',lastOrg);
      assert.ok(!(await api.request('/auth/v1/admin/users/'+last.id,{method:'DELETE'})).ok,'Auth deleted the last administrator.');
      assert.equal((await api.rows('ec_members','user_id=eq.'+last.id)).length,1);
      api.ok(await api.request('/rest/v1/ec_orgs?id=eq.'+lastOrg,{method:'DELETE'}),'Delete authorized parent organization');
      assert.equal((await api.rows('ec_members','user_id=eq.'+last.id)).length,0);
      api.ok(await api.request('/auth/v1/admin/users/'+last.id,{method:'DELETE'}),'Delete now-unassigned Auth fixture');
    });

    const orphan=await graph.document('private_orphan',org,study,finance,{type:'contrato',publish:false});
    await check('unpublished object is private to its uploader, including against site administrators',async()=>{
      api.ok(await api.download(finance,orphan.name),'Owner reads unpublished file');
      for(const actor of [coord,doctor,finance2,admin,outsider,api.anonymous])deny(await api.download(actor,orphan.name));
      const hijack={...orphan.data,id:runId+'_hijack',tipo:'protocolo'};
      assert.ok(!(await api.save(coord,'docs',hijack.id,hijack)).ok,'Another user published an uploader-private object.');
      assert.equal((await api.rows('ec_docs','id=eq.'+hijack.id)).length,0);
    });
    await check('authorized publication exposes contracts only to billing users',async()=>{
      api.ok(await api.save(finance,'docs',orphan.id,orphan.data),'Publish owned contract');
      for(const actor of [coord,doctor,outsider,api.anonymous])deny(await api.download(actor,orphan.name));
      const result=await api.download(finance2,orphan.name);api.ok(result,'Billing reads contract');
      assert.equal(sha256(result.raw),sha256(SYNTHETIC_PDF));
    });
    await check('publication racing orphan cleanup preserves the published object',async()=>{
      const item=await graph.document('publication_race',org,study,coord,{publish:false});
      const publishing=await runtime.connectSql();
      let pending;
      try{
        await publishing.query('BEGIN');await publishing.query('SET LOCAL ROLE authenticated');await publishing.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify(claims(coord))]);
        await publishing.query('SELECT public.ec_save_record($1,$2,$3::jsonb,$4,$5,$6,$7,$8)',['docs',item.id,JSON.stringify(item.data),null,randomUUID(),'alta','Synthetic publication race','Synthetic concurrency check']);
        // Use the real Storage API: current official Storage rejects direct
        // DELETE SQL before object-level application triggers can run.
        let settled=false;pending=api.removeObject(coord,item.name).finally(()=>{settled=true;});
        let waited=false;
        for(let attempt=0;attempt<100&&!settled;attempt++){
          const rows=await runtime.sql("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))",[publishing.processID]);
          if(rows.length){waited=true;break;}await sleep(20);
        }
        assert.ok(waited,'Orphan deletion did not wait for concurrent publication.');
        await publishing.query('COMMIT');const outcome=await pending;
        assert.ok(!removed(outcome,item.name),'Cleanup deleted a concurrently published object.');
        if(outcome.ok)assert.deepEqual(outcome.body,[]);else deny(outcome);
        const bytes=await api.download(coord,item.name);api.ok(bytes,'Published race object remains');assert.equal(sha256(bytes.raw),sha256(SYNTHETIC_PDF));
      }finally{await publishing.query('ROLLBACK').catch(()=>{});await pending?.catch(()=>{});await publishing.end();}
    });
    const clinical=await graph.document('clinical',org,study,coord);
    await check('published bytes reject replacement by upsert or update and retain their hash',async()=>{
      const replacement=Buffer.from('Synthetic unauthorized replacement');
      for(const actor of [coord,doctor,admin]){
        deny(await graph.upload(actor,clinical.name,replacement,{upsert:true}));
        deny(await graph.upload(actor,clinical.name,replacement,{method:'PUT'}));
      }
      const downloaded=await api.download(coord,clinical.name);api.ok(downloaded,'Original clinical bytes');
      assert.equal(sha256(downloaded.raw),sha256(SYNTHETIC_PDF));
    });
    await check('published document classification and object identity are immutable',async()=>{
      const current=(await api.rows('ec_docs','id=eq.'+clinical.id))[0];
      for(const change of [{tipo:'contrato'},{path:orphan.data.path},{estudioId:otherStudy},{storage:'local'}]){
        assert.ok(!(await api.save(admin,'docs',clinical.id,{...clinical.data,...change},{expectedRev:current.rev,action:'modificacion'})).ok,'A published document changed its security identity.');
      }
      assert.deepEqual((await api.rows('ec_docs','id=eq.'+clinical.id))[0].data,current.data);
    });
    await check('deactivated site invalidates previously issued JWT access',async()=>{
      api.ok(await api.request('/rest/v1/ec_orgs?id=eq.'+org,{method:'PATCH',json:{activo:false}}),'Deactivate synthetic site');
      try{
        deny(await api.download(coord,clinical.name));
        assert.ok(!(await api.save(admin,'records',runId+'_inactive',{...recordData,id:runId+'_inactive'})).ok);
      }finally{api.ok(await api.request('/rest/v1/ec_orgs?id=eq.'+org,{method:'PATCH',json:{activo:true}}),'Reactivate synthetic site');}
    });
    await check('document deletion retires metadata before bytes and never reopens the original path',async()=>{
      assert.ok(!removed(await api.removeObject(doctor,clinical.name),clinical.name),'Published bytes were removed before metadata retirement.');
      const intact=await api.download(coord,clinical.name);api.ok(intact,'Published bytes remain');assert.equal(sha256(intact.raw),sha256(SYNTHETIC_PDF));
      const current=(await api.rows('ec_docs','id=eq.'+clinical.id))[0];
      api.ok(await api.removeRecord(doctor,'docs',clinical.id,current.rev),'Retire synthetic document metadata');
      assert.equal((await api.rows('ec_docs','id=eq.'+clinical.id)).length,0);
      assert.ok(removed(await api.removeObject(doctor,clinical.name),clinical.name),'Authorized retired bytes were not cleaned.');
      for(const actor of [coord,admin,api.service])deny(await graph.upload(actor,clinical.name,SYNTHETIC_PDF));
      deny(await api.download(coord,clinical.name));
    });
    report.passed=true;
  }catch(error){report.error=error.message;}
  finally{
    if(graph){report.syntheticOrganizations=[...graph.state.orgs];report.cleanup=await graph.cleanup();}
    if(report.cleanup.some(item=>item.status!=='passed'))report.passed=false;
    report.finishedAt=new Date().toISOString();
  }
  return report;
}

// The actual Edge entrypoint, evaluated in Node, talks only to the supervisor's
// disposable local Auth/PostgREST services. All identities belong to this run;
// mail is captured by the supervisor's loopback SMTP server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {webcrypto,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createFixtureGraph} from './synthetic-supabase-fixtures.mjs';

const sourcePath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../supabase/functions/crear-usuario/index.ts');

export async function runUserAdministrationIntegration(env,{preservedAuditOrganizations=[],localMailCapture=false,log=()=>{}}={}){
  assert.equal(localMailCapture,true,'A running loopback SMTP capture is required.');
  const source=fs.readFileSync(sourcePath,'utf8');
  const report={startedAt:new Date().toISOString(),passed:false,checks:[],cleanup:[],syntheticOrganizations:[],
    edgeSourceSha256:createHash('sha256').update(source).digest('hex'),
    limitations:['Real Edge source executes in a Node VM, not the hosted Deno runtime','Mail delivery is loopback SMTP only']};
  let graph;
  async function check(name,run){
    try{await run();report.checks.push({name,status:'passed'});log('OK '+name);}
    catch(error){report.checks.push({name,status:'failed',message:error.message});throw error;}
  }
  try{
    graph=await createFixtureGraph(env,{preservedAuditOrganizations});
    const {api,runId,state}=graph;
    const origin=new URL(api.config.url).origin;
    assert.equal(new URL(origin).hostname,'127.0.0.1');
    const main=await graph.organization('administration_main'),other=await graph.organization('administration_other');
    const admin=await graph.actor('administrator','admin',main);
    const superadmin=await graph.actor('superadministrator','admin',main,[],{superadmin:true});
    await graph.actor('other_administrator','admin',other);
    async function pending(label,org){
      const email=runId+'-'+label+'@example.invalid';
      const body=api.ok(await api.request('/auth/v1/admin/users',{method:'POST',json:{email,email_confirm:false}}),'Create owned pending fixture');
      const user=body.user||body;state.authIds.push(user.id);
      assert.ok(!user.email_confirmed_at,'Fixture must be unconfirmed.');
      await api.insert('ec_members',{user_id:user.id,org_id:org,rol:'coord',activo:true});
      const profileId=runId+'_'+label;
      await api.insert('ec_users',{id:profileId,org_id:org,data:{id:profileId,authId:user.id,email,rol:'coord',activo:true,estudios:[]}});
      return {id:user.id,email,org};
    }
    const samePending=await pending('pending_same_site',main),otherPending=await pending('pending_other_site',other);
    let serve;
    const calls=[];
    let failInvitation=false;
    const edgeEnv={SUPABASE_URL:api.config.url,SUPABASE_SERVICE_ROLE_KEY:api.config.serviceKey,
      SUPABASE_ANON_KEY:api.config.publicKey,APP_URL:'https://127.0.0.1:55526/zonda/'};
    const localFetch=async(input,options={})=>{
      const url=new URL(input instanceof Request?input.url:input);
      assert.equal(url.origin,origin,'Edge attempted a request outside the disposable local services.');
      assert.ok(url.pathname.startsWith('/auth/v1/')||url.pathname.startsWith('/rest/v1/'));
      const method=options.method||'GET';
      calls.push({method,path:url.pathname});
      if(failInvitation&&method==='POST'&&url.pathname==='/auth/v1/invite')return new Response('{}',{status:503});
      const response=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(15000)});
      // Only creation responses are inspected in memory, to register exact
      // synthetic IDs for cleanup. Tokens and secret headers are never logged.
      if(response.ok&&method==='POST'&&url.pathname==='/auth/v1/admin/users'){
        const body=await response.clone().json(),user=body.user||body;
        assert.ok(String(user.email).startsWith(runId+'-')&&String(user.email).endsWith('@example.invalid'));
        if(!state.authIds.includes(user.id))state.authIds.push(user.id);
      }
      if(response.ok&&method==='POST'&&url.pathname==='/rest/v1/ec_orgs'){
        const body=await response.clone().json();
        for(const org of body)if(!state.orgs.includes(org.id))state.orgs.push(org.id);
      }
      return response;
    };
    vm.runInContext(stripTypeScriptTypes(source),vm.createContext({fetch:localFetch,Request,Response,URL,AbortSignal,
      Error,DOMException,crypto:webcrypto,Deno:{env:{get:name=>edgeEnv[name]},serve:handler=>{serve=handler;}}}));
    assert.equal(typeof serve,'function');
    const invoke=async(actor,body)=>{
      const response=await serve(new Request(origin+'/functions/v1/crear-usuario',{method:'POST',
        headers:{Authorization:'Bearer '+actor.token,'Content-Type':'application/json'},body:JSON.stringify(body)}));
      return {status:response.status,body:await response.json()};
    };
    const membership=target=>api.rows('ec_members','select=user_id,org_id,rol,activo,superadmin&user_id=eq.'+target.id);
    const authUser=async target=>{
      const body=api.ok(await api.request('/auth/v1/admin/users/'+target.id),'Read owned synthetic Auth account');
      return body.user||body;
    };
    const users=async()=>api.ok(await api.request('/auth/v1/admin/users?page=1&per_page=100'),'List synthetic Auth accounts').users;

    await check('official Auth invitation reuses the owned unconfirmed fixture identity',async()=>{
      const body=api.ok(await api.request('/auth/v1/invite',{method:'POST',json:{email:samePending.email}}),'Invite owned pending fixture through local SMTP');
      assert.equal((body.user||body).id,samePending.id);
      assert.ok(!(await authUser(samePending)).email_confirmed_at);
    });
    for(const [label,target] of [['same site',samePending],['another site',otherPending]]){
      await check('duplicate pending user in '+label+' is preserved by the actual administration handler',async()=>{
        const before=await membership(target),authIds=(await users()).map(u=>u.id).sort(),start=calls.length;
        const result=await invoke(admin,{accion:'usuario',email:target.email,rol:'coord'});
        assert.equal(result.status,500);assert.equal(result.body.code,'USER_CREATE_FAILED');
        assert.deepEqual(await membership(target),before);
        assert.equal((await authUser(target)).id,target.id);
        assert.deepEqual((await users()).map(u=>u.id).sort(),authIds);
        assert.equal(calls.slice(start).filter(c=>c.path.startsWith('/auth/')&&c.method==='DELETE').length,0);
        assert.equal(calls.slice(start).filter(c=>c.path==='/auth/v1/invite').length,0);
      });
    }
    await check('duplicate pending site administrator rolls back only the newly created site',async()=>{
      const before=await membership(otherPending),orgIds=(await api.rows('ec_orgs','select=id')).map(o=>o.id).sort(),start=calls.length;
      const result=await invoke(superadmin,{accion:'organizacion',nombre:'Synthetic duplicate site',email:otherPending.email});
      assert.equal(result.status,500);assert.equal(result.body.code,'USER_CREATE_FAILED');
      assert.deepEqual(await membership(otherPending),before);assert.equal((await authUser(otherPending)).id,otherPending.id);
      assert.deepEqual((await api.rows('ec_orgs','select=id')).map(o=>o.id).sort(),orgIds);
      assert.equal(calls.slice(start).filter(c=>c.path.startsWith('/auth/')&&c.method==='DELETE').length,0);
    });
    await check('new invited account has memberships and profile before the invitation is sent',async()=>{
      const email=runId+'-new_invited@example.invalid',start=calls.length;
      const result=await invoke(admin,{accion:'usuario',email,rol:'coord'});
      assert.equal(result.status,200);assert.equal(result.body.applied,true);assert.equal(result.body.invitation_pending,false);
      const user=(await users()).find(u=>u.email===email);assert.ok(user?.id);assert.ok(user.invited_at);
      assert.equal((await membership(user))[0]?.org_id,main);
      assert.equal((await api.rows('ec_users','select=id&data->>authId=eq.'+user.id)).length,1);
      const writes=calls.slice(start).filter(c=>c.method==='POST').map(c=>c.path);
      assert.ok(writes.indexOf('/auth/v1/admin/users')<writes.indexOf('/rest/v1/ec_members'));
      assert.ok(writes.indexOf('/rest/v1/ec_members')<writes.indexOf('/rest/v1/ec_users'));
      assert.ok(writes.indexOf('/rest/v1/ec_users')<writes.indexOf('/auth/v1/invite'));
    });
    await check('invitation transport failure retains the newly created account and reports its pending delivery',async()=>{
      const email=runId+'-invitation_pending@example.invalid',start=calls.length;failInvitation=true;
      try{
        const result=await invoke(admin,{accion:'usuario',email,rol:'coord'});
        assert.equal(result.status,200);assert.equal(result.body.applied,true);assert.equal(result.body.invitation_pending,true);
        const user=(await users()).find(u=>u.email===email);assert.ok(user?.id);
        assert.equal((await membership(user))[0]?.org_id,main);
        assert.equal((await api.rows('ec_users','select=id&data->>authId=eq.'+user.id)).length,1);
        assert.equal(calls.slice(start).filter(c=>c.path.startsWith('/auth/')&&c.method==='DELETE').length,0);
      }finally{failInvitation=false;}
    });
    await check('valid ten-character temporary password creates a working synthetic account',async()=>{
      const email=runId+'-ten_character@example.invalid',password='Ae7!kM2#qZ';
      assert.equal(password.length,10);
      const result=await invoke(admin,{accion:'usuario',email,rol:'coord',claveTemporal:password});
      assert.equal(result.status,200);assert.equal(result.body.applied,true);
      const session=await api.login(email,password);
      assert.equal(session.user.email,email);assert.equal(session.user.user_metadata.clave_temporal,true);
      assert.equal((await membership(session.user))[0]?.org_id,main);
    });
    await check('administrator changes their own password without marking it as temporary',async()=>{
      const password='Dn4@wR8!jP';
      assert.equal(password.length,10);
      const result=await invoke(admin,{accion:'cambiar_clave',authId:admin.id,claveTemporal:password});
      assert.equal(result.status,200);assert.equal(result.body.applied,true);
      const session=await api.login(admin.email,password);
      assert.equal(session.user.id,admin.id);
      assert.equal(session.user.user_metadata.clave_temporal,false);
      admin.token=session.access_token;
    });
    await check('superadministrator assigning another account password marks it as temporary',async()=>{
      const password='Fu6#nT3!rB';
      assert.equal(password.length,10);
      const result=await invoke(superadmin,{accion:'cambiar_clave',authId:admin.id,claveTemporal:password});
      assert.equal(result.status,200);assert.equal(result.body.applied,true);
      const session=await api.login(admin.email,password);
      assert.equal(session.user.id,admin.id);
      assert.equal(session.user.user_metadata.clave_temporal,true);
      admin.token=session.access_token;
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

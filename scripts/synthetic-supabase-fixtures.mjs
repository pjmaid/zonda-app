// Shared fixtures for real, disposable loopback integration runs. No production
// credentials, source rows, or Auth exports are accepted by these helpers.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { validateTestConfig, isMissingStorageBucket } from './verify-supabase-integration.mjs';

export const APP_TABLES = ['ec_orgs','ec_studies','ec_patients','ec_docs','ec_users','ec_visits','ec_records','ec_checklists','ec_settings','ec_audit','ec_members'];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const SYNTHETIC_PDF = Buffer.from('%PDF-1.4\n% Synthetic Zonda fixture; no patient data.\n%%EOF\n');

export function createSyntheticClient(env, {fetchImpl=fetch}={}) {
  const config = validateTestConfig(env);
  assert.equal(config.mode, 'local', 'These destructive synthetic checks accept loopback mode only.');
  const service = {key:config.serviceKey, token:config.serviceKey};
  const anonymous = {key:config.publicKey};
  async function request(route, {actor=service,method='GET',json,bytes,headers={}}={}) {
    assert.ok(route.startsWith('/') && !route.startsWith('//'), 'Only API-relative paths are allowed.');
    const requestHeaders = {apikey:actor.key || config.publicKey, ...headers};
    if (actor.token) requestHeaders.Authorization = 'Bearer ' + actor.token;
    if (json !== undefined) requestHeaders['Content-Type'] = 'application/json';
    const response = await fetchImpl(config.url + route, {method, headers:requestHeaders,
      body:json !== undefined ? JSON.stringify(json) : bytes, redirect:'error', signal:AbortSignal.timeout(30000)});
    const raw = Buffer.from(await response.arrayBuffer());
    let body = null; try { body = JSON.parse(raw.toString()); } catch {}
    return {status:response.status, ok:response.ok, body, raw};
  }
  function ok(result, label='Fixture request') {
    assert.ok(result.ok, label + ': HTTP ' + result.status + (result.body?.code ? ' (' + result.body.code + ')' : ''));
    return result.body;
  }
  async function insert(table, row) {
    assert.ok(APP_TABLES.includes(table));
    return ok(await request('/rest/v1/' + table, {method:'POST', json:row, headers:{Prefer:'return=representation'}}), 'Insert ' + table);
  }
  async function rows(table, query='') {
    assert.ok(APP_TABLES.includes(table));
    return ok(await request('/rest/v1/' + table + '?' + query), 'Read ' + table);
  }
  const objectRoute = name => '/storage/v1/object/ec-docs/' + name.split('/').map(encodeURIComponent).join('/');
  async function download(actor, name) { return request(objectRoute(name), {actor}); }
  async function upload(actor, name, bytes=SYNTHETIC_PDF, {upsert=false,method='POST'}={}) {
    return request(objectRoute(name), {actor, method, bytes, headers:{'Content-Type':'application/pdf','x-upsert':String(upsert)}});
  }
  async function removeObject(actor, name) { return request('/storage/v1/object/ec-docs', {actor,method:'DELETE',json:{prefixes:[name]}}); }
  async function save(actor, kind, id, data, {expectedRev=null,eventId=randomUUID(),action='alta',detail='Synthetic integration fixture',reason='Synthetic integration check'}={}) {
    return request('/rest/v1/rpc/ec_save_record', {actor,method:'POST',json:{p_kind:kind,p_id:id,p_data:data,p_expected_rev:expectedRev,p_event_id:eventId,p_action:action,p_detail:detail,p_motivo:reason}});
  }
  async function removeRecord(actor, kind, id, expectedRev, {eventId=randomUUID(),detail='Synthetic record deletion',reason='Synthetic integration check'}={}) {
    return request('/rest/v1/rpc/ec_remove_record', {actor,method:'POST',json:{p_kind:kind,p_id:id,p_expected_rev:expectedRev,p_event_id:eventId,p_detail:detail,p_motivo:reason}});
  }
  async function login(email,password) {
    return ok(await request('/auth/v1/token?grant_type=password', {actor:anonymous,method:'POST',json:{email,password}}), 'Synthetic login');
  }
  async function assertEmpty({auditOrganizations=[]}={}) {
    for (const table of APP_TABLES) {
      if(table==='ec_audit' && auditOrganizations.length){
        const history=await rows(table,'select=id,org_id&order=id&limit=10000');
        assert.ok(Array.isArray(history)&&history.every(row=>auditOrganizations.includes(row.org_id)),'Audit history contains an organization outside the exact synthetic allowlist.');
        continue;
      }
      const key = table === 'ec_members' ? 'user_id' : 'id';
      const found = await rows(table, 'select=' + key + '&limit=1');
      assert.ok(Array.isArray(found) && found.length === 0, 'Synthetic target must be empty: ' + table);
    }
    const users = ok(await request('/auth/v1/admin/users?page=1&per_page=1'), 'Verify empty Auth');
    assert.ok(Array.isArray(users.users) && users.users.length === 0, 'Synthetic Auth target must be empty.');
    const bucket = await request('/storage/v1/bucket/ec-docs');
    if (bucket.ok) {
      assert.equal(bucket.body.public,false,'Fixture bucket must be private.');
      const objects = ok(await request('/storage/v1/object/list/ec-docs',{method:'POST',json:{prefix:'',limit:1,offset:0}}),'Verify empty Storage');
      assert.ok(Array.isArray(objects) && objects.length === 0,'Fixture bucket must be empty.');
    } else assert.ok(isMissingStorageBucket(bucket),'Unable to verify empty Storage.');
    return bucket;
  }
  return {config,service,anonymous,request,ok,insert,rows,download,upload,removeObject,save,removeRecord,login,assertEmpty};
}

export async function createFixtureGraph(env, options={}) {
  const api = createSyntheticClient(env, options);
  const runId = 'zs_' + Date.now().toString(36) + '_' + randomBytes(4).toString('hex');
  const state = {orgs:[],authIds:[],objects:new Set(),bucketCreated:false};
  const preservedAuditOrganizations=options.preservedAuditOrganizations||[];
  const bucket = await api.assertEmpty({auditOrganizations:preservedAuditOrganizations});
  if (!bucket.ok) {
    api.ok(await api.request('/storage/v1/bucket',{method:'POST',json:{id:'ec-docs',name:'ec-docs',public:false}}),'Create synthetic private bucket');
    state.bucketCreated = true;
  }
  async function organization(label) {
    const id = randomUUID(); state.orgs.push(id);
    await api.insert('ec_orgs',{id,nombre:'Synthetic Zonda ' + runId + ' ' + label,activo:true});
    return id;
  }
  async function study(org,label) {
    const id = runId + '_' + label;
    await api.insert('ec_studies',{id,org_id:org,data:{id,nombre:'Synthetic protocol',codigo:id}});
    return id;
  }
  async function actor(label,role,org,studies=[],{billing=false,superadmin=false}={}) {
    const email = runId + '-' + label + '@example.invalid';
    const password = randomBytes(28).toString('base64url') + 'Aa7!';
    const body = api.ok(await api.request('/auth/v1/admin/users',{method:'POST',json:{email,password,email_confirm:true}}),'Create synthetic Auth account');
    const user = body.user || body;
    assert.match(user.id,/^[a-f0-9-]{36}$/i); state.authIds.push(user.id);
    await api.insert('ec_members',{user_id:user.id,org_id:org,rol:role,activo:true,superadmin});
    const profileId = runId + '_' + label;
    await api.insert('ec_users',{id:profileId,org_id:org,data:{id:profileId,authId:user.id,email,nombre:'Synthetic ' + label,rol:role,estudios:studies,facturacion:billing,activo:true}});
    const session = await api.login(email,password);
    assert.equal(session.user.id,user.id);
    return {id:user.id,profileId,email,password,token:session.access_token,org,role};
  }
  async function upload(owner,name,bytes=SYNTHETIC_PDF,options={}) {
    state.objects.add(name);
    return api.upload(owner,name,bytes,options);
  }
  async function document(label,org,studyId,owner,{type='protocolo',bytes=SYNTHETIC_PDF,publish=true}={}) {
    const id = runId + '_' + label;
    const relative = studyId + '/' + id + '/fixture.pdf';
    const name = org + '/' + relative;
    api.ok(await upload(owner,name,bytes),'Upload synthetic document');
    const data = {id,estudioId:studyId,tipo:type,path:relative,storage:'supabase',nombre:'fixture.pdf'};
    if (publish) api.ok(await api.save(owner,'docs',id,data),'Publish synthetic document');
    return {id,name,data,bytes};
  }
  async function cleanup() {
    const results=[];
    const retainedBefore=await api.rows('ec_audit','select=id,org_id&order=id&limit=10000');
    async function step(name,run) {
      try { await run(); results.push({name,status:'passed'}); }
      catch(error) { results.push({name,status:'failed',message:error.message}); }
    }
    // Parent-first cascade is the deliberate administrative deletion path;
    // individual last-admin removal must remain blocked by the new trigger.
    // The cascade also retires document metadata before Storage byte cleanup;
    // published object bytes cannot be removed while their live row exists.
    for (const org of state.orgs) await step('synthetic organization '+org,async()=>api.ok(await api.request('/rest/v1/ec_orgs?id=eq.'+org,{method:'DELETE'}),'Delete synthetic organization'));
    if (state.objects.size) await step('synthetic object bytes',async()=>api.ok(await api.request('/storage/v1/object/ec-docs',{method:'DELETE',json:{prefixes:[...state.objects]}}),'Delete synthetic objects'));
    for (const id of state.authIds) await step('synthetic Auth account '+id,async()=>{
      const result=await api.request('/auth/v1/admin/users/'+id,{method:'DELETE'});
      if(result.status!==404)api.ok(result,'Delete synthetic Auth account');
    });
    // Audit is append-only even for service_role. Test cleanup deliberately
    // preserves it and verifies history survives deletion of the fixture orgs.
    await step('append-only audit history retained',async()=>{
      const after=await api.rows('ec_audit','select=id,org_id&order=id&limit=10000');
      const ids=new Set(after.map(row=>String(row.id)));
      assert.ok(retainedBefore.every(row=>ids.has(String(row.id))),'Fixture cleanup removed historical audit rows.');
    });
    if(state.bucketCreated)await step('synthetic empty bucket',async()=>api.ok(await api.request('/storage/v1/bucket/ec-docs',{method:'DELETE'}),'Delete synthetic bucket'));
    await step('no fixture entities remain; audit is retained',()=>api.assertEmpty({auditOrganizations:[...preservedAuditOrganizations,...state.orgs]}));
    return results;
  }
  return {api,runId,state,organization,study,actor,upload,document,cleanup};
}

import {requiredEnv,resolveEnv} from "./config.mjs";

const corsHeaders={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type"};
const MAX_RETURN_RESULTS=25;
const ALLOWED_TYPES=["protocolo","manual","enmienda","ci"] as const;
const allowedTypes=new Set<string>(ALLOWED_TYPES);
let tokenCache:{value:string;expires:number}|null=null;

const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...corsHeaders,"Content-Type":"application/json"}});
const readEnv=(name:string)=>Deno.env.get(name);
function env(name:string,legacyName?:string){return requiredEnv(readEnv,name,legacyName);}
function validId(value:unknown,error:string){const id=String(value||"");if(!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw new Error(error);return id;}
function clampResults(value:unknown){const n=Number.parseInt(String(value||""),10);return Number.isFinite(n)?Math.max(1,Math.min(MAX_RETURN_RESULTS,n)):MAX_RETURN_RESULTS;}
function b64url(input:Uint8Array|string){const bytes=typeof input==="string"?new TextEncoder().encode(input):input;let s="";for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");}
function b64text(input:string){let s="";for(const b of new TextEncoder().encode(input))s+=String.fromCharCode(b);return btoa(s);}
function pemBytes(pem:string){const s=atob(pem.replace(/-----[^-]+-----|\s/g,""));return Uint8Array.from(s,c=>c.charCodeAt(0));}

async function googleToken(){
  if(tokenCache&&tokenCache.expires>Date.now()+60000)return tokenCache.value;
  const service=JSON.parse(env("GOOGLE_SERVICE_ACCOUNT_JSON","GCP_SA_JSON")),now=Math.floor(Date.now()/1000);
  const header=b64url(JSON.stringify({alg:"RS256",typ:"JWT"}));
  const claim=b64url(JSON.stringify({iss:service.client_email,scope:"https://www.googleapis.com/auth/cloud-platform",aud:service.token_uri||"https://oauth2.googleapis.com/token",iat:now,exp:now+3600}));
  const key=await crypto.subtle.importKey("pkcs8",pemBytes(service.private_key),{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["sign"]);
  const sig=await crypto.subtle.sign("RSASSA-PKCS1-v1_5",key,new TextEncoder().encode(`${header}.${claim}`));
  const assertion=`${header}.${claim}.${b64url(new Uint8Array(sig))}`;
  const response=await fetch(service.token_uri||"https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion})});
  const body=await response.json().catch(()=>({}));
  if(!response.ok||!body.access_token)throw new Error(body.error_description||"GOOGLE_AUTH_FAILED");
  tokenCache={value:body.access_token,expires:Date.now()+Number(body.expires_in||3600)*1000};return tokenCache.value;
}

async function authenticate(req:Request){
  const supabaseUrl=env("SUPABASE_URL"),serviceKey=env("SUPABASE_SERVICE_ROLE_KEY"),anonKey=Deno.env.get("SUPABASE_ANON_KEY")||serviceKey;
  const authorization=req.headers.get("Authorization")||"";if(!authorization.startsWith("Bearer "))throw new Error("AUTH_REQUIRED");
  const userRes=await fetch(`${supabaseUrl}/auth/v1/user`,{headers:{Authorization:authorization,apikey:anonKey}});if(!userRes.ok)throw new Error("AUTH_REQUIRED");
  const user=await userRes.json();
  const memberRes=await fetch(`${supabaseUrl}/rest/v1/ec_members?select=org_id,rol,activo&user_id=eq.${encodeURIComponent(user.id)}&activo=eq.true&limit=1`,{headers:{Authorization:`Bearer ${serviceKey}`,apikey:serviceKey}});
  const members=memberRes.ok?await memberRes.json():[];if(!members[0])throw new Error("MEMBERSHIP_REQUIRED");
  return{supabaseUrl,anonKey,authorization,member:members[0]};
}
type Auth=Awaited<ReturnType<typeof authenticate>>;
async function assertStudyAccess(auth:Auth,studyId:string){
  const response=await fetch(`${auth.supabaseUrl}/rest/v1/ec_studies?select=id&id=eq.${encodeURIComponent(studyId)}&limit=1`,{headers:{Authorization:auth.authorization,apikey:auth.anonKey}});
  const rows=response.ok?await response.json():[];if(!rows[0])throw new Error("STUDY_ACCESS_REQUIRED");
}
async function clinicalDocument(auth:Auth,studyId:string,sourceDocId:unknown){
  const id=validId(sourceDocId,"SOURCE_DOCUMENT_REQUIRED");
  const response=await fetch(`${auth.supabaseUrl}/rest/v1/ec_docs?select=id,data&id=eq.${encodeURIComponent(id)}&limit=1`,{headers:{Authorization:auth.authorization,apikey:auth.anonKey}});
  const rows=response.ok?await response.json():[],data=rows[0]?.data||{};
  if(!rows[0]||data.estudioId!==studyId||!allowedTypes.has(String(data.tipo||""))||data.pacienteId)throw new Error("CLINICAL_DOCUMENT_ACCESS_REQUIRED");
  return{id,data};
}
async function shortHash(value:string){const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));return Array.from(new Uint8Array(d).slice(0,10)).map(b=>b.toString(16).padStart(2,"0")).join("");}
async function scopedDocId(orgId:string,docId:unknown){return `org-${await shortHash(orgId)}-${validId(docId,"INVALID_DOCUMENT_ID")}`.slice(0,128);}

function config(){
  const project=env("RAG_PROJECT_ID","GCP_PROJECT"),location=resolveEnv(readEnv,"RAG_LOCATION","GCP_LOCATION")||"global",dataStore=env("RAG_DATA_STORE_ID","GCP_DATASTORE"),engine=env("RAG_ENGINE_ID","GCP_ENGINE");
  const root=`projects/${project}/locations/${location}/collections/default_collection`;
  const endpoint=location==="global"?"discoveryengine.googleapis.com":`${location}-discoveryengine.googleapis.com`;
  return{location,dataStore,engine,root,endpoint};
}
async function googleFetch(path:string,init:RequestInit={}){
  const response=await fetch(`https://${config().endpoint}/v1/${path}`,{...init,headers:{...(init.headers||{}),Authorization:`Bearer ${await googleToken()}`,"Content-Type":"application/json"}});
  const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(String(body?.error?.message||`GOOGLE_RAG_HTTP_${response.status}`).slice(0,500));return body;
}
function prepareText(text:string){
  const parts=String(text||"").replace(/\r/g,"").split(/=== PÁGINA (\d+) ===/);if(parts.length<3)return truncateUtf8(String(text||""));
  const out:string[]=[];for(let i=1;i<parts.length;i+=2){const page=Number.parseInt(parts[i],10),content=String(parts[i+1]||"").trim();for(let pos=0;pos<content.length;pos+=1400)out.push(`[PÁGINA ${page}]\n${content.slice(pos,pos+1400)}`);}
  return truncateUtf8(out.join("\n\n"));
}
function truncateUtf8(text:string){const bytes=new TextEncoder().encode(text);return bytes.length<=950000?text:new TextDecoder().decode(bytes.slice(0,950000));}
function escapeFilter(value:string){return value.replace(/\\/g,"\\\\").replace(/"/g,'\\"');}
function clinicalFilter(orgId:string,studyId:string){const types=ALLOWED_TYPES.map(t=>`"${t}"`).join(",");return`structData.org_id: ANY("${escapeFilter(orgId)}") AND structData.estudio_id: ANY("${escapeFilter(studyId)}") AND structData.tipo: ANY(${types})`;}

function deepValues(value:unknown,re:RegExp,out:unknown[]=[]){if(!value||typeof value!=="object")return out;for(const[k,v]of Object.entries(value as Record<string,unknown>)){if(re.test(k))out.push(v);deepValues(v,re,out);}return out;}
function pageFrom(reference:unknown){for(const v of deepValues(reference,/page(?:Identifier|Number)?$/i)){const p=Number.parseInt(String(v||"").replace(/\D+/g,""),10);if(p>0)return p;}for(const t of deepValues(reference,/content|text/i).map(String)){const m=t.match(/\[PÁGINA\s+(\d+)\]/i);if(m)return Number.parseInt(m[1],10);}return null;}
function verifiedCitations(answer:any){
  const refs=Array.isArray(answer?.references)?answer.references:[],used=new Set<string>();
  for(const c of(Array.isArray(answer?.citations)?answer.citations:[]))for(const s of(Array.isArray(c?.sources)?c.sources:[]))used.add(String(s?.referenceId));
  return refs.map((reference:any,index:number)=>({reference,index})).filter(({index})=>!used.size||used.has(String(index))||used.has(String(index+1))).map(({reference})=>({
    documento:String(reference?.chunkInfo?.documentMetadata?.title||reference?.unstructuredDocumentInfo?.documentTitle||"").slice(0,200),pagina:pageFrom(reference),cita:String(reference?.chunkInfo?.content||reference?.unstructuredDocumentInfo?.documentContexts?.[0]?.content||"").slice(0,800)
  })).filter((c:any)=>c.documento&&c.pagina&&c.cita);
}

async function indexDocument(auth:Auth,input:any){
  const studyId=validId(input?.estudio_id,"STUDY_SCOPE_REQUIRED");await assertStudyAccess(auth,studyId);
  if(input?.paciente_id)throw new Error("PATIENT_DATA_NOT_ALLOWED");const source=await clinicalDocument(auth,studyId,input?.source_doc_id),type=String(source.data.tipo);
  const text=prepareText(String(input?.texto||""));if(text.trim().length<50)throw new Error("DOCUMENT_TEXT_REQUIRED");
  const id=await scopedDocId(auth.member.org_id,input?.doc_id),cfg=config(),name=`${cfg.root}/dataStores/${cfg.dataStore}/branches/default_branch/documents/${id}`;
  await googleFetch(`${name}?allowMissing=true`,{method:"PATCH",body:JSON.stringify({name,id,structData:{org_id:auth.member.org_id,estudio_id:studyId,tipo:type,title:String(source.data.filename||input?.titulo||"").slice(0,300)},content:{mimeType:"text/plain",rawBytes:b64text(text)}})});return{ok:true};
}
async function ask(auth:Auth,input:any){
  const studyId=validId(input?.estudio_id,"STUDY_SCOPE_REQUIRED");await assertStudyAccess(auth,studyId);if(input?.paciente_id)throw new Error("PATIENT_DATA_NOT_ALLOWED");
  const question=String(input?.pregunta||"").trim();if(!question)throw new Error("QUESTION_REQUIRED");const cfg=config();
  const result=await googleFetch(`${cfg.root}/engines/${cfg.engine}/servingConfigs/default_search:answer`,{method:"POST",body:JSON.stringify({query:{text:question},answerGenerationSpec:{includeCitations:true,answerLanguageCode:"es",ignoreLowRelevantContent:true,promptSpec:{preamble:String(input?.preambulo||"").slice(0,4000)}},searchSpec:{searchParams:{maxReturnResults:clampResults(input?.max_fragmentos),filter:clinicalFilter(auth.member.org_id,studyId)}}})});
  const citas=verifiedCitations(result?.answer),respuesta=String(result?.answer?.answerText||"").trim();if(!respuesta||!citas.length)return{respuesta:"",citas:[],sinRespuesta:true,confiable:false};return{respuesta,citas,sinRespuesta:false,confiable:true};
}
async function deleteDocument(auth:Auth,input:any){
  const studyId=validId(input?.estudio_id,"STUDY_SCOPE_REQUIRED");await assertStudyAccess(auth,studyId);
  await clinicalDocument(auth,studyId,input?.source_doc_id);
  const cfg=config(),id=await scopedDocId(auth.member.org_id,input?.doc_id),name=`${cfg.root}/dataStores/${cfg.dataStore}/branches/default_branch/documents/${id}`;
  const doc=await googleFetch(name);
  if(doc?.structData?.org_id!==auth.member.org_id||doc?.structData?.estudio_id!==studyId||!allowedTypes.has(String(doc?.structData?.tipo||"")))throw new Error("DOCUMENT_ACCESS_REQUIRED");
  await googleFetch(name,{method:"DELETE"});return{ok:true};
}

Deno.serve(async(req)=>{if(req.method==="OPTIONS")return new Response("ok",{headers:corsHeaders});if(req.method!=="POST")return json({error:"METHOD_NOT_ALLOWED"},405);try{
  const auth=await authenticate(req),input=await req.json(),action=String(input?.accion||"");
  if(action==="estado")return json({ok:true,dataStore:config().dataStore,location:config().location,engine:config().engine,maxReturnResults:MAX_RETURN_RESULTS});
  if(action==="indexar")return json(await indexDocument(auth,input));if(action==="preguntar")return json(await ask(auth,input));
  if(action==="borrar")return json(await deleteDocument(auth,input));
  if(action==="listar")return json({total:0,documentos:[],mensaje:"El listado global está deshabilitado para evitar exponer metadatos entre protocolos."});return json({error:"INVALID_ACTION"},400);
}catch(error){const message=error instanceof Error?error.message:"INTERNAL_ERROR";const status=/AUTH_REQUIRED|MEMBERSHIP_REQUIRED/.test(message)?401:/STUDY_ACCESS_REQUIRED/.test(message)?403:/REQUIRED|INVALID|NOT_ALLOWED/.test(message)?400:500;return json({error:message},status);}});

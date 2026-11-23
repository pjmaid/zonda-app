#!/usr/bin/env node
// Generates SQL only. It has no database client, credentials, or network path.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const identifier=value=>'"'+String(value).replace(/"/g,'""')+'"';
const literal=value=>"'"+String(value).replace(/'/g,"''")+"'";
const qualified=(schema,name)=>identifier(schema)+'.'+identifier(name);
const statement=value=>String(value).trim().replace(/;\s*$/,'')+';';
const rights={a:'INSERT',r:'SELECT',w:'UPDATE',d:'DELETE',D:'TRUNCATE',x:'REFERENCES',t:'TRIGGER',m:'MAINTAIN',X:'EXECUTE',U:'USAGE',C:'CREATE'};
const defaultKinds={r:'TABLES',S:'SEQUENCES',f:'FUNCTIONS'};

function expect(condition,message){if(!condition)throw new Error(message);}
function integer(value,label){
  expect(typeof value==='string'||Number.isSafeInteger(value),label+' must be an exact integer, not a rounded JSON number.');
  expect(/^-?\d+$/.test(String(value)),label+' must be an integer.');
  return BigInt(value).toString();
}
function aclEntries(acl,owner){
  expect(Array.isArray(acl),'An explicit ACL is required for '+owner+'.');
  return acl.map(item=>{
    const match=/^([A-Za-z_][A-Za-z0-9_]*|)=([A-Za-z*]*)\/([A-Za-z_][A-Za-z0-9_]*)$/.exec(item);
    expect(match,'Unsupported ACL syntax: '+item);
    expect(match[3]===owner,'Uncaptured owner/grantor dependency in '+item);
    const grants=[];
    for(let n=0;n<match[2].length;n++){
      const code=match[2][n];expect(rights[code],'Unsupported ACL permission '+code);
      const option=match[2][n+1]==='*';if(option)n++;
      grants.push({name:rights[code],option});
    }
    return{role:match[1]||'PUBLIC',grants};
  });
}
function roleSQL(role){return role==='PUBLIC'?'PUBLIC':identifier(role);}
function objectAcl(kind,target,acl,owner,lookup){
  const entries=aclEntries(acl,owner),out=[];
  // A local Supabase installation may have different initial/default grants.
  // Remove its actual ACL entries, including PUBLIC, before reproducing this ACL.
  out.push(`DO $zonda_acl$\nDECLARE grantee_oid oid;\nBEGIN\n  FOR grantee_oid IN ${lookup}\n  LOOP\n    EXECUTE ${literal(`REVOKE ALL PRIVILEGES ON ${kind} ${target} FROM `)} || CASE WHEN grantee_oid=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(grantee_oid)) END;\n  END LOOP;\nEND\n$zonda_acl$;`);
  for(const entry of entries)for(const option of [false,true]){
    const selected=entry.grants.filter(grant=>grant.option===option).map(grant=>grant.name);
    if(selected.length)out.push(`GRANT ${selected.join(', ')} ON ${kind} ${target} TO ${roleSQL(entry.role)}${option?' WITH GRANT OPTION':''};`);
  }
  return out;
}
function defaultAcl(entry){
  expect(defaultKinds[entry.type],'Unsupported default ACL object kind '+entry.type);
  const scope=entry.schema===null?'':` IN SCHEMA ${identifier(entry.schema)}`;
  const prefix=`ALTER DEFAULT PRIVILEGES FOR ROLE ${identifier(entry.role)}${scope}`;
  const namespace=entry.schema===null?'0':`(SELECT oid FROM pg_namespace WHERE nspname=${literal(entry.schema)})`;
  const out=[`DO $zonda_defaults$\nDECLARE grantee_oid oid;\nBEGIN\n  FOR grantee_oid IN SELECT DISTINCT a.grantee FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a\n    WHERE d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=${literal(entry.role)})\n      AND d.defaclnamespace=${namespace} AND d.defaclobjtype=${literal(entry.type)}\n  LOOP\n    EXECUTE ${literal(prefix+` REVOKE ALL PRIVILEGES ON ${defaultKinds[entry.type]} FROM `)} || CASE WHEN grantee_oid=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(grantee_oid)) END;\n  END LOOP;\nEND\n$zonda_defaults$;`];
  for(const row of aclEntries(entry.acl,entry.role))for(const option of [false,true]){
    const selected=row.grants.filter(grant=>grant.option===option).map(grant=>grant.name);
    if(selected.length)out.push(`${prefix} GRANT ${selected.join(', ')} ON ${defaultKinds[entry.type]} TO ${roleSQL(row.role)}${option?' WITH GRANT OPTION':''};`);
  }
  return out;
}

export function renderTestSchema(catalog){
  for(const field of ['tables','functions','policies','sequences','default_acl','default_acl_global','schema_acl'])expect(Array.isArray(catalog[field]),'Missing catalog array: '+field);
  expect(catalog.default_acl_global.length===0,'Custom global default ACLs require an explicit renderer implementation; refusing to assume built-in defaults.');
  expect(catalog.tables.length>0,'The source catalog contains no tables.');
  expect(catalog.tables.every(table=>/^ec_[A-Za-z0-9_]+$/.test(table.name)),'Only public.ec_* tables are accepted.');
  const names=new Set();for(const table of catalog.tables){expect(!names.has(table.name),'Duplicate table '+table.name);names.add(table.name);}
  const requiredRoles=new Set(['postgres','pg_database_owner','anon','authenticated','service_role']);
  for(const entry of catalog.default_acl){requiredRoles.add(entry.role);for(const row of aclEntries(entry.acl,entry.role))if(row.role!=='PUBLIC')requiredRoles.add(row.role);}
  const out=[
    '-- Zonda synthetic test schema. Generated from a reviewed schema-only catalog.',
    `-- Capture date: ${String(catalog.capturedAt||'unknown').replace(/[\r\n]/g,' ')}. No source rows, credentials, account identities or bucket rows are copied.`,
    '-- Requires a fresh LOCAL Supabase PostgreSQL 17+ database with its managed Auth/Storage roles and schemas.',
    '-- Before execution, explicitly SET zonda.test_bootstrap = \'synthetic-only\' on this connection.',
    '-- This flag is a mandatory safety guard, not a network/environment detector. Never connect this script to a remote database.',
    '-- Managed extensions, Auth/Storage tables/functions/roles and their ACLs are intentionally supplied by Supabase, not recreated here.',
    '-- Captured extension versions are informational; this renderer neither installs nor upgrades extensions.',
    '-- Per-schema creator defaults are reproduced as captured; the separately captured global default ACL is empty.',
    '-- Built-in PostgreSQL global defaults are required and checked (including PUBLIC EXECUTE on newly created functions before migration revokes).',
    '-- Object owners are postgres (ACL grantor in this capture); the public schema owner is pg_database_owner.',
    'BEGIN;',
    `DO $zonda_guard$\nDECLARE missing_roles text;\nBEGIN\n  IF current_setting('zonda.test_bootstrap',true) IS DISTINCT FROM 'synthetic-only' THEN\n    RAISE EXCEPTION 'ZONDA_TEST_BOOTSTRAP_REQUIRED: explicitly opt into an empty synthetic local database';\n  END IF;\n  IF current_setting('server_version_num')::integer < 170000 THEN\n    RAISE EXCEPTION 'ZONDA_PG17_REQUIRED: MAINTAIN ACL must not be silently omitted';\n  END IF;\n  IF current_user <> 'postgres' THEN\n    RAISE EXCEPTION 'ZONDA_BOOTSTRAP_OWNER_REQUIRED: run as postgres in the disposable local database';\n  END IF;\n  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND left(c.relname,3)='ec_' AND c.relkind IN ('r','p','f','v','m','S')) THEN\n    RAISE EXCEPTION 'ZONDA_NONEMPTY_DATABASE: public.ec_* relations already exist; bootstrap aborted';\n  END IF;\n  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (left(p.proname,3)='ec_' OR p.proname IN ('current_org','current_rol','es_superadmin'))) THEN\n    RAISE EXCEPTION 'ZONDA_EXISTING_FUNCTIONS: refusing to replace pre-existing application functions';\n  END IF;\n  SELECT string_agg(role_name,', ') INTO missing_roles FROM unnest(ARRAY[${[...requiredRoles].map(literal).join(',')}]) role_name WHERE NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name);\n  IF missing_roles IS NOT NULL THEN RAISE EXCEPTION 'ZONDA_SUPABASE_ROLES_REQUIRED: %',missing_roles; END IF;\n  IF to_regclass('auth.users') IS NULL OR to_regclass('storage.objects') IS NULL OR to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('auth.jwt()') IS NULL THEN\n    RAISE EXCEPTION 'ZONDA_SUPABASE_BASE_REQUIRED: initialize real Auth/Storage before this application schema';\n  END IF;\nEND\n$zonda_guard$;`,
    // Keep pg_catalog implicit: PostgreSQL searches it first. Listing it last
    // would bind gen_random_uuid() to the pgcrypto compatibility function.
    'SET LOCAL search_path = public, extensions;',
    'SET LOCAL check_function_bodies = off;',
    '-- 1. Relations without callable defaults, constraints, or rows.'
  ];
  const capturedGlobalRoles=new Set(catalog.default_acl.filter(entry=>entry.schema===null).map(entry=>entry.role));
  const assumedGlobalRoles=[...new Set(catalog.default_acl.map(entry=>entry.role))].filter(role=>!capturedGlobalRoles.has(role));
  if(assumedGlobalRoles.length)out.push(`DO $zonda_global_defaults$\nBEGIN\n  IF EXISTS (SELECT 1 FROM pg_default_acl d WHERE d.defaclnamespace=0 AND pg_get_userbyid(d.defaclrole)=ANY(ARRAY[${assumedGlobalRoles.map(literal).join(',')}])) THEN\n    RAISE EXCEPTION 'ZONDA_GLOBAL_DEFAULTS_NOT_CAPTURED: custom global defaults exist; capture and compare them before bootstrapping';\n  END IF;\nEND\n$zonda_global_defaults$;`);
  for(const seq of catalog.sequences){
    out.push(`CREATE SEQUENCE ${qualified('public',seq.name)} AS bigint INCREMENT BY ${integer(seq.increment,'sequence increment')} MINVALUE ${integer(seq.min,'sequence minimum')} MAXVALUE ${integer(seq.max,'sequence maximum')} START WITH ${integer(seq.start,'sequence start')} CACHE ${integer(seq.cache,'sequence cache')} ${seq.cycle?'CYCLE':'NO CYCLE'};`);
    out.push(`ALTER SEQUENCE ${qualified('public',seq.name)} OWNER TO postgres;`);
  }
  for(const table of catalog.tables){
    expect(Array.isArray(table.columns)&&table.columns.length,'Missing columns for '+table.name);
    const columns=table.columns.map(column=>{
      expect(!column.identity,'Identity sequence options were not captured; refusing to guess for '+table.name+'.'+column.name);
      expect(!column.generated||column.generated==='s','Unsupported generated column mode for '+column.name);
      let definition=identifier(column.name)+' '+column.type;
      if(column.generated){expect(column.default,'Missing generated expression for '+column.name);definition+=' GENERATED ALWAYS AS ('+column.default+') STORED';}
      if(column.notnull)definition+=' NOT NULL';
      return '  '+definition;
    });
    out.push(`CREATE TABLE ${qualified('public',table.name)} (\n${columns.join(',\n')}\n);`);
    out.push(`ALTER TABLE ${qualified('public',table.name)} OWNER TO postgres;`);
  }
  out.push('-- 2. Exact captured function definitions; deferred body checks resolve mutual dependencies.');
  for(const fn of catalog.functions){
    expect(/^CREATE OR REPLACE FUNCTION public\./i.test(fn.definition),'Unexpected function DDL for '+fn.name);
    out.push(statement(fn.definition));
    out.push(`ALTER FUNCTION ${qualified('public',fn.name)}(${fn.args}) OWNER TO postgres;`);
  }
  out.push('-- 3. Sequence ownership and callable defaults only after functions exist.');
  for(const seq of catalog.sequences){
    expect(seq.table&&seq.owned_by,'Missing sequence ownership for '+seq.name);
    const table=seq.table.replace(/^public\./,'');expect(names.has(table),'Sequence owner table not captured: '+table);
    out.push(`ALTER SEQUENCE ${qualified('public',seq.name)} OWNED BY ${qualified('public',table)}.${identifier(seq.owned_by)};`);
  }
  for(const table of catalog.tables)for(const column of table.columns)if(column.default!==null&&!column.generated)
    out.push(`ALTER TABLE ${qualified('public',table.name)} ALTER COLUMN ${identifier(column.name)} SET DEFAULT ${column.default};`);
  out.push('-- 4. Every primary/unique/check constraint is in place before any foreign key.');
  for(const foreign of [false,true])for(const table of catalog.tables)for(const constraint of table.constraints||[])if((constraint.type==='f')===foreign)
    out.push(`ALTER TABLE ${qualified('public',table.name)} ADD CONSTRAINT ${identifier(constraint.name)} ${constraint.definition};`);
  for(const table of catalog.tables)for(const index of table.indexes||[])out.push(statement(index));
  out.push('-- 5. Captured triggers and row security. Managed Storage retains its own table ACL.');
  for(const table of catalog.tables){
    for(const trigger of table.triggers||[])out.push(statement(trigger));
    out.push(`ALTER TABLE ${qualified('public',table.name)} ${table.rls?'ENABLE':'DISABLE'} ROW LEVEL SECURITY;`);
    out.push(`ALTER TABLE ${qualified('public',table.name)} ${table.force_rls?'FORCE':'NO FORCE'} ROW LEVEL SECURITY;`);
  }
  for(const trigger of catalog.auth_triggers||[])out.push(statement(trigger));
  for(const policy of catalog.policies){
    expect(['public','storage'].includes(policy.schemaname),'Unexpected policy schema '+policy.schemaname);
    expect(['ALL','SELECT','INSERT','UPDATE','DELETE'].includes(policy.cmd),'Unsupported policy command');
    expect(['PERMISSIVE','RESTRICTIVE'].includes(policy.permissive),'Unsupported policy mode');
    if(policy.schemaname==='storage')out.push(`ALTER TABLE ${qualified(policy.schemaname,policy.tablename)} ENABLE ROW LEVEL SECURITY;`);
    out.push(`CREATE POLICY ${identifier(policy.policyname)} ON ${qualified(policy.schemaname,policy.tablename)} AS ${policy.permissive} FOR ${policy.cmd} TO ${policy.roles.map(role=>role==='public'?'PUBLIC':identifier(role)).join(', ')}${policy.qual?' USING ('+policy.qual+')':''}${policy.with_check?' WITH CHECK ('+policy.with_check+')':''};`);
  }
  out.push('-- 6. Reproduce exact relation/function/schema ACLs, including PG17 MAINTAIN.');
  for(const table of catalog.tables){
    const target=qualified('public',table.name);
    out.push(...objectAcl('TABLE',target,table.acl,'postgres',`SELECT DISTINCT a.grantee FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=${literal(target)}::regclass`));
  }
  for(const seq of catalog.sequences){
    const target=qualified('public',seq.name);
    out.push(...objectAcl('SEQUENCE',target,seq.acl,'postgres',`SELECT DISTINCT a.grantee FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('S',c.relowner))) a WHERE c.oid=${literal(target)}::regclass`));
  }
  for(const fn of catalog.functions){
    const target=qualified('public',fn.name)+'('+fn.args+')';
    // The argument string contains names as returned by pg_get_function_identity_arguments;
    // regprocedure accepts types only, so identify the captured function through its catalog identity.
    out.push(...objectAcl('FUNCTION',target,fn.acl,'postgres',`SELECT DISTINCT a.grantee FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE n.nspname='public' AND p.proname=${literal(fn.name)} AND pg_get_function_identity_arguments(p.oid)=${literal(fn.args)}`));
  }
  out.push('ALTER SCHEMA public OWNER TO pg_database_owner;');
  out.push(...objectAcl('SCHEMA','public',catalog.schema_acl,'pg_database_owner',"SELECT DISTINCT a.grantee FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='public'"));
  out.push('-- 7. Captured creator defaults, including postgres defaults used by the next migration.');
  for(const entry of catalog.default_acl)out.push(...defaultAcl(entry));
  out.push('SET LOCAL check_function_bodies = on;','COMMIT;','');
  return out.join('\n\n');
}

function main(args){
  let fixture=path.join(root,'tests/fixtures/schema-baseline-20261123.json'),output;
  for(let index=0;index<args.length;index++){
    if(args[index]==='--fixture')fixture=args[++index];
    else if(args[index]==='--output')output=args[++index];
    else if(args[index]==='--help'){
      process.stdout.write('Usage: node scripts/render-test-schema.mjs [--fixture catalog.json] [--output local-test-schema.sql]\nGenerates guarded SQL only; never connects to a database.\n');return;
    }else throw new Error('Unknown argument: '+args[index]);
  }
  expect(fixture,'Missing --fixture path');
  expect(!args.includes('--output')||output,'Missing --output path');
  const sql=renderTestSchema(JSON.parse(fs.readFileSync(fixture,'utf8')));
  if(output){fs.writeFileSync(output,sql);process.stderr.write(`Generated schema-only SQL: ${output}\n`);}else process.stdout.write(sql);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{main(process.argv.slice(2));}catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
}

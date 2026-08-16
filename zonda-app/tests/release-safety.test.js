const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const release=require('../release-tools.js');

const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const headers=fs.readFileSync(path.join(root,'netlify.toml'),'utf8');
const cloudflareHeaders=fs.readFileSync(path.join(root,'_headers'),'utf8');
const runtime=fs.readFileSync(path.join(root,'runtime-config.js'),'utf8');

test('escapa texto y atributos frente a cargas XSS frecuentes',()=>{
  const payload='"><img src=x onerror=alert(1)><script>alert(2)</script>&\'';
  const escaped=release.escapeHtml(payload);
  assert.equal(escaped,'&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;alert(2)&lt;/script&gt;&amp;&#39;');
  assert.doesNotMatch(escaped,/<|>|"|'/);
});

test('rechaza respaldos mal formados, IDs duplicados y claves peligrosas',()=>{
  assert.throws(()=>release.validateBackup({}),/respaldo de Zonda/);
  assert.throws(()=>release.validateBackup({studies:[{id:'x'},{id:'x'}],patients:[],visits:[]}),/ID duplicado/);
  const poisoned=JSON.parse('{"studies":[],"patients":[],"visits":[],"__proto__":{"admin":true}}');
  assert.throws(()=>release.validateBackup(poisoned),/Clave no permitida/);
});

test('acepta respaldos antiguos y calcula una simulación sin mutar datos',()=>{
  const raw={app:'evoluciones-ec',version:4,studies:[{id:'s1',nombre:'nuevo'},{id:'s2'}],patients:[],visits:[]};
  const normalized=release.validateBackup(raw);
  assert.equal(normalized.legacy,true);
  const current={studies:[{id:'s1',nombre:'anterior'}],patients:[],visits:[],docs:[],settings:[]};
  const plan=release.restorePlan(normalized.payload,current);
  assert.equal(plan.creates,1);
  assert.equal(plan.updates,1);
  assert.equal(current.studies[0].nombre,'anterior');
  assert.equal(release.canonicalStringify({b:2,a:1}),'{"a":1,"b":2}');
});

test('la aplicación declara entorno y versión visibles',()=>{
  assert.match(html,/runtime-config\.js/);
  assert.match(html,/id="versionBadge"/);
  assert.match(html,/id="environmentBanner"/);
  assert.match(html,/ZONDA_RUNTIME_CONFIG/);
  assert.match(runtime,/environment:\s*'unconfigured'/);
  assert.match(html,/function assertDeploymentWritable\(\)/);
  assert.match(html,/async upsert\(kind, obj, audit\)\{\s*assertDeploymentWritable\(\)/);
  assert.match(html,/async remove\(kind, id, audit\)\{\s*assertDeploymentWritable\(\)/);
});

test('la restauración exige validación, simulación y confirmación reforzada',()=>{
  assert.match(html,/ZondaRelease\.validateBackup/);
  assert.match(html,/ZondaRelease\.restorePlan/);
  assert.match(html,/Escribí IMPORTAR/);
  assert.match(html,/respaldo_pre_restauracion/);
  assert.doesNotMatch(html,/AUDIT = AUDIT\.concat\(data\.auditoria/);
});

test('la CSP ya no permite proveedores de IA desde el navegador',()=>{
  assert.doesNotMatch(headers+cloudflareHeaders,/api\.anthropic\.com/);
  assert.doesNotMatch(headers+cloudflareHeaders,/api\.openai\.com/);
  assert.doesNotMatch(headers+cloudflareHeaders,/generativelanguage\.googleapis\.com/);
  assert.match(headers,/connect-src 'self' https:\/\/\*\.supabase\.co https:\/\/cdnjs\.cloudflare\.com/);
  assert.match(cloudflareHeaders,/Content-Security-Policy:/);
});

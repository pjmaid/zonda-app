import fs from 'node:fs';
import process from 'node:process';

const expected=process.argv[2]||'test';
const version=fs.readFileSync(new URL('../VERSION',import.meta.url),'utf8').trim();
const runtime=fs.readFileSync(new URL('../runtime-config.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const headers=fs.readFileSync(new URL('../netlify.toml',import.meta.url),'utf8');
const cloudflareHeaders=fs.readFileSync(new URL('../_headers',import.meta.url),'utf8');
const errors=[];

if(!new RegExp("environment:\\s*['\"]"+expected+"['\"]").test(runtime)) errors.push('runtime-config.js no declara el entorno '+expected+'.');
if(!runtime.includes("appVersion: '"+version+"'")) errors.push('La versión del runtime no coincide con VERSION.');
if(/releaseId:\s*['"](?:local|REEMPLAZAR|)['"]/.test(runtime)) errors.push('Falta un releaseId inmutable.');
if(/service_role|sb_secret_|sk-[A-Za-z0-9_-]{20,}/i.test(runtime) || /sb_secret_|sk-[A-Za-z0-9_-]{20,}/i.test(html))
  errors.push('Se detectó un posible secreto en archivos públicos.');
if(/api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com/.test(headers+cloudflareHeaders)) errors.push('La CSP permite proveedores de IA directos.');
if(!html.includes('runtime-config.js') || !html.includes('release-tools.js')) errors.push('Faltan archivos de runtime requeridos por index.html.');

if(errors.length){
  console.error(errors.map(x=>'ERROR: '+x).join('\n'));
  process.exit(1);
}
console.log('Release '+version+' validado para '+expected+'.');

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');

const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const edge=fs.readFileSync(path.join(__dirname,'../supabase/functions/crear-usuario/index.ts'),'utf8');
const policy=html.slice(html.indexOf('const PASS_MIN ='),html.indexOf('function saveLocalDB('));
const server=edge.slice(edge.indexOf('function validTemporaryPassword('),edge.indexOf('function invitationPath('));
const context=vm.createContext({});
vm.runInContext(policy+stripTypeScriptTypes(server)+'\nthis.client=passCheck;this.server=validTemporaryPassword;',context);

const cases=[
  ['exactamente diez caracteres con los cuatro grupos','RíoT7!vexa',true],
  ['más de diez caracteres','RíoT7!vexaZ',true],
  ['nueve caracteres','RioT7!vex',false],
  ['sin mayúscula','riot7!vexa',false],
  ['sin minúscula','RIOT7!VEXA',false],
  ['sin número','RioTa!vexa',false],
  ['sin símbolo; la tilde no es un símbolo','RíoT7vexas',false],
  ['un espacio no reemplaza al símbolo','RioT7 vexa',false],
  ['nueve caracteres Unicode no equivalen a diez','ÁrT7!😀abc',false],
  ['mantiene el rechazo de palabras obvias','ClaveT7!xy',false],
];
for(const [description,password,accepted] of cases){
  test('cliente y servidor: '+description,()=>{
    assert.equal(context.client(password).ok,accepted);
    if(accepted) assert.equal(context.server(password),password);
    else assert.throws(()=>context.server(password),/PASSWORD_WEAK/);
  });
}

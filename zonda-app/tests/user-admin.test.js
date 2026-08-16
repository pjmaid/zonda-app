const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const fn = fs.readFileSync(path.join(root, 'supabase/functions/crear-usuario/index.ts'), 'utf8');

test('Configuración ya no muestra ni inicializa la plantilla general de consentimiento', () => {
  assert.doesNotMatch(html, /id="cfgCiIni"|id="cfgCiRe"|id="btnSaveCi"|id="btnResetCi"/);
  assert.doesNotMatch(html, /Plantilla del proceso de consentimiento/);
  assert.match(html, /plantilla predeterminada de Zonda/);
});

test('Configuración no expone el esquema SQL inicial', () => {
  assert.doesNotMatch(html, /Esquema SQL inicial|sqlBox|btnCopySql|SQL_SCRIPT|Copiar esquema inicial/);
});

test('el administrador puede crear, cambiar clave y eliminar cuentas mediante la función segura', () => {
  assert.match(html, /administrarUsuario\('cambiar_clave'/);
  assert.match(html, /administrarUsuario\('eliminar_usuario'/);
  assert.match(fn, /action === "usuario"/);
  assert.match(fn, /action === "cambiar_clave"/);
  assert.match(fn, /action === "eliminar_usuario"/);
  assert.match(fn, /\/auth\/v1\/admin\/users\/\$\{target\.user_id\}/);
});

test('las operaciones privilegiadas validan rol, sitio y protecciones administrativas', () => {
  assert.match(fn, /member\.rol !== "admin" && !member\.superadmin/);
  assert.match(fn, /target\.org_id !== ctx\.member\.org_id/);
  assert.match(fn, /target\.user_id === ctx\.user\.id/);
  assert.match(fn, /admins\.length <= 1/);
  assert.match(fn, /Clave temporal asignada; contenido no registrado/);
  assert.doesNotMatch(fn, /detalle:\s*password|motivo:\s*password/);
});

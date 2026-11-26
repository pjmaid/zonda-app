# Revisión de permisos y restauración — 23 de noviembre de 2026

Seguimiento del 26/11: los pendientes enumerados aquí ya tienen correcciones y
validación local en [CIERRE_PENDIENTES_20261123.md](CIERRE_PENDIENTES_20261123.md).
Su publicación sigue bloqueada por la conexión SQL administrativa; este informe
conserva la evidencia y el estado histórico del 23/11.

Estado: la migración `20261123_storage_roles_identidad.sql` está
**validada con PostgreSQL WASM y con Auth/Storage reales en un entorno local
separado, y aplicada en producción como `20261123233445_storage_roles_identidad`**.
La migración de endurecimiento
`20261113_endurecimiento_funciones_rls.sql` se aplicó el 23 de noviembre de 2026.
No se borraron filas ni archivos productivos. Las pruebas crearon y limpiaron
exclusivamente datos sintéticos locales.

## Hallazgos y alcance

| Hallazgo | Evidencia | Tratamiento |
| --- | --- | --- |
| El acceso de lectura también permitía borrar archivos; por ejemplo, una coordinadora podía borrar documentos clínicos | `ec_docs_protocol` era `FOR ALL` y usaba el mismo `ec_can_storage_object(name)` para todas las operaciones. El defecto se reprodujo mediante Storage real en test. | Corregido en producción: cuatro políticas por operación, verificadas tras 14 comprobaciones de integración real. |
| Una cuenta podía heredar permisos de una ficha vinculada a otro Auth ID si compartía el email | `ec_user_study_ids`, `ec_is_own_user` y `ec_can_facturacion` usaban un `OR email` sin comprobar que `authId` estuviera vacío. | Corregido en producción: email limitado a fichas históricas sin vínculo y rechazo de emails vacíos. Las Edge Functions ya incluyen el control correspondiente. |
| Restauración accidental entre sitios | El manifiesto contiene `orgId`, pero antes no se comparaba con el sitio de destino. | `validateRestoreOrganization` bloquea destinos distintos o sin membresía; las copias antiguas sin sitio requieren una advertencia visible. Pruebas unitarias ejecutadas. |
| Es posible omitir la auditoría transaccional mediante DML directo | `ec_save_record` y `ec_remove_record` son `SECURITY INVOKER`; `authenticated` tiene DML sobre `ec_*` y no hay triggers en pacientes, registros ni documentos. La RLS limita el alcance, pero no obliga a usar la RPC. | Pendiente: diseñar una vía única de escritura con control de permisos y auditoría en servidor. No se revoca DML todavía porque rompería las RPC actuales. |
| Dos bajas simultáneas pueden dejar un sitio sin administrador | La Edge Function consulta cuántos administradores quedan antes de borrar. `ec_members_guard` no serializa bajas ni protege el último administrador. | Pendiente: operación transaccional con bloqueo por organización. Debe cubrir `UPDATE activo/rol`, `DELETE` y cascada desde Auth, incluidos cambios administrativos. |
| Un administrador común puede desactivar a un superadministrador del mismo sitio por REST | `mem_upd` permite al administrador actualizar miembros de su sitio; `ec_members_guard` protege el cambio del campo `superadmin` y la organización, pero no `activo` ni `rol` de un miembro que ya sea superadministrador. | Pendiente: proteger la fila del superadministrador en RLS/trigger para todas las mutaciones. La validación de la Edge Function no protege el acceso REST directo. |
| Exceso de privilegios de tablas | Los metadatos muestran grants amplios para `anon` y `authenticated`, incluido `TRUNCATE`. RLS no protege una operación SQL `TRUNCATE`, aunque PostgREST no ofrece una ruta directa para ella. | Pendiente: inventariar privilegios mínimos y revocar los no utilizados en una migración probada. No equivale a demostrar borrado anónimo mediante REST. |
| Una subida aún sin ficha tiene permisos menos específicos | El archivo se sube antes de guardar `ec_docs`; el fallback autoriza por protocolo porque todavía desconoce si es financiero. | Pendiente: staging privado o registro previo de metadatos con compensación. Separar roles en Storage no elimina esa ventana de lectura. |

La excepción de borrado de cargas fallidas se limita a la coordinadora que creó
el objeto (`owner_id`), al protocolo autorizado y a la ausencia de referencias
en `ec_docs`. No permite borrar sus documentos clínicos ya publicados. Los
administradores y médicos mantienen el borrado dentro de su alcance; las
coordinadoras con permiso financiero mantienen el borrado de contratos.

## Validación local ejecutada

Se instaló `@electric-sql/pglite@0.6.0` en `/tmp`, con `--ignore-scripts`, y se
ejecutaron **15 comprobaciones aprobadas** en una base PostgreSQL WASM descartable.
El script carga las definiciones reales de las funciones de acceso, la política
anterior y la nueva migración. Crea tablas mínimas y sustituye solamente el
contexto Auth/membresía por parámetros de sesión y datos sintéticos. Ejercita
RLS como `authenticated` o `anon`, sin privilegios de propietario de tabla.

```bash
npm install --prefix /tmp/zonda-sql-validation --no-audit --no-fund --ignore-scripts @electric-sql/pglite@0.6.0
ZONDA_PGLITE_MODULE=/tmp/zonda-sql-validation/node_modules/@electric-sql/pglite/dist/index.js node tests/database-policy-runtime.mjs
```

Esto valida sintaxis PostgreSQL y comportamiento de las políticas. No prueba
la API Storage, los JWT reales, las funciones de membresía productivas ni
interacciones con otras políticas instaladas. El rol sintético `lector` comprueba
que un rol sin escritura no la obtiene por tener acceso al protocolo; no afirma
que ese rol esté habilitado actualmente en la interfaz de Zonda.

## Integración real ejecutada

Se levantó un entorno separado de servicios oficiales accesible solo por
loopback: PostgreSQL 17.12, Auth 2.198.0, Storage 1.98.6 y PostgREST 16.6. Se
reconstruyó el esquema desde metadatos, sin copiar filas ni archivos productivos.
Antes de crear fixtures se compararon **11 tablas, 14 funciones y 43 políticas**,
además de triggers, secuencias, grants y privilegios por defecto: sin diferencias
en los objetos de seguridad de Zonda. Los helpers Auth oficiales también
coincidieron con las definiciones capturadas. La ausencia de `supabase_vault` en
el runtime local se declaró como diferencia de plataforma; no se usó en la prueba.

La ejecución anterior al parche reprodujo la baja indebida del archivo clínico
por una coordinadora. Después de aplicar la migración **solo en el entorno local**,
se aprobaron **14 de 14 comprobaciones** con cuentas Auth, sesiones y archivos
reales, todos sintéticos. Ambas ejecuciones verificaron al terminar que las once
tablas de Zonda, los usuarios Auth y Storage quedaran vacíos. La reversión local
volvió a producir el catálogo de esquema inicial sin diferencias.

Evidencia: [runtime](../tests/results/20261123/runtime-report.json),
[comparación del esquema](../tests/results/20261123/schema-comparison.json),
[defecto anterior](../tests/results/20261123/integration-baseline.json),
[resultado corregido](../tests/results/20261123/integration-patched.json) y
[reversión local](../tests/results/20261123/rollback-comparison.json).

| Caso de integración real | Resultado con la migración |
| --- | --- |
| Auth y consulta de la membresía del usuario | Sesión y membresía correctas |
| Coordinadora con documento clínico publicado | Lee y actualiza; la baja está denegada y el archivo permanece intacto |
| Compensación de subidas sin ficha | Puede borrar su carga propia; no la ajena |
| Contrato publicado | Lectura y baja requieren permiso financiero |
| Cuenta de otro sitio | Lectura, sobrescritura y baja denegadas |
| Médico fuera del protocolo y administrador del sitio | Médico denegado; administrador autorizado |
| Acceso anónimo | Lectura, sobrescritura y baja denegadas |
| Email reciclado de una ficha ya vinculada | No hereda estudios ni facturación ajenos |
| Auth ID vinculado con email histórico diferente | Conserva su asignación por Auth ID |
| Perfil histórico sin Auth ID | Conserva su asignación por email |
| Médico con rutas actuales e históricas autorizadas | Lectura y baja permitidas |
| Coordinadora sin protocolos asignados | Lectura denegada |
| Membresía recién desactivada, con token anterior | Lectura, subida, sobrescritura y baja denegadas |
| Cuenta Auth sin membresía | Lectura, subida y baja denegadas |

El esquema real admite solamente `admin`, `medico` y `coord`: no se creó un rol
`lector` ni se cambió esa restricción. El caso de emails vacíos se comprobó en
PGlite, no mediante una cuenta Auth real. Las pruebas no validan SMTP, la interfaz
completa de Zonda, el acceso personal de Pablo ni una restauración de datos
clínicos. El hash del archivo SQL original probado y aplicado se conserva en
`VALIDACION_SUPABASE_20261123.md`. Después solo se actualizó su cabecera para
reflejar la validación y aplicación; las instrucciones SQL no cambiaron.

## Respaldo

El JSON de Zonda es un respaldo de los registros visibles para la sesión; no
incluye los binarios ni toda la base de datos. La reversión del esquema sintético
no constituye una restauración de un backup de datos clínicos ni una
reconciliación de sus binarios de Storage. El cambio aplicado solo modifica
permisos y funciones; su reversión se comprobó y los recuentos productivos
permanecieron iguales. La verificación del backup administrado y de la
recuperación conjunta de archivos y metadatos sigue pendiente antes de realizar
migraciones de datos o restauraciones productivas.

## Fuente técnica

Se consultó la documentación oficial de [propiedad en Supabase Storage](https://supabase.com/docs/guides/storage/security/ownership):
`owner_id` es el campo vigente, se obtiene del JWT al crear el objeto y por sí solo
no concede permisos. El campo antiguo `owner` está obsoleto. La revisión del
esquema del proyecto confirmó que `owner_id` es `text`.

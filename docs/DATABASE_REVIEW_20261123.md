# Revisión de permisos y restauración — 23 de noviembre de 2026

Estado: la migración `20261123_storage_roles_identidad.sql` está preparada y
**validada en PostgreSQL WASM local con fixtures sintéticos, no aplicada en Supabase**.
La migración de endurecimiento
`20261113_endurecimiento_funciones_rls.sql` se aplicó el 23 de noviembre de 2026.
No se borraron filas ni objetos de Storage durante esta revisión.

## Hallazgos y alcance

| Hallazgo | Evidencia | Tratamiento |
| --- | --- | --- |
| El acceso de lectura también permite borrar archivos; por ejemplo, una coordinadora puede borrar documentos clínicos | `ec_docs_protocol` es `FOR ALL` y usa el mismo `ec_can_storage_object(name)` para todas las operaciones. La política se confirmó en los metadatos del proyecto. | La migración preparada separa lectura, inserción, actualización y borrado por rol. Pasó la validación local; falta integración y aplicación en Supabase. |
| Una cuenta puede heredar permisos de una ficha vinculada a otro Auth ID si comparte el email | `ec_user_study_ids`, `ec_is_own_user` y `ec_can_facturacion` usan un `OR email` sin comprobar que `authId` esté vacío. | La migración limita el email a fichas históricas sin vínculo y rechaza emails vacíos. Las Edge Functions se corrigen por separado. |
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

## Verificación integrada requerida antes de aplicar SQL

Crear un proyecto de prueba con el mismo esquema, políticas y funciones actuales.
Usar cuentas y archivos sintéticos. El repositorio no contiene el esquema inicial
completo de membresías/Auth. La prueba local usa sustitutos para esas funciones,
por lo que no reemplaza esta verificación mediante la API y el cliente reales.

| Cuenta / estado | Acción | Resultado esperado |
| --- | --- | --- |
| Lector asignado | Leer archivo clínico de su protocolo | Permitido |
| Lector asignado | Insertar, sobrescribir o borrar ese archivo vía Storage API | Denegado; archivo original intacto |
| Médico asignado | Subir, sobrescribir y borrar archivo clínico | Permitido y limitado a su protocolo |
| Médico no asignado | Leer o modificar archivo de otro protocolo | Denegado |
| Coordinadora asignada | Subir y actualizar archivo clínico | Permitido |
| Coordinadora asignada | Borrar archivo clínico que ya tiene ficha, aunque sea la creadora | Denegado |
| Coordinadora, carga propia sin ficha | Borrar el objeto para compensar el fallo de guardado | Permitido |
| Coordinadora, carga ajena sin ficha | Borrar el objeto | Denegado |
| Coordinadora con facturación | Leer y borrar contrato con ruta coincidente en `ec_docs` | Permitido |
| Coordinadora sin facturación | Leer o modificar contrato publicado | Denegado |
| Cuenta de otro sitio o sesión anónima | Cualquier acceso a objetos privados | Denegado |
| Ficha vinculada a Auth A, email coincide con cuenta B | B obtiene estudios o facturación desde esa ficha | Denegado |
| Ficha vinculada a Auth A, email de A cambió | A mantiene los permisos de su ficha | Permitido por `authId` |
| Ficha histórica sin `authId`, email válido coincidente | Obtener los permisos históricos | Permitido |
| Ficha y JWT con email vacío | Obtener permisos por coincidencia vacía | Denegado |
| Ruta histórica `org/doc/archivo` | Leer y borrar según rol y ficha | Mismas restricciones por rol |
| Falla del guardado tras subir un archivo | Ejecutar compensación desde Zonda | Sin mensaje de éxito y sin borrar archivos ajenos |

Comprobar además que no exista otra política permisiva de Storage que vuelva a
habilitar las operaciones bloqueadas. Probar el cliente con una sesión por rol,
incluida la restauración de archivos durante una compensación. Conservar una
copia de las definiciones de las funciones y políticas previas para la reversión.

## Respaldo

El JSON de Zonda es un respaldo de los registros visibles para la sesión; no
incluye los binarios ni toda la base de datos. No se verificó una restauración de
PostgreSQL ni una reconciliación de Storage en un proyecto desechable. Antes de
migrar producción hay que registrar el backup administrado y comprobar que los
archivos y sus metadatos puedan recuperarse juntos.

## Fuente técnica

Se consultó la documentación oficial de [propiedad en Supabase Storage](https://supabase.com/docs/guides/storage/security/ownership):
`owner_id` es el campo vigente, se obtiene del JWT al crear el objeto y por sí solo
no concede permisos. El campo antiguo `owner` está obsoleto. La revisión del
esquema del proyecto confirmó que `owner_id` es `text`.

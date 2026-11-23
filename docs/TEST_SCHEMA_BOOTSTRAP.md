# Preparación de Supabase de prueba sin datos productivos

Este procedimiento prepara la validación integrada de
`20261123_storage_roles_identidad.sql`. No crea recursos, no aplica migraciones
y no representa una autorización de costos. La creación y administración del
entorno corresponden al responsable del despliegue.

## Por qué no basta con ejecutar las migraciones del repositorio

La historia versionada comienza con `ALTER TABLE`, no con un esquema vacío.
Una revisión del árbol actual y de la historia Git de los archivos SQL encontró:

| Elemento | Estado en el repositorio |
| --- | --- |
| `ec_orgs`, `ec_members`, `ec_studies`, `ec_patients`, `ec_visits`, `ec_docs`, `ec_users`, `ec_audit` | No están sus definiciones iniciales completas de tablas, restricciones, índices, secuencias y permisos. |
| `current_org`, `current_rol`, `es_superadmin`, `ec_members_guard` | Las migraciones presuponen que existen; sus definiciones se conservaron en el snapshot de reversión, no en una migración inicial reproducible. |
| Trigger de `ec_members_guard` | Falta su creación y vinculación exacta a la tabla/eventos en la historia de migraciones. |
| Auditoría y miembros | Faltan políticas y grants de base que deben inventariarse del esquema real. No alcanza con copiar solo las políticas modificadas recientemente. |
| `ec_records`, `ec_checklists`, `ec_settings` | Sí tienen `CREATE TABLE`, pero dependen de las tablas/funciones iniciales faltantes. |
| Dos archivos `20260810_*` | Comparten versión numérica. El orden alfabético pone `configuracion_permisos_por_protocolo` antes de `registros_checklists_compartidos`, aunque el primero necesita `ec_records`. No asumir que una ejecución automática desde cero reproduce el orden manual del README. |
| Bucket `ec-docs` | El bucket es una fila de configuración de Storage; no aparece en un volcado de esquema. Debe crearse vacío y privado en el destino. |
| `supabase/rollback/20261123_schema_before_review.json` | Contiene 12 funciones y 7 políticas seleccionadas. No es un volcado completo ni incluye tablas, triggers, grants o configuración de Auth/Storage. Además captura el estado anterior al endurecimiento aplicado el 23/11. |

No renombrar las versiones históricas ya aplicadas ni ejecutar `migration repair`
en producción para resolver esto durante una prueba. La reproducción debe partir
de una línea de base del **esquema actual**, obtenida y revisada por separado.

## Elegir y comprobar el destino

Una preview branch de Supabase usa credenciales propias y, según la documentación,
no copia datos productivos. Puede ejecutar migraciones y un seed del repositorio:
el historial incompleto anterior sigue siendo un bloqueo y hay que revisar los
logs de aprovisionamiento. No activar sincronización automática ni merge a
producción para esta validación.

Un proyecto de prueba independiente también sirve. Antes de cualquier escritura:

1. Registrar el ID, URL y tipo del recurso de prueba. Deben ser distintos de
   producción (`aqinxboxjklsyvesdcyr`). El nombre visible del recurso no basta.
2. Verificar en la respuesta de la plataforma qué proyecto/branch creó esas
   credenciales; no reutilizar claves productivas, aunque sean publishable.
3. Confirmar que no existe un seed con datos reales ni tareas que llamen servicios
   productivos: webhooks, cron, Edge Functions, SMTP externo o proveedores de IA.
4. Confirmar que `auth.users`, las tablas de negocio y `storage.objects` estén
   vacías antes de crear fixtures. Consultar cantidades, no descargar filas.
   Si aparecen registros no explicados por el aprovisionamiento, detener la prueba.
5. Mantener las claves de administración solo en variables de entorno del proceso
   de pruebas. No registrarlas en Git, stdout, reportes ni configuración web.

La prueba de políticas no requiere desplegar IA ni `rag`, copiar secretos de
proveedores o importar documentos clínicos. Las cuentas sintéticas se crean
mediante Auth Admin con email confirmado; no es necesario enviar invitaciones.

## Obtener la línea de base sin datos

El origen solo se usa para lecturas de catálogo. El artefacto de entrada debe ser
schema-only: sin `INSERT`, `COPY`, `setval`, cuentas Auth, sesiones, usuarios
productivos, filas `storage.objects` ni archivos.

### Ruta A: volcado de `public` y metadatos seleccionados

Si se dispone del cliente PostgreSQL y de una conexión autorizada de lectura,
`pg_dump --schema-only --schema=public --no-owner` captura DDL sin filas. Conservar
ACL/grants para poder comparar permisos: no usar `--no-acl` a ciegas. Por ejemplo,
con un servicio libpq configurado fuera del repositorio:

```bash
pg_dump --dbname=service=zonda_schema_source --schema-only --schema=public --no-owner --file=/tmp/zonda-public-schema.sql
```

Alternativamente, `supabase db dump --schema public` produce por defecto un
volcado sin datos ni roles personalizados. El CLI utiliza un contenedor y excluye
los esquemas gestionados de Supabase, entre ellos `auth` y `storage`; comprobar
la versión y disponibilidad de ese runtime antes de elegir esta ruta. Evitar
dejar el directorio de pruebas vinculado a producción para comandos posteriores.

Revisar el SQL antes de guardarlo como línea de base: extensiones y objetos
ajenos a Zonda pueden requerir tratamiento separado. Una función, un default o
un webhook puede contener destinos externos o incluso un secreto literal aunque
el dump no tenga datos. No publicar el volcado crudo sin esa inspección.

### Ruta B: reconstrucción desde catálogo con API de administración

Si no hay una conexión para `pg_dump`, las consultas de catálogo son una
alternativa de solo lectura. Exportar exclusivamente los objetos enumerados,
sin consultar el contenido de las tablas de negocio:

| Catálogo / función PostgreSQL | Información que conservar |
| --- | --- |
| `pg_class`, `pg_namespace`, `pg_attribute`, `pg_attrdef`, `format_type`, `pg_get_expr` | Tablas `public.ec_*`, tipos, orden de columnas, nullability, defaults, columnas generadas e identidad, RLS y FORCE RLS. |
| `pg_constraint`, `pg_get_constraintdef` | PK, FK, UNIQUE y CHECK, incluidos roles válidos y cascadas hacia/desde `auth.users`. |
| `pg_index`, `pg_get_indexdef`, secuencias asociadas | Índices y secuencias necesarias, sin valores de secuencia productivos. |
| `pg_proc`, `pg_get_functiondef`, `proacl` | Funciones `ec_*`, `current_org`, `current_rol`, `es_superadmin`; firma, owner esperado, SECURITY DEFINER/INVOKER, `search_path` y grants EXECUTE. |
| `pg_trigger`, `pg_get_triggerdef` | Triggers no internos de las tablas de Zonda y cualquier trigger personalizado sobre `auth.users`. |
| `pg_policies` | Todas las políticas de `public.ec_*` y políticas personalizadas de `storage.objects`/`storage.buckets` que afectan `ec-docs`, con operación, rol, permisiva/restrictiva, USING y WITH CHECK. |
| `information_schema.role_table_grants`, `pg_default_acl`, ACL de esquemas/secuencias | Permisos explícitos y por defecto para `anon`, `authenticated` y `service_role`; no reemplazarlos por grants amplios para hacer pasar pruebas. |
| Metadatos del bucket | Solo nombre, privacidad, límite de tamaño y MIME permitidos; no sus objetos. |

Esta ruta necesita ordenar dependencias y revisar el DDL reconstruido; una lista
de columnas o las 12 funciones del snapshot no es suficiente. Registrar qué
objetos fueron omitidos y detener el bootstrap si no puede explicarse una
dependencia. No reemplazar membresías reales por stubs, como en PGlite: esta
prueba debe ejercer `auth.uid()` y las funciones originales con JWT auténticos.

## Qué copiar al destino y qué conservar gestionado

El destino recién aprovisionado ya contiene Auth y Storage. **No restaurar esos
esquemas completos**, ni roles de infraestructura, ni migraciones internas de
Supabase desde el origen.

1. Aplicar solo el DDL revisado de Zonda en `public`. Configurar extensiones
   requeridas usando los mecanismos del destino.
2. Aplicar únicamente triggers/policies personalizados necesarios sobre los
   esquemas gestionados, comprobando que referencien funciones de Zonda y que
   existan sus columnas en la versión de Storage del destino (`owner_id text`).
3. Crear `ec-docs` vacío y privado con la API de Storage. No insertar metadatos
   de archivos directamente en `storage.objects` ni copiar objetos productivos.
4. Comprobar grants efectivos después del restore. Los privilegios por defecto
   del proyecto nuevo pueden otorgar más permisos que el dump. La documentación
   oficial recomienda revocar defaults de `anon`/`authenticated` antes del restore
   cuando sea necesario para preservar los grants; esa modificación se limita
   al proyecto de prueba y debe documentarse junto con los grants explícitos.
5. Comparar un inventario canónico del destino con el origen antes de aplicar el
   parche: definiciones de funciones, políticas, triggers, restricciones y grants.
   Ignorar únicamente propietarios/elementos gestionados que deban variar y
   registrar esas diferencias. No ocultar un cambio de permisos inesperado.

La línea de base corresponde al estado actual del esquema; no volver a ejecutar
encima todas las migraciones antiguas. Aplicar después **solo** la migración
pendiente `20261123_storage_roles_identidad.sql`, con la herramienta de migración
del destino y un identificador registrado. El endurecimiento del 13/11 ya forma
parte del esquema productivo actual según la revisión del 23/11.

## Criterio para iniciar el harness de integración

### Herramientas reproducibles agregadas el 23/11

`tests/fixtures/schema-baseline-20261123.json` conserva el inventario revisado de
11 tablas, 14 funciones y 43 políticas, junto con índices, triggers, secuencia
y ACL. Se obtuvo exclusivamente del catálogo y de la configuración del bucket;
no contiene filas de negocio, cuentas, archivos ni credenciales.
`scripts/schema-catalog.sql` permite volver a capturar esos metadatos como lectura.

El generador produce SQL y no abre conexiones:

```bash
node scripts/render-test-schema.mjs --output /tmp/zonda-test-schema.sql
```

El SQL requiere PostgreSQL 17 o superior, los esquemas gestionados reales de
Supabase y una base local sin objetos de Zonda. Antes de ejecutarlo, la misma
conexión local debe declarar `SET zonda.test_bootstrap='synthetic-only'`. Esta
guarda no detecta el destino de red: el ejecutor debe restringirlo a la instancia
de prueba. Conserva las ACL capturadas y aborta ante objetos previos o defaults
globales inesperados. No se debe usar como una migración de producción.

`tests/schema-bootstrap-runtime.mjs` comprueba el generador con PGlite y stubs
gestionados, incluyendo rollback ante errores, catálogo, ACL y resolución de
`gen_random_uuid` al built-in de PostgreSQL. Esta prueba no acredita Auth/Storage
real. El harness y las instrucciones de integración están en
`scripts/verify-supabase-integration.mjs` y `TEST_INTEGRATION.md`.

### Ficha de ejecución

Guardar una ficha de ejecución sin secretos: commit de Zonda, versión de la
migración/checksum, ID del proyecto de prueba, fecha, estado vacío inicial,
inventario previo y cambios esperados. El harness de Auth/Storage debe apuntar
solo a ese ID y crear datos identificables como sintéticos y propios de la
ejecución. Las filas de membresía y perfiles tienen que corresponder a los IDs
devueltos por Auth Admin.

Probar a través de REST y Storage con tokens de usuario reales; reservar la
clave de administración para crear fixtures, verificar cantidades y limpiar
solo lo creado por el harness. Comparar el contenido del archivo tras una
denegación de escritura, no solo el código HTTP. La autorización de Storage
puede devolver una lista vacía para una baja denegada.

No declarar validada producción por este resultado. La evidencia de integración
sirve para revisar y decidir la aplicación de la migración pendiente; no autoriza
por sí sola un merge, cambio de configuración o modificación productiva.

## Fuentes oficiales consultadas

- [CLI: `supabase db dump`](https://supabase.com/docs/reference/cli/supabase-db-dump): dump sin datos por defecto, esquemas gestionados excluidos y cuidado con grants por defecto al restaurar.
- [Database migrations](https://supabase.com/docs/guides/local-development/database-migrations): dependencias, captura del esquema existente, políticas Auth/Storage y buckets como datos de configuración.
- [Branching con GitHub](https://supabase.com/docs/guides/deployment/branching/github-integration): credenciales/seed por rama, ausencia de copia de datos productivos y despliegues automáticos configurables.
- [Branching: troubleshooting](https://supabase.com/docs/guides/deployment/branching/troubleshooting): dependencias, timestamps únicos y logs de despliegue.

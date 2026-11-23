# Validación integrada de permisos — 23/11/2026

**Resultado: 14/14 escenarios de Auth y Storage aprobados en una instancia local
aislada, con servicios reales y datos exclusivamente sintéticos.** Se reprodujo
el defecto anterior y se verificó que la reversión restaura el catálogo inicial.
La aplicación en producción se registra por separado al final de este informe.

## Entorno y costo

La organización gratuita no admitió una rama (requiere Pro) ni un tercer proyecto
activo. No se creó ningún recurso cloud, no se contrató un plan y no se generaron
cargos. Se prepararon procesos nativos locales, limitados a `127.0.0.1`:

| Componente | Versión |
| --- | --- |
| PostgreSQL | 17.12 |
| Supabase Auth | 2.198.0 |
| Supabase Storage | 1.98.6 |
| PostgREST | 16.6 |
| Node.js | 24.22.3 |

Auth y Storage aplicaron sus migraciones oficiales. Las funciones gestionadas
`auth.uid`, `auth.jwt`, `auth.email` y `auth.role` coincidieron con las de
producción. Se usó una puerta de enlace local que valida la clave del entorno y
transmite el JWT al servicio correspondiente; no sustituye la validación de Auth
ni la autorización PostgreSQL. Solo se recompiló el módulo nativo `fs-xattr` de
Storage para glibc, desde su código original; su JavaScript y SQL no se cambiaron.

La extensión gestionada `supabase_vault` no se instaló localmente. Ninguna función
de aplicación probada depende de ella. Las demás extensiones inventariadas y sus
versiones coincidieron; el detalle está declarado en los reportes.

## Secuencia y resultados

1. Se reconstruyó exclusivamente el esquema de Zonda a partir de metadatos:
   **11 tablas, 14 funciones y 43 políticas**, con restricciones, triggers,
   índices, defaults y ACL. El inventario previo coincidió con el origen.
2. Con los permisos anteriores, una coordinadora pudo borrar un archivo clínico
   publicado. El harness falló exactamente por ese defecto; luego verificó la
   limpieza completa de los fixtures.
3. Se aplicó `20261123_storage_roles_identidad.sql` solo a la base local. Los
   **14 escenarios aprobaron**, usando inicios de sesión reales y JWT emitidos
   por Auth, solicitudes REST y operaciones de Storage sobre binarios sintéticos.
4. Los **16 pasos de limpieza aprobaron**, incluida la comprobación final de las
   once tablas de negocio, Auth y Storage vacíos.
5. Se ejecutó `20261123_storage_roles_identidad_down.sql` solo localmente. Las
   funciones, políticas, ACL y el resto del catálogo volvieron a coincidir con
   la línea de base. Los servicios se apagaron al finalizar.

Los casos incluyen coordinación, administración, medicina, protocolos asignados,
aislamiento entre sitios, contratos con permiso financiero, cuentas inactivas o
sin membresía, identidad por Auth ID y perfiles históricos por email. Se comprobó
que las escrituras y bajas denegadas conservan el contenido del archivo.

Verificación complementaria: **223 pruebas Node aprobadas** y **18 comprobaciones
del generador de esquema en PGlite aprobadas**. Estas últimas usan stubs de los
esquemas gestionados y no se confunden con los 14 escenarios reales.

## Evidencia y reproducción

Los reportes sin credenciales están en `tests/results/20261123/`:

- `runtime-report.json`: secuencia completa y cierre de servicios.
- `schema-comparison.json`: igualdad previa del esquema de aplicación.
- `auth-helpers-comparison.json`: funciones de identidad gestionadas.
- `integration-baseline.json`: reproducción del fallo y limpieza.
- `integration-patched.json`: 14 escenarios y limpieza aprobados.
- `rollback-comparison.json`: igualdad tras revertir.
- `runtime-provenance.json`: fuentes y hashes de los componentes.

El cliente examinado corresponde al commit
`b2587e7761dff679c73575c7d2e344522d044646` (Zonda 0.9.5).
SHA-256 del archivo SQL validado:
`620d274248bbe3dff1d657682fc924892509d0d43c497473a6a0ed420cf2fc66`.
SHA-256 de la reversión validada:
`9e5047306310aa94ac821474176f71eac39e20308ed6afc39eed6d2a903b20f5`.
La ejecución completa finalizó a las 20:23 de Argentina.

`TEST_SCHEMA_BOOTSTRAP.md` y `TEST_INTEGRATION.md` explican cómo reconstruir el
entorno y ejecutar el mismo harness. No se copiaron cuentas, sesiones, documentos
ni filas clínicas productivas. Los identificadores de los reportes pertenecen
exclusivamente a los fixtures sintéticos eliminados.

## Límites y producción

Esta ejecución no comprueba SMTP, la interfaz web completa, Edge Functions ni la
contraseña o sesión personal de Pablo. No demuestra que su problema de acceso
personal esté resuelto. Tampoco valida una restauración de datos clínicos o el
conjunto de hallazgos estructurales pendientes de `DATABASE_REVIEW_20261123.md`.

**Aplicada en producción:** `20261123233445_storage_roles_identidad`, el 23/11/2026
a las 20:34 de Argentina. Antes de aplicar, el catálogo productivo seguía
coincidiendo con la línea de base validada. Después se verificó que:

- Las cuatro funciones tienen el mismo cuerpo SQL probado y mantienen los
  permisos requeridos por usuarios autenticados y el servicio.
- Storage tiene cuatro políticas, una por operación; ya no existe la política
  anterior `FOR ALL`.
- Ninguna función `SECURITY DEFINER` pública permite ejecución anónima.
- Las cantidades de pacientes, documentos, estudios, registros, archivos y
  cuentas Auth permanecen iguales.

La evidencia posterior está en `tests/results/20261123/production-verification.json`.
La página pública y la comprobación de salud de Auth respondieron HTTP 200;
la consulta anónima de documentos devolvió una lista vacía. Auth productivo
informó la misma versión 2.198.0 usada en la prueba local. Estas comprobaciones
no equivalen a iniciar sesión con la cuenta personal del usuario.
La cabecera del SQL se actualizó para reflejar este estado; sus instrucciones
ejecutables no se modificaron respecto del archivo validado y aplicado.

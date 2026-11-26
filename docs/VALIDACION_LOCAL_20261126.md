# Validación local integrada — 26 de noviembre de 2026

Resultado: **aprobado**, ejecución `8e12bbd4ca2195b4`. Esta evidencia valida la
versión completa preparada de Zonda en servicios locales con datos sintéticos;
no demuestra que las migraciones o esta versión estén publicadas en producción.

## Cobertura ejecutada

| Bloque | Resultado y observación |
| --- | --- |
| Recuperación e invitaciones | 17/17: Auth oficial, SMTP capturado en loopback y funciones reales del cliente. Se rechazan nueve caracteres y se aceptan exactamente diez con los cuatro tipos exigidos; luego el login real funciona. Se reutiliza una contraseña anterior y se confirma la actual mediante la respuesta real `422 same_password` y una segunda actualización de metadatos. |
| Permisos, auditoría y concurrencia | 28/28: REST, JWT, RPC, recibos de reintento, auditoría obligatoria, cuatro carreras de administración con espera de bloqueo observada, protección de superadministradores y documentos privados. |
| Administración de usuarios | 9/9: fuente real de la Edge Function ejecutada en Node contra Auth/PostgREST locales; duplicados pendientes de la misma organización y de otra conservan sus cuentas y membresías. La invitación ocurre después del alta persistida. Un fallo de envío no borra la cuenta. La clave temporal de diez caracteres permite iniciar sesión. La clave elegida por su titular queda personal (`clave_temporal=false`); una asignada a otra persona conserva el indicador temporal. |
| Respaldo/restauración | 8/8: `pg_dump`/`pg_restore`, descarga y recuperación de cuatro archivos, recuentos y hashes de todas las tablas, login de cinco cuentas restauradas y RLS del segundo servicio. |
| Esquema y reversión sin uso | El catálogo coincide con la captura del esquema de producción del 24/11. Aplicar y revertir las tres migraciones en la base vacía restaura ese catálogo sin diferencias. |
| Reversión con historial documental | La reversión rechaza 34 rutas históricas sintéticas que simulan el backfill de registros existentes. Conserva todas las filas y el esquema. |
| Reversión después de uso | La reversión de auditoría se rechaza y conserva exactamente la pista y el esquema. No se purga el historial para forzar el resultado. |
| Limpieza | Se retuvo la auditoría durante la limpieza de fixtures; al finalizar se eliminaron únicamente las bases locales generadas y se detuvieron los servicios de prueba. |

La comprobación negativa del respaldo se realizó con la base restaurada y un
directorio independiente de archivos inicialmente vacío: no podía leer los
binarios originales. Después de recuperarlos, las descargas del segundo servicio
coincidieron en bytes y SHA-256 con el respaldo. No se confundió una restauración
de metadatos con la recuperación de archivos.

## Reutilizar una clave y conservar la actual

La regresión de Auth cambia la clave original por otra, reutiliza la original
con diez caracteres válidos y comprueba el acceso real con ella. La clave
reemplazada deja de autenticar. No se impone un historial de contraseñas desde
la aplicación.

Cuando se vuelve a enviar la clave actual, Auth responde `422 same_password`
sin quitar el indicador temporal. El cliente real reconoce únicamente ese caso
y envía después `PUT /auth/v1/user` con `{"data":{"clave_temporal":false}}`,
sin el campo `password`. La prueba observa ambas respuestas, comprueba el ID
confirmado y el indicador devuelto por Auth, y vuelve a iniciar sesión con la
misma clave. La validación de diez caracteres y los cuatro tipos se ejecuta
antes de estas solicitudes.

## Identidad de las fuentes

El supervisor registró SHA-256 antes y después de ejecutar y comprobó que todos
sus archivos de entrada permanecieran idénticos. Incluye `index.html`, el código
real de `crear-usuario`, los scripts, el catálogo y las migraciones/reversiones.

| Archivo de migración | SHA-256 |
| --- | --- |
| `20261124002116_membresias_seguras.sql` | `e7467f58f4351e9ab5af82f7fd84615032d76243ff4f1a18a6480138dcb35efe` |
| `20261124002135_auditoria_permisos.sql` | `1ae72b2ed21777203e0b2d1455c825b2db82675e9dda43276c93735f5e63af06` |
| `20261124002147_documentos_privados.sql` | `03cb49a1e04b2bb980636cb2604ccd054d56812d4f42365b48bd6b90b6d4f45d` |

Los resultados sanitizados están en
[`tests/results/20261126`](../tests/results/20261126/). El manifiesto
[`evidence-manifest.json`](../tests/results/20261126/evidence-manifest.json)
identifica por hash cada reporte. No se incluyen claves, tokens, dumps Auth ni
archivos con datos clínicos.

## Reproducción

El entorno preparado utiliza PostgreSQL 17.12, Auth 2.198.0, Storage 1.98.6 y
PostgREST 16.6 oficiales, con servicios vinculados exclusivamente a `127.0.0.1`.
La procedencia y las diferencias de plataforma se conservan en
[`runtime-provenance.json`](../tests/results/20261126/runtime-provenance.json).
El supervisor necesita los binarios y la configuración privada sintética del
runtime; no acepta un proyecto alojado como destino. Los JWT de ese runtime
tienen vencimiento y deben renovarse localmente si caducan antes de un nuevo
ensayo. La renovación no modifica claves de producción.

Desde la raíz del repositorio, el comando sin autorización de ejecución solo
imprime el plan:

```bash
node scripts/verify-local-supabase-full.mjs
```

Para el runtime local ya preparado en este espacio de trabajo:

```bash
node scripts/verify-local-supabase-full.mjs --execute --runtime-dir /workspace/scratch/b91352d15e1d/local-supabase-native
```

Los servicios y las pruebas deben permanecer en el mismo proceso supervisor,
porque cada ejecución del entorno puede tener un espacio de red separado. El
supervisor crea nombres nuevos de base, verifica el destino local, arranca una
segunda pila para restaurar y limpia solamente sus bases generadas.

## Límites de interpretación

- El correo se captura localmente: no valida SMTP productivo, llegada al buzón
  real ni el acceso personal de Pablo.
- El handler de administración es el código real, pero corre en una VM de Node;
  no sustituye una comprobación del runtime Deno alojado.
- La política de la aplicación y de administración acepta diez caracteres. La
  configuración de longitud/composición de Supabase Auth gestionado requiere
  una comprobación separada; no se infiere del ensayo local.
- La reversión de documentos **no está disponible después del backfill de
  archivos existentes**, incluso antes de una nueva operación de usuario. En
  producción ya se identificaron 34 fichas: se necesita corrección hacia adelante
  preservando el registro permanente. El rollback exitoso de una base vacía no
  debe presentarse como recuperación disponible para ese caso productivo.
- Los roles ya existen en el mismo clúster local. `pg_dump` no respalda sus
  contraseñas globales. La prueba no determina tiempos de recuperación de un
  desastre alojado ni el estado del backup administrado de Supabase.
- `supabase_vault` no está instalado en el clúster nativo y la aplicación no lo
  usa en estas pruebas. No se copiaron filas ni archivos de producción.

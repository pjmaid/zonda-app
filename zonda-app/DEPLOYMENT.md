# Publicación y reversión segura

## Entornos

Usar proyectos de Supabase independientes para `test` y `production`. Nunca probar migraciones, restauraciones o políticas RLS nuevas sobre la base productiva.

Antes de cada despliegue, editar `runtime-config.js`:

- `environment`: `test` o `production`.
- `appVersion`: debe coincidir con `VERSION`.
- `releaseId`: SHA completo del commit que se despliega.
- `supaUrl` y `supaKey`: proyecto correspondiente al entorno. La anon key es pública; ninguna `service_role` puede estar en estos archivos.

## Secuencia de publicación

1. Crear una rama y un release candidato inmutable.
2. Ejecutar `node --test tests/*.test.js`.
3. Ejecutar `node scripts/verify-release.mjs test`.
4. Crear un backup administrado de Supabase y registrar su identificador.
5. Aplicar las migraciones pendientes en `test`, en el orden del README.
6. Desplegar `crear-usuario` e `ia`, y luego los archivos web en `test`.
7. Completar las pruebas manuales del README con dos usuarios y dos navegadores.
8. Probar una restauración en un proyecto desechable y reconciliar cantidades.
9. Aprobar el release y cambiar la configuración a `production`.
10. Repetir backup, migraciones, funciones y web. Registrar quién aprobó, commit, hora y resultado.

No publicar `index.html` antes de las migraciones: el cliente nuevo depende de las RPC y tablas nuevas.

## Reversión

Ante un error, primero detener nuevas escrituras poniendo el sitio en mantenimiento. Después:

1. Conservar logs, release afectado y hora del incidente.
2. Revertir los archivos web y Edge Functions al release anterior.
3. No deshacer una migración de datos con SQL improvisado.
4. Si la migración es compatible hacia atrás, mantenerla y validar el cliente anterior.
5. Si hubo corrupción, restaurar el backup en un proyecto separado, comparar y aprobar la recuperación antes de reemplazar producción.
6. Registrar el incidente y la reconciliación de filas por tabla.

El JSON exportado por Zonda es una copia operativa de los registros visibles y no reemplaza el backup administrado de PostgreSQL ni incluye los archivos binarios de Storage.

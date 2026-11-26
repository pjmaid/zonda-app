# Cierre de pendientes — Zonda 0.9.7 preparada

Trabajo iniciado el 23 y validado el 26 de noviembre de 2026 (Argentina).
Los identificadores de migración usan UTC y fueron generados con Supabase CLI
3.3.0. La versión 0.9.6.1 con la política y la reutilización de contraseñas está publicada. Este paquete
0.9.7 está preparado y validado localmente, pero **no aplicado en producción**:
la conexión SQL administrativa devuelve `28P01` al autenticar a `postgres`.
No es un rechazo de la contraseña personal del usuario de Zonda.

## Cambios

- Las ocho colecciones de negocio se escriben mediante RPC con RLS y auditoría
  transaccional. Las escrituras de servicio, membresías y organizaciones también
  generan eventos obligatorios. Los recibos de reintentos quedan en un esquema
  privado y se vinculan al actor y al contenido exacto de la solicitud.
- La pista distingue cambios de base de datos, declaraciones del cliente y
  eventos de servicio. El servidor deriva identidad, rol y fecha. Las cuentas
  cliente no pueden insertar, modificar, borrar ni truncar la pista directamente.
  El historial conserva el UUID de la organización tras su eliminación.
- Se quitan privilegios de tabla innecesarios. Las cuentas sin sesión no reciben
  acceso directo a las colecciones. La prueba de conexión consulta Auth y deja
  la comprobación de datos para después del inicio de sesión.
- Un bloqueo transaccional serializa las modificaciones de membresías y protege
  el último administrador, incluidas las cascadas desde Auth. La garantía se
  aplica en READ COMMITTED/READ UNCOMMITTED; otros aislamientos se rechazan.
  Las filas de superadministradores se protegen frente a administradores comunes.
- La desactivación del sitio revoca permisos aun con un token anterior. La baja
  definitiva de cuentas Auth queda reservada al superadministrador. Un
  administrador común puede desactivar accesos y solicitar recuperación por
  correo; no asigna contraseñas a otras cuentas.
- La cola local de auditoría confirma solamente los identificadores aceptados
  por el servidor, conserva pendientes y no mezcla sesiones. La interfaz muestra
  el origen de cada evento y evita duplicar su copia local confirmada.

## Archivos

Las subidas sin ficha exacta quedan privadas para su propietario autorizado.
Una referencia exacta y autorizada es necesaria para publicar el archivo.
La revisión independiente detectó además el reemplazo por DELETE+POST sobre la
misma ruta. Quedó corregido mediante un registro permanente privado de rutas:
la baja auditada de la ficha debe preceder al borrado del binario y ninguna ruta
publicada puede reutilizarse. Si falla la limpieza, queda un pendiente durable
que puede reintentarse sin reinsertar otro archivo. La prueba con Storage real
confirma esta protección.

Las altas Auth usan una creación exclusiva antes de invitar. Una invitación
duplicada ya no permite que la compensación elimine una cuenta pendiente
preexistente de este u otro sitio. El fallo de envío tras el alta conservada
informa que la invitación quedó pendiente.

El preflight de producción no encontró rutas duplicadas ni fichas Supabase sin
su objeto correspondiente. Hay 20 objetos sin ficha exacta: no se eliminan ni
se atribuyen automáticamente a otro usuario.

## Validación y recuperación

Se utilizan servicios oficiales locales, cuentas y documentos sintéticos. No se
copian datos clínicos de producción a los ensayos. Las pruebas incluyen REST,
JWT, Auth, Storage, concurrencia PostgreSQL y captura SMTP exclusivamente local.
La ejecución final aprobó 17 pruebas de Auth, 28 de integridad/permisos, 9 del
handler administrativo real y 8 de respaldo/restauración. Los hashes del código,
los resultados y las diferencias de plataforma están en
[`VALIDACION_LOCAL_20261126.md`](VALIDACION_LOCAL_20261126.md) y
[`tests/results/20261126`](../tests/results/20261126/).

La reversión estricta de auditoría se permite solamente antes de registrar
eventos nuevos. La reversión documental se bloquea desde que incorpora las
fichas existentes: en producción hay 34, de modo que requiere corrección hacia
adelante incluso antes de nuevas operaciones. No se borra la pista ni el registro
de rutas para forzar una reversión del catálogo.

El JSON exportado por Zonda sigue siendo un respaldo de los registros visibles
para la sesión; no equivale a un backup de toda la base ni incluye sus binarios.
La recuperación completa se ensaya con pg_dump/pg_restore y archivos separados,
comparando cantidades, relaciones, autenticación y hashes de contenido.

## Límites externos

La cuenta personal de Pablo figura confirmada, activa y con membresía de
administrador en un sitio activo. No se leyó ni modificó su contraseña. Las
pruebas sintéticas no prueban que su acceso personal haya quedado resuelto.

La configuración SMTP, la política central de contraseñas de Auth y el estado
del backup administrado requieren acceso al panel de Supabase, todavía no
completado. La regla de diez caracteres ya se aplica en los formularios y la
función administrativa de la versión 0.9.6.1; no se afirma que la API directa de
Auth la imponga. El proyecto mantiene el plan Free.
No se activaron opciones pagas; la protección administrada contra contraseñas
filtradas requiere una decisión separada sobre el plan.

Estas comprobaciones no constituyen una certificación de seguridad ni de
cumplimiento regulatorio.

## Orden de publicación pendiente

1. Restablecer la conexión SQL administrativa y actualizar el preflight del
   esquema y de las rutas documentales.
2. Aplicar membresías seguras, auditoría/permisos y documentos privados, en ese
   orden, verificando los hashes probados y conservando el historial existente.
3. Publicar las tres Edge Functions y después el frontend 0.9.7. Los campos de
   auditoría nuevos deben existir antes del código que los envía.
4. Verificar políticas, funciones, cantidades y acceso con cuentas autorizadas.

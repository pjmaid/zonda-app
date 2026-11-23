# Revisión de Zonda 0.9.5

Se revisaron acceso, persistencia clínica, documentos, administración, IA,
respaldo, presentación y permisos de servidor. Las reglas médicas y los datos
clínicos existentes no se modificaron durante la revisión.

## Cambios implementados

- Recuperación e invitaciones compatibles con Supabase; errores de enlace y
  servicio diferenciados; protección ante envíos simultáneos y cambios de cuenta.
- Conservación de narrativa e historial; reintentos de guardados parciales sin
  duplicar pacientes o medicación; evolución conservada si falla el guardado.
- Eliminación de adjuntos con respaldo, respuesta comprobada y compensación;
  protección de sesión entre etapas e indexación con intención persistida.
- Inventario de archivos sin registro con paginación y antigüedad mínima, sin
  borrado automático. No se eliminaron archivos de producción.
- Validación de roles, perfiles y sitios en administración e IA; auditoría
  previa, avisos de operaciones aplicadas parcialmente y límites de solicitudes.
- Confirmación individual de imágenes, redacción Unicode y errores de IA sin
  devolver contenido interno del proveedor.
- Auditoría local aislada por cuenta y organización. Los eventos antiguos sin
  ámbito se conservan, pero no se reasignan ni se envían con otra cuenta.
- Tiempo máximo de red, carga inicial de cuatro colecciones en paralelo,
  validación de confirmaciones, foco accesible y barras adaptables en móvil.
- Restauración de JSON limitada al sitio de origen y configuración de caché
  para obtener la versión vigente.

## Verificación

- `node --test tests/*.test.js`: 216 pruebas aprobadas, sin fallos.
- `tests/database-policy-runtime.mjs`: 15 comprobaciones PostgreSQL mediante
  PGlite 0.6.0, con datos sintéticos y sin conexión a producción.
- JavaScript del HTML y archivos nuevos analizados sin errores de sintaxis.
- Auth y REST públicos responden HTTP 200; las comprobaciones no usaron claves
  personales ni enviaron correos, imágenes o datos clínicos a proveedores de IA.
- Edge Functions publicadas: `crear-usuario` 20, `ia` 9 y `rag` 16.
- Migración `endurecimiento_funciones_rls` aplicada. La copia previa de funciones
  y políticas está en `supabase/rollback/20261123_schema_before_review.json`;
  no constituye un respaldo de datos clínicos.

## Pendientes y límites

La migración `20261123_storage_roles_identidad.sql` no está aplicada. La revisión
automática bloqueó su aplicación a producción porque falta validación integrada
con Auth, membresías y Storage en un Supabase de prueba. Las pruebas locales
verifican SQL y roles, pero no sustituyen esa integración. Ver la matriz y los
hallazgos estructurales en `DATABASE_REVIEW_20261123.md`.

Quedan pendientes la auditoría obligatoria para toda escritura directa, el
control transaccional del último administrador, la protección de membresías de
superadministradores por REST y la separación privada de archivos durante la
subida. No se declara cumplimiento regulatorio ni una auditoría de seguridad
cerrada por la aprobación de pruebas automatizadas.

La prueba completa de acceso con una cuenta real, envío de correo de recuperación,
restauración de backups y uso de múltiples roles requiere sesiones de prueba.
La contraseña de Pablo no fue leída, modificada ni comprobada.

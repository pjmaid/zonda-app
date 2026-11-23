# Registro de cambios

## 0.9.5 — 2026-11-23

- Corrige redirecciones de recuperación e invitación, enlaces vencidos, estados de ingreso y limpieza de sesión; conserva intactas las claves existentes.
- Preserva historia y narrativa clínica, evita duplicados tras guardados parciales y permite reintentar remapeos de criterios sin repetir cambios confirmados.
- Respalda documentos antes de borrarlos, comprueba la respuesta real de Storage, compensa fallos y evita operar con una cuenta distinta durante la misma acción.
- Registra la intención de indexación antes de enviar contenido; permite retirar envíos pendientes. La revisión de archivos sin registro es de solo lectura.
- Refuerza la administración de usuarios y la IA con validación de identidad, organización, permisos, auditoría previa y errores explícitos.
- Aísla la cola local de auditoría por cuenta y sitio; añade plazos de red, carga inicial concurrente, navegación móvil y mejoras de accesibilidad.
- Bloquea restauraciones de otro sitio y evita caché persistente de la configuración de despliegue.
- Aplica el endurecimiento de funciones internas pendiente de 0.9.4. La nueva separación de permisos de Storage y el vínculo de identidad en SQL quedan preparados y probados localmente, pendientes de validación integrada y aplicación.

## 0.9.4 — 2026-11-13

- Completa el flujo de recuperación de clave y elimina el alta pública sin asignación de sitio.
- Evita borrados parciales de documentos, informa fallos de Storage y restaura el archivo si falla el registro.
- Hace visibles los fallos de persistencia clínica y audita de forma obligatoria las operaciones de acceso.
- Permite a un administrador depurar el índice histórico no permitido y limpiar archivos huérfanos con vista previa y confirmación.
- Prepara la restricción de funciones de seguridad y optimización RLS (aplicada el 23 de noviembre) y agrega integridad SRI a la dependencia externa de lectura DOCX.

## 0.9.3 — 2026-09-10

- Corrige el bloqueo del ingreso introducido en 0.9.2: el cursor de la carga inicial enviaba comillas adicionales en un filtro escalar de PostgREST y podía repetir la primera página.
- El cursor ahora transmite el ID literal, codificado como parámetro de URL. Las pruebas reproducen la semántica real de PostgREST, incluidos UUID e identificadores con caracteres especiales.

## 0.9.2 — 2026-09-10

- Carga paginada de todas las colecciones, incluso cuando el servidor limita cada respuesta; los datos y sus revisiones se reemplazan juntos al completar la carga.
- El guardado conserva una copia del contenido enviado. Los reintentos usan exactamente la misma solicitud y recargan la versión vigente cuando el servidor confirma un evento ya procesado.
- Las solicitudes simultáneas comparten la renovación de sesión. Una respuesta de la sesión anterior no puede reintentar escrituras con otra cuenta.
- Facturación conserva el aviso cuando el gasto se guarda pero falla su comprobante, y evita envíos simultáneos del mismo formulario.
- El control de versión admite configuraciones válidas de prueba y producción y conserva el bloqueo de escrituras con un entorno sin configurar.

## 0.9.1-rc.1 — 2026-08-16

- Configuración deja de mostrar la plantilla general del proceso de consentimiento.
- Configuración deja de mostrar o incorporar el esquema SQL inicial; las migraciones quedan únicamente en `supabase/migrations`.
- Cada protocolo conserva su plantilla propia o usa el texto predeterminado de Zonda.
- Los administradores pueden crear usuarios, asignar una clave temporal y eliminar definitivamente su acceso.
- Las bajas eliminan la cuenta y sus asignaciones, pero conservan los registros clínicos y la auditoría.
- La administración de cuentas valida rol, organización, último administrador activo y evita el autoborrado.

## 0.9.0-rc.1 — 2026-08-10

- Control de concurrencia por revisión y auditoría transaccional.
- Registros, checklists y configuraciones compartidos en Supabase.
- Permisos RLS por organización, protocolo y rol.
- IA centralizada y anonimizada en una Edge Function.
- Controles automáticos de calidad y pantalla operativa «Hoy».
- Importación trazable de protocolos y comparación de enmiendas.
- Configuración explícita de entorno, versión visible y restauración validada.

Esta versión es candidata para pruebas. No debe desplegarse como producción hasta completar la lista de verificación de `DEPLOYMENT.md`.

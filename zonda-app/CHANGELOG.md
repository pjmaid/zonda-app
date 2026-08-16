# Registro de cambios

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

# Integración de permisos con Auth y Storage reales

El harness `scripts/verify-supabase-integration.mjs` está preparado para un
Supabase separado y vacío, alojado o local. No aplica migraciones, no crea
proyectos ni usa información de pacientes. El plan puede verse sin credenciales
y sin hacer solicitudes:

```bash
node scripts/verify-supabase-integration.mjs
```

## Resultado del 23 de noviembre de 2026

Se ejecutó contra servicios oficiales locales reales: PostgreSQL 17.12, Auth
2.198.0, Storage 1.98.6 y PostgREST 16.6, con puerta de enlace limitada a loopback.
El catálogo de Zonda coincidió con la captura revisada antes de crear fixtures.
La ejecución de base reprodujo el borrado clínico indebido por coordinadora; la
ejecución con la migración aplicada localmente aprobó **14/14 comprobaciones**.
Ambas verificaron la limpieza, y la reversión local recuperó el esquema inicial.

Los informes sin credenciales están en
[`tests/results/20261123`](../tests/results/20261123/). Este resultado corresponde
a la integración API local; no afirma una prueba del hosting productivo, SMTP,
la interfaz web completa ni del ingreso a la cuenta personal de Pablo. La
aplicación productiva posterior está registrada en `VALIDACION_SUPABASE_20261123.md`.

## Preparar el destino

Seguir `TEST_SCHEMA_BOOTSTRAP.md` para reconstruir solo el esquema de Zonda.
Aplicar la migración de Storage/identidad únicamente en ese destino de prueba.
Mantener el `runtime-config.js` de producción sin cambios.

El destino debe tener las tablas, funciones, RLS y grants reales, Auth y Storage
operativos y `ec-docs` privado. Si el bucket aún no existe, el harness lo crea y
lo elimina al terminar. Si existe, verifica que sea privado y esté vacío,
incluidas carpetas, y lo conserva. El harness rechaza cualquier fila preexistente
en las once tablas `ec_*` o cuentas Auth preexistentes.

Un Supabase local requiere servicios reales (PostgreSQL, Auth, PostgREST,
Storage y puerta de enlace), no los sustitutos utilizados en PGlite. La opción
usual gratuita es Supabase CLI con Docker en una máquina compatible. Un runtime
equivalente con servicios nativos debe conservar los mismos esquemas gestionados,
contexto JWT y rutas API. No se considera suficiente arrancar solo PostgreSQL.

## Configuración por entorno

Asignar estas variables mediante el mecanismo de secretos de la sesión. No
añadirlas al repositorio, a `runtime-config.js`, ni a los informes:

| Variable | Proyecto alojado | Runtime local |
| --- | --- | --- |
| `ZONDA_TEST_ENVIRONMENT` | `test` | `test` |
| `ZONDA_TEST_MODE` | `hosted` | `local` |
| `ZONDA_TEST_PROJECT_REF` | Ref del proyecto de prueba | `local-zonda-test` |
| `ZONDA_TEST_CONFIRM_REF` | El mismo ref de prueba | `local-zonda-test` |
| `ZONDA_TEST_URL` | `https://REF_DE_PRUEBA.supabase.co/` | URL loopback del gateway, por ejemplo `http://127.0.0.1:54321/` |
| `ZONDA_TEST_PUBLIC_KEY` | Publishable o JWT `anon` de prueba | JWT `anon` ficticio del runtime local |
| `ZONDA_TEST_SERVICE_KEY` | Secret o JWT `service_role` de prueba | JWT `service_role` ficticio del runtime local |

El ref y la publishable productivos conocidos, y los configurados como producción
en Zonda, están bloqueados. También se rechazan URLs con credenciales/rutas y
claves JWT de otro proyecto. El modo local admite solamente `localhost`,
`127.0.0.1` o `::1`. `ZONDA_TEST_CONFIRM_REF` es una guarda contra destinos mal
configurados; no reemplaza la autorización para crear o modificar un recurso.

Tras verificar el destino y sus costos, ejecutar:

```bash
node scripts/verify-supabase-integration.mjs --execute
```

Agregar `--json` para obtener solo el informe JSON, sin las líneas de progreso.
También se exporta `runIntegration(env, {log: () => {}})` para un supervisor local.

Para demostrar la regresión, el supervisor puede ejecutar primero el harness
contra el bootstrap anterior al parche: debe fallar exactamente cuando la
coordinadora logra borrar el documento clínico, y debe completar la limpieza.
Tras comprobar ese resultado y que el destino volvió a quedar vacío, aplicar la
migración **solo en test** y exigir las 14 comprobaciones aprobadas. Cualquier
otro fallo inicial requiere investigar el runtime antes de atribuirlo al parche.

## Qué ejecuta

Crea dos organizaciones, tres estudios sin pacientes y ocho cuentas sintéticas
con emails `example.invalid`. Auth Admin marca el email como confirmado, por lo
que el harness no solicita envío de invitaciones o recuperaciones. Genera claves
aleatorias que solo existen en memoria e inicia sesión con el flujo real de
contraseña. Usa `service_role` para fixtures y limpieza; las pruebas de acceso
usan JWT reales de usuarios.

Las 14 comprobaciones cubren:

- lectura, actualización y bloqueo de baja clínica por coordinadora;
- compensación de carga propia sin ficha, sin borrar la ajena;
- contratos con y sin permiso financiero;
- separación entre sitios y protocolos asignados;
- acceso anónimo, membresía inactiva y cuenta sin membresía;
- identidad ligada al Auth ID y respaldo por email solo en perfiles históricos;
- lectura y baja autorizada de rutas actuales e históricas.

Los roles reales son `admin`, `medico` y `coord`. `lector`, usado como rol
sintético en PGlite, no se crea ni se incorpora a las restricciones del esquema.
Los archivos son secuencias PDF sintéticas pequeñas; no se evalúa aquí un visor
PDF ni la extracción documental. Tras cada denegación de escritura/borrado se
comprueba que el binario original sigue intacto.

## Limpieza y evidencia

La limpieza se ejecuta también si falla una comprobación. Elimina solo los IDs y
las rutas exactas creadas por esa ejecución: objetos, fichas, estudios,
membresías, cuentas Auth y organizaciones. No usa un borrado global de tablas,
ni vacía un bucket existente. El resultado JSON no contiene claves ni tokens.
Si falla la limpieza, conserva en el informe los IDs sintéticos necesarios para
revisar los residuos; el resultado general queda fallido.
Al final consulta otra vez las once tablas, Auth y Storage para verificar que
el destino quedó vacío; una respuesta HTTP favorable de borrado no basta.

Guardar el resultado junto con la versión de servicios, el commit del cliente,
el checksum del bootstrap y el de la migración. Una ejecución aprobada valida
esa integración, no la auditoría regulatoria, SMTP, Edge Functions o el cliente
web completo. La aplicación del parche en producción se registra por separado
en `VALIDACION_SUPABASE_20261123.md`; el harness nunca se conecta a producción.

## Comprobaciones del harness

```bash
node --test tests/integration-harness-safety.test.js
node --check scripts/verify-supabase-integration.mjs
```

Estas comprobaciones prueban las guardas del ejecutor y que un destino no vacío
se rechace antes de cualquier mutación. No se presentan como resultados de la
integración remota.

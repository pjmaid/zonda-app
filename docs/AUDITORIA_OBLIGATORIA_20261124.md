# Escrituras y auditoría obligatoria — 24 de noviembre de 2026

Implementación: `supabase/migrations/20261124002135_auditoria_permisos.sql`.
Orden: membresías seguras → auditoría/permisos → documentos privados. El esquema
de partida es `tests/fixtures/schema-baseline-20261124.json`; no contiene filas.

## Garantía y alcance

Cada INSERT, UPDATE o DELETE de estudios, pacientes, visitas, documentos,
usuarios, registros, checklists, configuraciones, membresías y organizaciones
produce un evento de base de datos en la misma transacción. Si el evento falla,
también se revierte el cambio. Incluye escrituras directas de `service_role` y
bajas por cascada. TRUNCATE está revocado y además bloqueado mediante trigger;
no se interpreta como una baja auditada de cada fila.

El evento conserva actor, rol, organización de origen, operación real, revisión,
hora del servidor y hashes SHA-256 antes/después. No duplica el contenido clínico
completo en una tabla de auditoría. La etiqueta o motivo declarado por el usuario
se distingue de la operación que confirmó PostgreSQL.

Las cuentas normales no pueden editar, borrar ni truncar la auditoría, ni escribir
directamente en las ocho tablas gestionadas por `ec_save_record` y
`ec_remove_record`. `service_role` conserva sus escrituras necesarias, pero no
puede editar/borrar/truncar el ledger. Los administradores de base de datos y
quienes controlan el autenticador/JWT siguen siendo parte de la infraestructura
de confianza; estas pruebas no presentan sus capacidades como equivalentes a
las de una cuenta de Zonda.

## Autorización y contexto

`zonda_rpc_writer` es NOLOGIN, no posee tablas y no tiene BYPASSRLS ni privilegios
de administración. Hereda `authenticated` para que las RPC definidoras sigan
sujetas a las mismas RLS y al usuario real de `auth.uid()`. Ni `authenticated`,
`anon`, `authenticator` ni `service_role` reciben membresía del escritor. La
migración rechaza roles preexistentes con flags, membresías o propiedad de
relaciones incompatibles con este diseño.

`zonda_audit_writer` es otro rol NOLOGIN y limitado a insertar eventos mediante
los triggers. Solo `postgres`, como administrador de migraciones, puede
administrar esos propietarios. Las funciones fijan `pg_catalog, public, pg_temp`
en ese orden y califican las relaciones sensibles.

Los contextos de escritura y de actor son tablas privadas, vinculadas al PID y
al ID de transacción. No existe una variable de sesión que permita omitir la
auditoría. El contexto de actor se captura antes de las modificaciones y permite
atribuir una cascada incluso después de que se elimine la membresía del actor.
El slot por PID se reemplaza cuando cambia la transacción.

## Idempotencia

Los recibos de operaciones están en un esquema privado, no en el texto de
`ec_audit`. Se vinculan a organización, ID de evento, actor y hash de todos los
argumentos de la operación. Dos solicitudes simultáneas con el mismo ID se
serializan en la clave única. Una repetición idéntica devuelve el resultado
original sin crear otro cambio/evento; reutilizar el ID con otro actor, contenido
u operación falla. Una baja repetida no responde como si hubiera borrado una
nueva fila recreada con el mismo ID: devuelve conflicto de versión.

Los recibos, el cambio y el evento se confirman o revierten juntos. No hay una
excepción basada en insertar previamente un evento de auditoría.

## Contrato del cliente y las Edge Functions

| Operación | Contrato |
| --- | --- |
| Guardar/borrar | Mismos argumentos RPC actuales; `event_id` permanece igual al enviado. Respuesta añade `audit_ts`; una repetición devuelve `replayed:true`. |
| Eventos de interfaz | `ec_append_audit_events(p_events jsonb)`, máximo 100 elementos. Devuelve `{accepted:[event_id_original]}`. |
| Identidad de evento cliente | Organización, actor, rol y hora derivados por el servidor. Si el lote declara otro `org_id` o `auth_user_id`, se rechaza. |
| Deducción visual de eventos cliente | El ledger usa `event_id=client:ACTOR:ID` y conserva `client_event_id=ID`; el cliente debe conciliar por `client_event_id || event_id`. |
| Eventos complementarios de Edge Functions | Se mantiene POST a `ec_audit` con `service_role`. Enviar `actor_id` del usuario previamente validado; la base deriva su email/rol y verifica su ámbito. Sin actor, queda identificado como servicio técnico. |

La procedencia es explícita:

- `database`: modificación confirmada por PostgreSQL; operación INSERT/UPDATE/DELETE.
- `client`: evento declarado por la interfaz, con acción canónica «evento de cliente».
- `service`: evento complementario de un servidor, con acción «evento de servicio».
- `legacy`: historia previa a esta migración, sin atribuirle garantías nuevas.

`action_label` conserva la etiqueta declarada. La interfaz no debe mostrar un
evento de cliente como prueba de que se produjo una modificación de datos.
Las Edge Functions deben desplegarse después de que exista `actor_id`.

## Privilegios y retención

Las ocho tablas de registros quedan con SELECT para `authenticated`; las RPC
usan el escritor limitado. Se revocan también privilegios por columna para que
no subsista una vía alternativa de INSERT/UPDATE. Los permisos de membresías y
organizaciones conservan su RLS específica. Ninguna tabla de Zonda concede
permisos anónimos; se retiran TRUNCATE, REFERENCES, TRIGGER y MAINTAIN de los roles
de aplicación. Los defaults de tablas nuevas creadas por `postgres` tampoco
reintroducen DML de cliente.

La lectura del ledger queda limitada a administradores del sitio,
superadministradores o eventos del propio actor. Los eventos históricos sin
`actor_id` no se asignan por coincidencias de email.

Se retira únicamente el FK de `ec_audit.org_id`: ese UUID pasa a ser una
referencia histórica inmutable. Eliminar una organización no borra su auditoría,
ni cambia sus identificadores. Los demás FK de negocio siguen vigentes. Los
eventos de una organización borrada quedan disponibles al superadministrador,
no a usuarios sin esa organización activa.

## Validación y reversión

La compilación y las operaciones básicas de guardado, repetición y eventos de
cliente se comprobaron en PostgreSQL WASM. La evidencia decisiva de REST,
Storage, concurrencia y SQL adversarial pertenece al runtime real separado,
ejecutado por `scripts/verify-supabase-hardening-local.mjs`; registrar sus
resultados finales y checksums junto con el release, sin inferirlos del smoke.

La reversión `supabase/rollback/20261124002135_auditoria_permisos.sql` solo se
permite antes de usar la nueva vía: aborta con
`AUDIT_ROLLBACK_REQUIRES_FORWARD_FIX` si existen eventos nuevos, recibos o
referencias históricas que no puedan recuperar el FK anterior. La reversión en
una base vacía se comprueba por separado; no se purga una pista real para hacer
coincidir un catálogo. Tras el uso, conservar el ledger y corregir hacia adelante.

Una restauración administrada de un respaldo no es una operación ordinaria de
la aplicación: debe mantener la evidencia original y validarse en otro destino.
La publicación no equivale a una certificación de cumplimiento regulatorio.

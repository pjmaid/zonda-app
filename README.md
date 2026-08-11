# Zonda

Aplicación web para la gestión operativa de estudios de investigación clínica.

## Despliegue seguro de esta rama

Esta rama incorpora control de concurrencia, auditoría transaccional y almacenamiento compartido de los módulos que antes dependían del navegador. El orden de despliegue es obligatorio:

1. Hacer una copia de seguridad de la base de datos de Supabase.
2. Ejecutar en el SQL Editor de Supabase `supabase/migrations/20260809_integridad_concurrencia_auditoria.sql`.
3. Ejecutar `supabase/migrations/20260810_registros_checklists_compartidos.sql`.
4. Ejecutar `supabase/migrations/20260810_configuracion_permisos_por_protocolo.sql`.
5. Configurar y desplegar la Edge Function de IA según la sección siguiente.
6. Verificar las tres migraciones y la función en un ambiente de prueba.
7. Recién después desplegar `index.html`.

Si la migración no está aplicada, la aplicación bloquea el guardado y muestra una advertencia; no vuelve al mecanismo anterior de “última escritura gana”.

Esta rama agrega además un límite de publicación: `runtime-config.js` debe declarar expresamente `test` o `production`. Con `unconfigured`, Zonda muestra una banda roja y rechaza altas, modificaciones y bajas. La versión y el identificador del release quedan visibles en el ingreso y en la barra superior.

El procedimiento completo, incluida la reversión, está en [`DEPLOYMENT.md`](DEPLOYMENT.md). Antes de aprobar un release ejecutar:

```bash
node --test tests/*.test.js
node scripts/verify-release.mjs test
```

El segundo comando debe ejecutarse después de asignar entorno, versión y SHA del release en `runtime-config.js`.

## Qué cambia

- Cada registro de estudios, pacientes, visitas, documentos y usuarios tiene una revisión (`rev`) generada por el servidor.
- Una edición solo se acepta si la revisión que abrió el usuario sigue vigente.
- Ante un conflicto, se rechaza la edición y se recarga la versión más reciente.
- La memoria del navegador se actualiza únicamente después de la confirmación del servidor.
- El cambio y su evento de auditoría se escriben en una única transacción PostgreSQL.
- Los eventos generales de auditoría pendientes quedan en una cola local visible y se reintentan; ya no se descartan silenciosamente.
- Los registros de herramientas (`EA`, medicación concomitante, desviaciones, queries, muestras, inventarios, producto, tareas y facturación) se guardan en `ec_records`.
- Los checklists de calidad se guardan en `ec_checklists`.
- La clasificación de procedimientos, los análisis adicionales y la asignación de tareas a tablet se guardan en `ec_settings`.
- Los tres módulos usan el mismo control de revisión, transacción y auditoría que pacientes y visitas.
- Las políticas RLS filtran estudios, pacientes, visitas, documentos, registros, checklists y configuraciones por los protocolos asignados al usuario.
- Los documentos nuevos incluyen el protocolo en la ruta de Storage; los objetos anteriores se autorizan mediante su ficha en `ec_docs`.
- Crear protocolos queda reservado al administrador; el médico puede editar solamente los asignados y la coordinadora no puede modificar su definición.
- Las consultas de IA pasan por `supabase/functions/ia`; las claves de los proveedores dejan de existir en el navegador.
- La Edge Function valida usuario y membresía, anonimiza identificadores textuales detectables y registra cada generación en `ec_audit`.
- Las imágenes requieren confirmación explícita porque no pueden anonimizarse automáticamente sin OCR.
- Las respuestas, fichas y tarifarios generados quedan marcados como borradores que requieren revisión humana.
- Las visitas, los EA/EAS, los procesos de consentimiento y las randomizaciones pasan por controles automáticos de calidad antes de guardarse.
- Los hallazgos se clasifican como bloqueo, advertencia o pendiente y quedan guardados en `controlCalidad` dentro del registro auditado.
- Una visita requiere consentimiento previo, no puede duplicarse y exige motivo para cada procedimiento no realizado.
- La randomización requiere elegibilidad favorable y la versión vigente del consentimiento firmada.
- Los EAS pueden guardarse con el reporte pendiente para activar su seguimiento, pero requieren fecha de conocimiento y cronología coherente.
- La importación del cronograma conserva documento, versión, método, páginas, fragmento y confianza de cada celda.
- Las celdas con confianza menor al 80% se resaltan; las correcciones manuales y la matriz originalmente extraída quedan diferenciadas.
- Las enmiendas se comparan con el cronograma vigente antes de aplicarse y el historial conserva la versión extraída, la revisada y sus diferencias.

## Configuración del servicio de IA

La función admite OpenAI, Anthropic o Gemini. Elegir un solo proveedor y guardar sus credenciales como secretos de Supabase; nunca incorporarlas en `index.html` ni en Git.

Ejemplo con OpenAI:

```bash
supabase secrets set AI_PROVIDER=openai AI_MODEL=gpt-5.1 OPENAI_API_KEY=REEMPLAZAR_EN_LA_TERMINAL
supabase functions deploy ia
```

Para Anthropic usar `AI_PROVIDER=anthropic`, `AI_MODEL=claude-sonnet-5` y `ANTHROPIC_API_KEY`. Para Gemini usar `AI_PROVIDER=gemini`, `AI_MODEL=gemini-2.5-flash` y `GEMINI_API_KEY`.

Después del despliegue, ingresar a Zonda como usuario autenticado y usar **Configuración → Verificar servicio de IA**. La comprobación no envía documentos al proveedor.

## Migración de datos guardados en el navegador

Después de aplicar las tres migraciones SQL, el primer ingreso de cada navegador compara `ecx_logs` y `ecx_chk` con la nube:

- pide confirmar el sitio antes de importar;
- copia solamente IDs que todavía no existen en Supabase;
- conserva la versión de la nube si encuentra el mismo ID con contenido diferente;
- guarda una copia previa en `ecx_logs_respaldo_pre_migracion` y `ecx_chk_respaldo_pre_migracion`;
- registra cada elemento importado en la auditoría transaccional;
- marca la migración por organización para no repetirla.

No borrar el almacenamiento del navegador hasta verificar que la cantidad de registros y checklists coincide con el respaldo exportado.

La migración también compara `ecx_procclasif`, `ecx_labextra` y `ecx_tabletclasif` con `ec_settings`. Antes de importar crea `ecx_settings_respaldo_pre_migracion`, copia solo los IDs ausentes y conserva la versión de la nube ante un conflicto.

## Respaldo y restauración

El JSON exportado por la interfaz es una copia operativa de los registros visibles. Incluye un manifiesto de versión, entorno, organización, release y checksum SHA-256. No contiene los binarios de Storage ni reemplaza el backup administrado de PostgreSQL.

Al importar, Zonda:

- valida estructura, IDs y claves peligrosas;
- verifica el checksum cuando está disponible;
- admite respaldos históricos de la versión 4;
- simula altas, reemplazos y elementos sin cambios;
- exige escribir `IMPORTAR`;
- descarga automáticamente `respaldo_pre_restauracion_...json` antes de escribir;
- no reinyecta eventos históricos en la auditoría append-only;
- registra cada cambio de restauración como un evento nuevo.

## Verificación mínima antes de publicar

- Abrir el mismo paciente en dos navegadores, editarlo en ambos y guardar uno después del otro. El segundo debe recibir el aviso de conflicto y no sobrescribir el primero.
- Interrumpir la conexión antes de guardar. La pantalla debe restaurar la última versión confirmada y mantener visible el error.
- Confirmar en `ec_audit` que cada alta o modificación aceptada tiene exactamente un evento con el mismo `event_id`.
- Forzar un error de inserción en `ec_audit`. La modificación principal también debe revertirse por ser parte de la misma transacción.
- Recuperar la conexión y comprobar que la cola de eventos generales pendientes se sincroniza sin duplicados.
- Comparar la cantidad de filas de `ec_records` por `record_type` con el respaldo JSON anterior.
- Abrir el mismo EA en dos navegadores, editarlo en ambos y comprobar que el segundo cambio recibe conflicto de versión.
- Modificar un checklist en un navegador y confirmar que aparece en el otro después de recargar.
- Probar la migración con un ID ya existente y contenido diferente: la nube debe conservarse y el navegador debe informar el conflicto.
- Clasificar un procedimiento y marcar una tarea para tablet; al recargar otro navegador deben conservarse ambas decisiones.
- Ingresar como médico asignado a un solo protocolo: Supabase no debe devolver filas de otros protocolos, ni siquiera mediante una consulta REST manual.
- Ingresar como coordinadora: debe poder registrar pacientes, visitas y registros de sus protocolos, pero no crear, editar ni borrar protocolos.
- Intentar abrir directamente un objeto de Storage perteneciente a un protocolo no asignado; la respuesta debe ser denegada.
- Confirmar que `ecx_cfg` no contiene `aiKey`, `aiProvider` ni `aiModel` después de recargar la aplicación.
- Verificar que una generación de IA crea una fila en `ec_audit` con `entidad = ia`, finalidad, proveedor, modelo y cantidad de identificadores omitidos.
- Probar un texto con correo, DNI, teléfono e iniciales conocidas y confirmar mediante un proveedor de prueba que recibe marcadores de omisión.
- Intentar enviar una página como imagen y cancelar la confirmación: no debe realizarse ninguna llamada al proveedor.
- Generar una respuesta documental, un tarifario y una ficha; los tres deben mostrar que son borradores asistidos y requieren revisión humana.
- Intentar guardar una visita sin consentimiento previo: debe bloquearse antes de escribir en Supabase.
- Intentar registrar dos veces la misma visita del protocolo para un paciente: la segunda debe bloquearse.
- Guardar una visita fuera de ventana: debe exigir confirmación y conservar el hallazgo en `controlCalidad`.
- Abrir un EA o una medicación desde una visita: al volver, el borrador de la visita debe conservar todos sus campos y procedimientos.
- Destildar un procedimiento o guardar fuera de ventana: debe ofrecer crear una desviación abierta vinculada a la visita.
- En «Hoy», verificar que EAS sin reportar, EA en curso, queries, desviaciones, tareas y vencimientos abran el registro correspondiente.
- Importar una tabla por geometría y otra por lectura visual: verificar páginas, confianza, resaltado de dudas y correcciones manuales.
- Elegir un documento de tipo «Enmienda»: antes de aplicar debe mostrar visitas agregadas, retiradas o modificadas respecto del cronograma vigente.
- Guardar y reabrir el protocolo: `importacionesProtocolo` y la trazabilidad de cada visita deben conservar la extracción original y la versión revisada.
- Destildar un procedimiento sin escribir el motivo: la visita no debe guardarse. Con motivo, debe quedar como pendiente de evaluación de desviación.
- Intentar randomizar con elegibilidad pendiente o sin la versión vigente del CI firmada: debe bloquearse.
- Registrar un EAS sin fecha de conocimiento o con reporte anterior al conocimiento: debe bloquearse. Sin fecha de reporte, debe permitirse con un pendiente visible.
- Ejecutar `node --test tests/*.test.js`; deben aprobar las pruebas de integridad y las reglas de calidad.

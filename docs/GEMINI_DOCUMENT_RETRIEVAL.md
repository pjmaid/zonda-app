# Recuperación documental clínica y Gemini

## Decisión de arquitectura

Zonda separa tres productos que no son intercambiables:

- **Gemini API** genera contenido. Su herramienta File Search ofrece RAG y citas, pero es un servicio distinto de Gemini Notebook.
- **Gemini Notebook Enterprise** expone una API Preview para crear, obtener, listar, borrar y compartir notebooks y administrar fuentes. La documentación oficial no publica un método para hacer preguntas al notebook ni reutilizar por API su conversación/RAG.
- **Vertex AI Search / Gemini Enterprise** puede responder sobre un data store con filtros de metadatos y citas. Es la arquitectura que la interfaz actual denomina `rag`; no debe describirse como “el motor de Notebook”.

Fuentes oficiales:

- https://ai.google.dev/gemini-api/docs/file-search
- https://cloud.google.com/gemini/enterprise/notebooklm-enterprise/docs/api-notebooks
- https://cloud.google.com/gemini/enterprise/docs/connect-notebooklm
- https://cloud.google.com/generative-ai-app-builder/docs/answer

## Reglas obligatorias

Toda consulta clínica debe:

1. incluir un `estudio_id` no vacío y autorizado para el usuario;
2. limitar `maxReturnResults` / `max_fragmentos` a 25;
3. filtrar en servidor por organización, estudio y `tipo`;
4. admitir solamente `protocolo`, `manual`, `enmienda` y `ci`;
5. rechazar `paciente_id`, historias clínicas, identificadores y documentos de pacientes;
6. excluir contratos, presupuestos, facturas, comprobantes y documentos administrativos;
7. devolver una cita con nombre exacto del documento y página para cada respuesta que se presente como clínica;
8. marcar como no confiable o no responder cuando no haya citas verificables.

El límite y los filtros del navegador son defensa adicional. La función de servidor debe repetir estas validaciones; no se debe confiar en valores enviados por el cliente.

## Backend versionado

La Edge Function `supabase/functions/rag/index.ts` implementa el contrato de `/functions/v1/rag` con Vertex AI Search. Antes de desplegarla hay que configurar en secretos de Supabase `GOOGLE_SERVICE_ACCOUNT_JSON`, `RAG_PROJECT_ID`, `RAG_LOCATION`, `RAG_DATA_STORE_ID` y `RAG_ENGINE_ID`. El esquema del data store debe marcar `org_id`, `estudio_id` y `tipo` como campos indexables para que el filtro obligatorio funcione.

No hay migración ni despliegue automático: la función se deja versionada y probada localmente. El código productivo anterior debe compararse y sus documentos deben reindexarse porque los IDs nuevos quedan prefijados por organización y las páginas se preservan como marcadores citables.

No se debe crear una dependencia ficticia de Gemini Notebook. Si la organización compra Gemini Notebook Enterprise, Zonda puede dejar puntos de configuración para administración de notebooks/fuentes, pero las consultas clínicas deben continuar por un RAG con API documentada (Vertex AI Search o Gemini API File Search) hasta que Google publique una API oficial de consulta de notebooks.

## Configuración segura

Los identificadores del proyecto, región, data store o File Search store pueden configurarse como variables de servidor. Claves de API, credenciales de cuenta de servicio y tokens deben vivir únicamente en secretos del backend. Nunca deben incorporarse a `runtime-config.js`, `index.html`, URLs del navegador ni Git.

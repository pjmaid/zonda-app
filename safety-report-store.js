(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ZondaSafetyStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TYPE = 'reporte_seguridad';
  const CATEGORIES = Object.freeze(['SUSAR', 'DSUR', 'Carta de seguridad', 'Listado periódico', 'Otro']);
  const MAX_BYTES = 50 * 1024 * 1024;

  function isStudyDocument(doc) {
    return !!(doc && doc.estudioId && !doc.pacienteId && !doc.gastoId && !doc.anulado);
  }

  function isReport(doc) {
    return isStudyDocument(doc) && (doc.tipo === TYPE || (doc.tipo === 'otro' && doc.safetyReport === true));
  }

  function isOther(doc) {
    return isStudyDocument(doc) && doc.tipo === 'otro' && doc.safetyReport !== true;
  }

  function metadataFields(metadata = {}) {
    const category = String(metadata.category || 'Otro');
    if (!CATEGORIES.includes(category)) throw new Error('Elegí una categoría válida de reporte.');
    const reportDate = String(metadata.reportDate || '').trim();
    if (reportDate) {
      const date = new Date(reportDate + 'T00:00:00Z');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate) || Number.isNaN(date.valueOf()) ||
          date.toISOString().slice(0, 10) !== reportDate) throw new Error('La fecha del reporte no es válida.');
    }
    return { safetyCategory: category, safetyDate: reportDate, safetyReference: String(metadata.reference || '').trim() };
  }

  function create({studyId, assertContext, docs, online, uid, storagePut, idbPut, saveDoc, refreshDoc}) {
    if (!studyId) throw new Error('Guardá el estudio antes de adjuntar reportes.');
    const attempts = new WeakMap();
    const findDoc = id => docs().find(doc => doc.id === id);

    function newAttempt(file, metadata) {
      if (!file || !file.name || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('Elegí un archivo válido.');
      if (file.size > MAX_BYTES) throw new Error('El archivo supera el límite de 50 MB.');
      const fields = metadataFields(metadata);
      const id = uid();
      const name = String(file.name).replace(/[^\w.\-]+/g, '_');
      const safeName = !name || name === '.' || name === '..' ? 'documento' : name;
      const storage = online() ? 'supabase' : 'idb';
      const doc = {
        id, estudioId: studyId, tipo: TYPE, version: '', filename: file.name,
        mime: file.type || '', size: file.size, subido: new Date().toISOString(), storage,
        path: storage === 'supabase' ? studyId + '/' + id + '/' + safeName : '', ...fields
      };
      return {file, doc, uploaded: false, inFlight: null, confirmed: null};
    }

    async function writeFile(attempt, retry) {
      const {doc, file} = attempt;
      // Si se perdió la respuesta, la ficha puede existir. Comprobar la misma
      // ruta e identidad antes de volver a escribir cualquiera de las dos partes.
      if (retry) {
        if (doc.storage === 'supabase') await refreshDoc(doc.id);
        assertContext();
        const found = findDoc(doc.id);
        if (found) {
          if (found.estudioId !== studyId || found.tipo !== TYPE || !isReport(found) ||
              found.path !== doc.path || found.storage !== doc.storage || found.filename !== doc.filename || found.size !== doc.size) {
            throw new Error('El archivo ya tiene otra ficha. Actualizá la sección antes de continuar.');
          }
          return found;
        }
      }
      if (!attempt.uploaded) {
        if (doc.storage === 'supabase') await storagePut(doc.path, file);
        else await idbPut(doc.id, file);
        attempt.uploaded = true;
        assertContext();
      }
      await saveDoc(doc, {detalle: 'Carga de reporte de seguridad del estudio'});
      assertContext();
      return doc;
    }

    async function upload(file, metadata, retryKey = file) {
      assertContext();
      if (!retryKey || typeof retryKey !== 'object') throw new Error('No se pudo identificar la carga de este reporte.');
      let attempt = attempts.get(retryKey);
      const retry = !!attempt;
      if (!attempt) {
        attempt = newAttempt(file, metadata);
        attempts.set(retryKey, attempt);
      }
      if (attempt.file !== file) throw new Error('El reintento corresponde a otro archivo.');
      if (attempt.confirmed) return attempt.confirmed;
      if (attempt.inFlight) return attempt.inFlight;
      attempt.inFlight = writeFile(attempt, retry);
      try {
        attempt.confirmed = await attempt.inFlight;
        return attempt.confirmed;
      } finally {
        attempt.inFlight = null;
      }
    }

    async function reclassify(id, metadata) {
      assertContext();
      const original = findDoc(id);
      if (!isOther(original) || original.estudioId !== studyId) throw new Error('Elegí un documento «Otro» de este estudio.');
      // El tipo original y la ruta son la identidad inmutable del binario. El
      // marcador cambia su ubicación en la interfaz sin mover ni duplicar bytes.
      const doc = {...original, ...metadataFields(metadata), safetyReport: true};
      await saveDoc(doc, {detalle: 'Documento de estudio clasificado como reporte de seguridad'});
      assertContext();
      return doc;
    }

    async function updateMetadata(id, metadata) {
      assertContext();
      const original = findDoc(id);
      if (!isReport(original) || original.estudioId !== studyId) {
        throw new Error('Elegí un reporte de seguridad de este estudio.');
      }
      const doc = {...original, ...metadataFields(metadata)};
      await saveDoc(doc, {detalle: 'Actualización de datos del reporte de seguridad'});
      assertContext();
      return doc;
    }

    async function restore(id) {
      assertContext();
      const original = findDoc(id);
      if (!isReport(original) || original.estudioId !== studyId || original.tipo !== 'otro') {
        throw new Error('Sólo se pueden devolver los documentos incorporados desde «Otro».');
      }
      const doc = {...original};
      delete doc.safetyReport;
      delete doc.safetyCategory;
      delete doc.safetyDate;
      delete doc.safetyReference;
      await saveDoc(doc, {detalle: 'Reporte devuelto a los documentos generales del estudio'});
      assertContext();
      return doc;
    }

    return {upload, reclassify, restore, updateMetadata};
  }

  return Object.freeze({TYPE, CATEGORIES, MAX_BYTES, isReport, isOther, create});
});

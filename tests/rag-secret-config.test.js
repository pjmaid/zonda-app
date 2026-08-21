const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const configModule = import(pathToFileURL(path.resolve(__dirname, '..', 'supabase', 'functions', 'rag', 'config.mjs')));

function reader(values) {
  return name => values[name];
}

test('prioriza el nombre nuevo sobre el secreto heredado', async () => {
  const { resolveEnv, requiredEnv } = await configModule;
  const read = reader({ RAG_PROJECT_ID:'nuevo', GCP_PROJECT:'heredado' });
  assert.equal(resolveEnv(read, 'RAG_PROJECT_ID', 'GCP_PROJECT'), 'nuevo');
  assert.equal(requiredEnv(read, 'RAG_PROJECT_ID', 'GCP_PROJECT'), 'nuevo');
});

test('usa el secreto heredado cuando falta el nombre nuevo', async () => {
  const { resolveEnv, requiredEnv } = await configModule;
  const read = reader({ GCP_PROJECT:'heredado', GCP_LOCATION:'us' });
  assert.equal(requiredEnv(read, 'RAG_PROJECT_ID', 'GCP_PROJECT'), 'heredado');
  assert.equal(resolveEnv(read, 'RAG_LOCATION', 'GCP_LOCATION'), 'us');
});

test('informa el nombre nuevo cuando faltan ambos secretos', async () => {
  const { requiredEnv } = await configModule;
  assert.throws(
    () => requiredEnv(reader({}), 'RAG_DATA_STORE_ID', 'GCP_DATASTORE'),
    /RAG_CONFIG_MISSING_RAG_DATA_STORE_ID/
  );
});

test('la función enlaza todos los fallbacks heredados esperados', () => {
  const source = require('node:fs').readFileSync(
    path.resolve(__dirname, '..', 'supabase', 'functions', 'rag', 'index.ts'),
    'utf8'
  );
  for (const pair of [
    ['GOOGLE_SERVICE_ACCOUNT_JSON','GCP_SA_JSON'],
    ['RAG_PROJECT_ID','GCP_PROJECT'],
    ['RAG_DATA_STORE_ID','GCP_DATASTORE'],
    ['RAG_ENGINE_ID','GCP_ENGINE'],
    ['RAG_LOCATION','GCP_LOCATION'],
  ]) {
    assert.match(source, new RegExp(`"${pair[0]}"\\s*,\\s*"${pair[1]}"`));
  }
});

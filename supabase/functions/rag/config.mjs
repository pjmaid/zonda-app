export function resolveEnv(readEnv, primaryName, legacyName) {
  const primaryValue = String(readEnv(primaryName) || "");
  if (primaryValue) return primaryValue;
  return legacyName ? String(readEnv(legacyName) || "") : "";
}

export function requiredEnv(readEnv, primaryName, legacyName) {
  const value = resolveEnv(readEnv, primaryName, legacyName);
  if (!value) throw new Error(`RAG_CONFIG_MISSING_${primaryName}`);
  return value;
}

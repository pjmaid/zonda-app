const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type TextBlock = { t: "text"; text: string };
type ImageBlock = { t: "img"; mime: string; data: string };
type AiBlock = TextBlock | ImageBlock;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactText(value: string, identifiers: string[]) {
  let text = String(value || "");
  let replacements = 0;
  const replace = (pattern: RegExp, label: string) => {
    text = text.replace(pattern, () => {
      replacements += 1;
      return label;
    });
  };

  replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL OMITIDO]");
  replace(/\b(?:DNI|CUIL|CUIT|documento|doc\.?)[\s:#-]*(?:\d[ .-]?){7,11}\b/gi, "[DOCUMENTO OMITIDO]");
  replace(/\b(?:tel(?:[eé]fono)?|cel(?:ular)?|whatsapp)[\s:+()-]*(?:\d[\s().-]?){7,15}\b/gi, "[TELÉFONO OMITIDO]");
  replace(/\b(?:HC|historia\s+cl[ií]nica|n[°ºo]\s*de\s*historia)[\s:#-]*[A-Z0-9-]{5,}\b/gi, "[HISTORIA CLÍNICA OMITIDA]");

  for (const raw of identifiers) {
    const identifier = String(raw || "").trim();
    if (identifier.length < 2 || identifier.length > 100) continue;
    replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(identifier)}(?![\\p{L}\\p{N}_])`, "giu"), "[IDENTIFICADOR OMITIDO]");
  }
  return { text, replacements };
}

async function authenticate(req: Request) {
  const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || serviceKey;
  const authorization = req.headers.get("Authorization") || "";
  if (!supabaseUrl || !serviceKey || !authorization.startsWith("Bearer ")) {
    throw new Error("AUTH_REQUIRED");
  }

  const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: authorization, apikey: anonKey },
  });
  if (!userResponse.ok) throw new Error("AUTH_REQUIRED");
  const user = await userResponse.json();

  const memberResponse = await fetch(
    `${supabaseUrl}/rest/v1/ec_members?select=user_id,org_id,rol,activo&user_id=eq.${encodeURIComponent(user.id)}&activo=eq.true&limit=1`,
    { headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey } },
  );
  const members = memberResponse.ok ? await memberResponse.json() : [];
  if (!members[0]) throw new Error("MEMBERSHIP_REQUIRED");
  const member = members[0];
  const serviceHeaders = { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey };
  const siteResponse = await fetch(`${supabaseUrl}/rest/v1/ec_orgs?select=id&id=eq.${encodeURIComponent(member.org_id)}&activo=eq.true&limit=1`, {
    headers: serviceHeaders,
  });
  const sites = siteResponse.ok ? await siteResponse.json() : [];
  if (!sites[0]) throw new Error("MEMBERSHIP_REQUIRED");

  // El permiso de facturación vive en la ficha ec_users. Se consulta con la
  // service role para que la autorización no dependa de datos enviados por el cliente.
  const profileBase = `${supabaseUrl}/rest/v1/ec_users?select=data&org_id=eq.${encodeURIComponent(member.org_id)}&limit=2`;
  const profilesResponse = await fetch(`${profileBase}&data->>authId=eq.${encodeURIComponent(user.id)}`, { headers: serviceHeaders });
  if (!profilesResponse.ok) throw new Error("PROFILE_LOOKUP_FAILED");
  let profiles = await profilesResponse.json();
  if (!Array.isArray(profiles)) throw new Error("PROFILE_LOOKUP_FAILED");
  if (!profiles.length && user.email) {
    // El email solo respalda fichas legadas que todavía no tienen authId.
    const email = String(user.email).toLowerCase();
    const emailPattern = `^${escapeRegExp(email)}$`;
    const legacy = await fetch(`${profileBase}&data->>email=imatch.${encodeURIComponent(emailPattern)}&or=(data->>authId.is.null,data->>authId.eq.)`, {
      headers: serviceHeaders,
    });
    if (!legacy.ok) throw new Error("PROFILE_LOOKUP_FAILED");
    profiles = await legacy.json();
    if (!Array.isArray(profiles)) throw new Error("PROFILE_LOOKUP_FAILED");
    profiles = profiles.filter((row: { data?: Record<string, unknown> }) => !row.data?.authId && String(row.data?.email || "").toLowerCase() === email);
  }
  if (profiles.length > 1) throw new Error("PROFILE_AMBIGUOUS");
  const profile = profiles[0];
  if (profile?.data?.activo === false) throw new Error("MEMBERSHIP_REQUIRED");
  const billingAllowed = member.rol === "admin" || profile?.data?.facturacion === true;
  return { supabaseUrl, serviceKey, user, member, billingAllowed };
}

function providerConfig() {
  const provider = (Deno.env.get("AI_PROVIDER") || "openai").toLowerCase();
  const defaults: Record<string, string> = {
    openai: "gpt-5.1",
    anthropic: "claude-sonnet-5",
    gemini: "gemini-2.5-flash",
  };
  if (!defaults[provider]) throw new Error("AI_PROVIDER_INVALID");
  const keyName = provider === "openai" ? "OPENAI_API_KEY"
    : provider === "anthropic" ? "ANTHROPIC_API_KEY" : "GEMINI_API_KEY";
  const key = Deno.env.get(keyName) || "";
  if (!key) throw new Error("AI_NOT_CONFIGURED");
  return { provider, model: Deno.env.get("AI_MODEL") || defaults[provider], key };
}

async function callProvider(provider: string, model: string, key: string, system: string, blocks: AiBlock[], maxTokens: number) {
  const soloTexto = blocks.length === 1 && blocks[0].t === "text";
  let response: Response;
  if (provider === "gemini") {
    response = await providerFetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: blocks.map((b) => b.t === "img"
          ? { inlineData: { mimeType: b.mime, data: b.data } } : { text: b.text }) }],
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    });
  } else if (provider === "anthropic") {
    response = await providerFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: soloTexto ? (blocks[0] as TextBlock).text : blocks.map((b) => b.t === "img"
          ? { type: "image", source: { type: "base64", media_type: b.mime, data: b.data } }
          : { type: "text", text: b.text }) }],
      }),
    });
  } else {
    response = await providerFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        max_completion_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: soloTexto ? (blocks[0] as TextBlock).text : blocks.map((b) => b.t === "img"
            ? { type: "image_url", image_url: { url: `data:${b.mime};base64,${b.data}` } }
            : { type: "text", text: b.text }) },
        ],
      }),
    });
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    // No devolver mensajes externos que pueden incluir fragmentos del material enviado.
    throw new Error(response.status === 429 ? "AI_RATE_LIMITED" : "AI_PROVIDER_FAILED");
  }
  if (provider === "gemini") {
    const candidate = body?.candidates?.[0] || {};
    return {
      text: (candidate?.content?.parts || []).map((part: { text?: string }) => part.text || "").join("\n"),
      cut: candidate.finishReason === "MAX_TOKENS",
    };
  }
  if (provider === "anthropic") {
    return {
      text: (body?.content || []).filter((part: { type?: string }) => part.type === "text")
        .map((part: { text?: string }) => part.text || "").join("\n"),
      cut: body?.stop_reason === "max_tokens",
    };
  }
  return {
    text: body?.choices?.[0]?.message?.content || "",
    cut: body?.choices?.[0]?.finish_reason === "length",
  };
}

async function providerFetch(url: string, init: RequestInit) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    throw new Error(/TimeoutError|AbortError/.test(name) ? "AI_TIMEOUT" : "AI_PROVIDER_FAILED");
  }
}

async function appendAudit(auth: Awaited<ReturnType<typeof authenticate>>, requestId: string, detail: object, action = "generacion_asistida") {
  const response = await fetch(`${auth.supabaseUrl}/rest/v1/ec_audit`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.serviceKey}`,
      apikey: auth.serviceKey,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      org_id: auth.member.org_id,
      actor_id: auth.user.id,
      event_id: crypto.randomUUID(),
      usuario: auth.user.email || auth.user.id,
      rol: auth.member.rol || "",
      entidad: "ia",
      accion: action,
      ref_id: requestId,
      detalle: JSON.stringify(detail).slice(0, 600),
      motivo: "Salida pendiente de revisión humana",
    }),
  }).catch(() => { throw new Error("AI_AUDIT_FAILED"); });
  if (!response.ok) throw new Error("AI_AUDIT_FAILED");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  try {
    const auth = await authenticate(req);
    const input = await req.json().catch(() => { throw new Error("INVALID_CONTENT"); });
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_CONTENT");
    const config = providerConfig();
    if (input?.action === "status") {
      return json({ configured: true, provider: config.provider, model: config.model });
    }

    const purpose = String(input?.purpose || "consulta_general").toLowerCase().replace(/[^a-z0-9_.-]/g, "_").slice(0, 80);
    if (/^contrato_/.test(purpose) && !auth.billingAllowed) {
      return json({ error: "BILLING_ACCESS_REQUIRED" }, 403);
    }
    const requestedTokens = Number(input?.max_tokens);
    const maxTokens = Math.max(100, Math.min(30000, Number.isFinite(requestedTokens) ? Math.floor(requestedTokens) || 8000 : 8000));
    if (input.identifiers !== undefined && (!Array.isArray(input.identifiers)
      || input.identifiers.some((value: unknown) => typeof value !== "string" || value.trim().length < 2 || value.trim().length > 100))) throw new Error("INVALID_CONTENT");
    const identifiers: string[] = [...new Set<string>((input.identifiers || []).map((value: string) => value.trim()))];
    if (identifiers.length > 500) throw new Error("IDENTIFIERS_LIMIT_EXCEEDED");
    const rawBlocks: AiBlock[] = typeof input?.content === "string"
      ? [{ t: "text", text: input.content }]
      : Array.isArray(input?.content) ? input.content : [];
    if (!rawBlocks.length || rawBlocks.length > 80) return json({ error: "INVALID_CONTENT" }, 400);
    if (typeof input.system !== "undefined" && typeof input.system !== "string") throw new Error("INVALID_CONTENT");
    if ((input.system || "").length > 50_000 || JSON.stringify(rawBlocks).length > 20_000_000) throw new Error("CONTENT_TOO_LARGE");

    const imageCount = rawBlocks.filter((block) => block?.t === "img").length;
    if (imageCount && input?.images_confirmed_deidentified !== true) {
      return json({ error: "IMAGE_DEIDENTIFICATION_CONFIRMATION_REQUIRED" }, 400);
    }
    let redactions = 0;
    const blocks = rawBlocks.map((block): AiBlock => {
      if (block?.t === "img") {
        if (typeof block.mime !== "string" || !/^image\/(?:png|jpeg|webp)$/i.test(block.mime)
          || typeof block.data !== "string" || !block.data || block.data.length % 4 !== 0
          || !/^[A-Za-z0-9+/]+={0,2}$/.test(block.data)) throw new Error("INVALID_IMAGE");
        return { t: "img", mime: block.mime.toLowerCase(), data: block.data };
      }
      if (block?.t !== "text" || typeof block.text !== "string" || !block.text.trim()) throw new Error("INVALID_CONTENT");
      if (block.text.length > 1_000_000) throw new Error("CONTENT_TOO_LARGE");
      const clean = redactText(block.text, identifiers);
      redactions += clean.replacements;
      return { t: "text", text: clean.text };
    });
    const cleanSystem = redactText(String(input?.system || ""), identifiers);
    redactions += cleanSystem.replacements;
    const system = `${cleanSystem.text} Basá todo exclusivamente en el material provisto. No uses conocimiento externo. Si falta un dato, indicá que no está. La salida es un borrador asistido por IA y requiere revisión humana.`;
    const requestId = crypto.randomUUID();
    const auditDetail = {
      purpose,
      provider: config.provider,
      model: config.model,
      redactions,
      images: imageCount,
      human_review_required: true,
    };
    // Registrar la intención antes de transmitir material a un proveedor externo.
    await appendAudit(auth, requestId, auditDetail, "generacion_solicitada");
    let result: { text: string; cut: boolean };
    try {
      result = await callProvider(config.provider, config.model, config.key, system, blocks, maxTokens);
      if (typeof result.text !== "string" || !result.text.trim()) throw new Error("AI_EMPTY_RESPONSE");
    } catch (error) {
      await appendAudit(auth, requestId, { ...auditDetail, status: "failed" }, "generacion_fallida").catch(() => {});
      throw error;
    }
    let auditPending = false;
    try {
      await appendAudit(auth, requestId, auditDetail);
    } catch {
      // Conservar el resultado y el identificador evita pagar/enviar nuevamente
      // una generación que sí se completó. La intención ya está registrada.
      auditPending = true;
    }
    return json({
      ...result,
      meta: {
        request_id: requestId,
        audit_pending: auditPending,
        provider: config.provider,
        model: config.model,
        purpose,
        redactions,
        images_not_machine_redacted: imageCount,
        human_review_required: true,
        label: "Borrador generado con asistencia de IA — requiere revisión humana",
      },
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "INTERNAL_ERROR";
    const knownCodes = new Set(["AUTH_REQUIRED", "MEMBERSHIP_REQUIRED", "AI_NOT_CONFIGURED", "AI_PROVIDER_INVALID", "AI_AUDIT_FAILED", "AI_PROVIDER_FAILED", "AI_RATE_LIMITED", "AI_TIMEOUT", "AI_EMPTY_RESPONSE", "INVALID_CONTENT", "INVALID_IMAGE", "CONTENT_TOO_LARGE", "IDENTIFIERS_LIMIT_EXCEEDED", "PROFILE_LOOKUP_FAILED", "PROFILE_AMBIGUOUS"]);
    const message = knownCodes.has(code) ? code : "INTERNAL_ERROR";
    const status = /AUTH_REQUIRED|MEMBERSHIP_REQUIRED/.test(message) ? 401
      : /INVALID_CONTENT|INVALID_IMAGE|IDENTIFIERS_LIMIT_EXCEEDED/.test(message) ? 400
      : message === "CONTENT_TOO_LARGE" ? 413
      : message === "AI_TIMEOUT" ? 504
      : message === "AI_RATE_LIMITED" ? 429
      : /AI_PROVIDER_FAILED|AI_EMPTY_RESPONSE/.test(message) ? 502
      : /AI_NOT_CONFIGURED/.test(message) ? 503 : 500;
    return json({ error: message }, status);
  }
});

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
  replace(/\b(?:tel(?:e(?:fono|fono))?|cel(?:ular)?|whatsapp)[\s:+()-]*(?:\d[\s().-]?){7,15}\b/gi, "[TELÉFONO OMITIDO]");
  replace(/\b(?:HC|historia\s+cl[ií]nica|n[°ºo]\s*de\s*historia)[\s:#-]*[A-Z0-9-]{5,}\b/gi, "[HISTORIA CLÍNICA OMITIDA]");

  for (const raw of identifiers.slice(0, 50)) {
    const identifier = String(raw || "").trim();
    if (identifier.length < 3 || identifier.length > 100) continue;
    replace(new RegExp(`\\b${escapeRegExp(identifier)}\\b`, "giu"), "[IDENTIFICADOR OMITIDO]");
  }
  return { text, replacements };
}

async function authenticate(req: Request) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
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
  return { supabaseUrl, serviceKey, user, member: members[0] };
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
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
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
    response = await fetch("https://api.anthropic.com/v1/messages", {
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
    response = await fetch("https://api.openai.com/v1/chat/completions", {
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
    const detail = body?.error?.message || body?.error?.status || `AI_HTTP_${response.status}`;
    throw new Error(String(detail).slice(0, 300));
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

async function appendAudit(auth: Awaited<ReturnType<typeof authenticate>>, requestId: string, detail: object) {
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
      event_id: requestId,
      usuario: auth.user.email || auth.user.id,
      rol: auth.member.rol || "",
      entidad: "ia",
      accion: "generacion_asistida",
      ref_id: requestId,
      detalle: JSON.stringify(detail).slice(0, 600),
      motivo: "Salida pendiente de revisión humana",
    }),
  });
  if (!response.ok) throw new Error("AI_AUDIT_FAILED");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  try {
    const auth = await authenticate(req);
    const input = await req.json();
    const config = providerConfig();
    if (input?.action === "status") {
      return json({ configured: true, provider: config.provider, model: config.model });
    }

    const purpose = String(input?.purpose || "consulta_general").replace(/[^a-z0-9_.-]/gi, "_").slice(0, 80);
    const maxTokens = Math.max(100, Math.min(30000, Number(input?.max_tokens) || 8000));
    const identifiers = Array.isArray(input?.identifiers) ? input.identifiers.map(String) : [];
    const rawBlocks: AiBlock[] = typeof input?.content === "string"
      ? [{ t: "text", text: input.content }]
      : Array.isArray(input?.content) ? input.content : [];
    if (!rawBlocks.length || rawBlocks.length > 80) return json({ error: "INVALID_CONTENT" }, 400);

    const imageCount = rawBlocks.filter((block) => block?.t === "img").length;
    if (imageCount && input?.images_confirmed_deidentified !== true) {
      return json({ error: "IMAGE_DEIDENTIFICATION_CONFIRMATION_REQUIRED" }, 400);
    }
    let redactions = 0;
    const blocks = rawBlocks.map((block): AiBlock => {
      if (block?.t === "img") {
        if (!/^image\/(?:png|jpeg|webp)$/i.test(block.mime || "") || !block.data) throw new Error("INVALID_IMAGE");
        return { t: "img", mime: block.mime, data: block.data };
      }
      const clean = redactText(String((block as TextBlock)?.text || ""), identifiers);
      redactions += clean.replacements;
      return { t: "text", text: clean.text };
    });
    const cleanSystem = redactText(String(input?.system || ""), identifiers);
    redactions += cleanSystem.replacements;
    const system = `${cleanSystem.text} Basá todo exclusivamente en el material provisto. No uses conocimiento externo. Si falta un dato, indicá que no está. La salida es un borrador asistido por IA y requiere revisión humana.`;
    const requestId = crypto.randomUUID();
    const result = await callProvider(config.provider, config.model, config.key, system, blocks, maxTokens);
    await appendAudit(auth, requestId, {
      purpose,
      provider: config.provider,
      model: config.model,
      redactions,
      images: imageCount,
      human_review_required: true,
    });
    return json({
      ...result,
      meta: {
        request_id: requestId,
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
    const message = error instanceof Error ? error.message : "INTERNAL_ERROR";
    const status = /AUTH_REQUIRED|MEMBERSHIP_REQUIRED/.test(message) ? 401
      : /AI_NOT_CONFIGURED/.test(message) ? 503 : 500;
    return json({ error: message }, status);
  }
});

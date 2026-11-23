const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Member = {
  user_id: string;
  org_id: string;
  rol: "admin" | "medico" | "coord";
  superadmin: boolean;
  activo: boolean;
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});

function env(name: string) {
  const value = Deno.env.get(name) || "";
  if (!value) throw new Error(`Falta el secreto ${name}.`);
  return value;
}

function serviceHeaders(serviceKey: string, extra: Record<string, string> = {}) {
  return {
    Authorization: `Bearer ${serviceKey}`,
    apikey: serviceKey,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function responseJson(response: Response) {
  return await response.json().catch(() => ({}));
}

async function requireAdministrator(req: Request) {
  const supabaseUrl = env("SUPABASE_URL").replace(/\/+$/, "");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || serviceKey;
  const authorization = req.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) throw new Error("AUTH_REQUIRED");

  const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: authorization, apikey: anonKey },
  });
  if (!userResponse.ok) throw new Error("AUTH_REQUIRED");
  const user = await responseJson(userResponse);

  const memberResponse = await fetch(
    `${supabaseUrl}/rest/v1/ec_members?select=user_id,org_id,rol,superadmin,activo&user_id=eq.${encodeURIComponent(user.id)}&activo=eq.true&limit=1`,
    { headers: serviceHeaders(serviceKey) },
  );
  const members = memberResponse.ok ? await responseJson(memberResponse) : [];
  const member = members[0] as Member | undefined;
  if (!member) throw new Error("MEMBERSHIP_REQUIRED");
  if (member.rol !== "admin" && !member.superadmin) throw new Error("ADMIN_REQUIRED");
  const siteResponse = await fetch(`${supabaseUrl}/rest/v1/ec_orgs?select=id&id=eq.${encodeURIComponent(member.org_id)}&activo=eq.true&limit=1`, {
    headers: serviceHeaders(serviceKey),
  });
  const sites = siteResponse.ok ? await responseJson(siteResponse) : [];
  if (!sites[0]) throw new Error("MEMBERSHIP_REQUIRED");
  return { supabaseUrl, serviceKey, user, member };
}

function validEmail(value: unknown) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("EMAIL_INVALID");
  return email;
}

function validRole(value: unknown): Member["rol"] {
  if (value !== "admin" && value !== "medico" && value !== "coord") throw new Error("ROLE_INVALID");
  return value;
}

function validTemporaryPassword(value: unknown) {
  const password = String(value || "");
  const ok = password.length >= 12 && /[A-ZÁÉÍÓÚÑ]/.test(password) && /[a-záéíóúñ]/.test(password) && /\d/.test(password) && /[^A-Za-z0-9]/.test(password);
  if (!ok) throw new Error("PASSWORD_WEAK");
  return password;
}

function invitationPath(redirect: unknown) {
  const appUrl = new URL(Deno.env.get("APP_URL") || "https://zonda-app.pages.dev/");
  let destination: URL;
  try {
    destination = new URL(String(redirect || appUrl.href));
  } catch {
    throw new Error("REDIRECT_INVALID");
  }
  if (destination.origin !== appUrl.origin || destination.protocol !== "https:" || destination.username || destination.password) {
    throw new Error("REDIRECT_INVALID");
  }
  // No reenviar tokens, parámetros de recuperación ni fragmentos de la sesión del administrador.
  destination.search = "";
  destination.hash = "";
  return `invite?redirect_to=${encodeURIComponent(destination.href)}`;
}

async function validStudies(ctx: Awaited<ReturnType<typeof requireAdministrator>>, value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100 || value.some((id) => typeof id !== "string" || !/^[a-z0-9_-]{1,160}$/i.test(id))) {
    throw new Error("STUDIES_INVALID");
  }
  const ids = [...new Set(value)] as string[];
  if (!ids.length) return ids;
  const response = await fetch(
    `${ctx.supabaseUrl}/rest/v1/ec_studies?select=id&org_id=eq.${encodeURIComponent(ctx.member.org_id)}&id=in.(${ids.map(encodeURIComponent).join(",")})`,
    { headers: serviceHeaders(ctx.serviceKey) },
  );
  if (!response.ok) throw new Error("STUDIES_LOOKUP_FAILED");
  const rows = await responseJson(response);
  const found = new Set(Array.isArray(rows) ? rows.map((row: { id: string }) => row.id) : []);
  if (ids.some((id) => !found.has(id))) throw new Error("STUDIES_INVALID");
  return ids;
}

async function targetMember(ctx: Awaited<ReturnType<typeof requireAdministrator>>, authId: unknown) {
  const id = String(authId || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("USER_INVALID");
  const response = await fetch(
    `${ctx.supabaseUrl}/rest/v1/ec_members?select=user_id,org_id,rol,superadmin,activo&user_id=eq.${encodeURIComponent(id)}&limit=1`,
    { headers: serviceHeaders(ctx.serviceKey) },
  );
  const rows = response.ok ? await responseJson(response) : [];
  const target = rows[0] as Member | undefined;
  if (!target) throw new Error("USER_NOT_FOUND");
  if (!ctx.member.superadmin && target.org_id !== ctx.member.org_id) throw new Error("USER_OUTSIDE_SITE");
  if (target.superadmin && !ctx.member.superadmin) throw new Error("SUPERADMIN_TARGET_FORBIDDEN");
  return target;
}

async function audit(ctx: Awaited<ReturnType<typeof requireAdministrator>>, action: string, refId: string, detail: string) {
  const response = await fetch(`${ctx.supabaseUrl}/rest/v1/ec_audit`, {
    method: "POST",
    headers: serviceHeaders(ctx.serviceKey, { Prefer: "return=minimal" }),
    body: JSON.stringify({
      org_id: ctx.member.org_id,
      usuario: ctx.user.email || ctx.user.id,
      rol: ctx.member.rol,
      entidad: "usuarios",
      accion: action,
      ref_id: refId,
      detalle: detail.slice(0, 500),
      motivo: "Administración de acceso",
    }),
  }).catch(() => { throw new Error("AUDIT_WRITE_FAILED"); });
  if (!response.ok) throw new Error("AUDIT_WRITE_FAILED");
}

async function completed(ctx: Awaited<ReturnType<typeof requireAdministrator>>, action: string, refId: string, detail: string, mensaje: string) {
  try {
    await audit(ctx, action, refId, detail);
    return { mensaje, applied: true, audit_pending: false };
  } catch {
    // La intención quedó registrada antes de mutar. Un fallo al registrar el
    // resultado no revierte Auth ni debe invitar a repetir una operación aplicada.
    return { mensaje: `${mensaje} La operación se aplicó; el registro final de auditoría quedó pendiente. No repitas la operación.`, applied: true, audit_pending: true };
  }
}

async function createUser(ctx: Awaited<ReturnType<typeof requireAdministrator>>, input: Record<string, unknown>) {
  const email = validEmail(input.email);
  const role = validRole(input.rol);
  const password = input.claveTemporal ? validTemporaryPassword(input.claveTemporal) : "";
  const authPath = password ? "admin/users" : invitationPath(input.redirect);
  const studies = await validStudies(ctx, input.estudios);
  const profileId = crypto.randomUUID();
  await audit(ctx, "alta solicitada", profileId, `Usuario ${email}; rol ${role}`);
  const authResponse = await fetch(`${ctx.supabaseUrl}/auth/v1/${authPath}`, {
    method: "POST",
    headers: serviceHeaders(ctx.serviceKey),
    body: JSON.stringify(password
      ? { email, password, email_confirm: true, user_metadata: { clave_temporal: true } }
      : { email, data: { clave_temporal: false } }),
  });
  const authBody = await responseJson(authResponse);
  const authUser = authBody.user || authBody;
  if (!authResponse.ok || !authUser?.id) throw new Error("USER_CREATE_FAILED");

  const profile = {
    id: profileId,
    authId: authUser.id,
    email,
    nombre: String(input.nombre || "").trim().slice(0, 160) || email,
    rol: role,
    estudios: studies,
    facturacion: role === "admin" || input.facturacion === true,
    activo: true,
    creado: new Date().toISOString(),
  };

  try {
    const membership = await fetch(`${ctx.supabaseUrl}/rest/v1/ec_members`, {
      method: "POST",
      headers: serviceHeaders(ctx.serviceKey, { Prefer: "return=minimal" }),
      body: JSON.stringify({ user_id: authUser.id, org_id: ctx.member.org_id, rol: role, activo: true }),
    });
    if (!membership.ok) throw new Error("MEMBERSHIP_CREATE_FAILED");
    const profileResponse = await fetch(`${ctx.supabaseUrl}/rest/v1/ec_users`, {
      method: "POST",
      headers: serviceHeaders(ctx.serviceKey, { Prefer: "return=minimal" }),
      body: JSON.stringify({ id: profileId, org_id: ctx.member.org_id, data: profile }),
    });
    if (!profileResponse.ok) throw new Error("PROFILE_CREATE_FAILED");
  } catch (error) {
    const rollback = await fetch(`${ctx.supabaseUrl}/auth/v1/admin/users/${authUser.id}`, {
      method: "DELETE",
      headers: serviceHeaders(ctx.serviceKey),
    }).catch(() => null);
    if (!rollback?.ok) throw new Error("ROLLBACK_INCOMPLETE");
    throw error;
  }

  return completed(ctx, "alta", profileId, `Usuario ${email}; rol ${role}`,
    password ? "Usuario creado con clave temporal." : "Usuario creado; se envió la invitación por email.");
}

async function createOrganization(ctx: Awaited<ReturnType<typeof requireAdministrator>>, input: Record<string, unknown>) {
  if (!ctx.member.superadmin) throw new Error("SUPERADMIN_REQUIRED");
  const name = String(input.nombre || "").trim();
  if (name.length < 3 || name.length > 160) throw new Error("ORGANIZATION_INVALID");
  const email = validEmail(input.email);
  const password = input.claveTemporal ? validTemporaryPassword(input.claveTemporal) : "";
  const authPath = password ? "admin/users" : invitationPath(input.redirect);
  const requestId = crypto.randomUUID();
  await audit(ctx, "alta de sitio solicitada", requestId, `Sitio ${name}; administrador ${email}`);

  const orgResponse = await fetch(`${ctx.supabaseUrl}/rest/v1/ec_orgs?select=id`, {
    method: "POST",
    headers: serviceHeaders(ctx.serviceKey, { Prefer: "return=representation" }),
    body: JSON.stringify({ nombre: name, contacto: email, activo: true }),
  });
  const orgRows = await responseJson(orgResponse);
  const orgId = orgRows?.[0]?.id;
  if (!orgResponse.ok || !orgId) throw new Error("ORGANIZATION_CREATE_FAILED");

  let authId = "";
  try {
    const authResponse = await fetch(`${ctx.supabaseUrl}/auth/v1/${authPath}`, {
      method: "POST",
      headers: serviceHeaders(ctx.serviceKey),
      body: JSON.stringify(password
        ? { email, password, email_confirm: true, user_metadata: { clave_temporal: true } }
        : { email, data: { clave_temporal: false } }),
    });
    const authBody = await responseJson(authResponse);
    const authUser = authBody.user || authBody;
    if (!authResponse.ok || !authUser?.id) throw new Error("USER_CREATE_FAILED");
    authId = authUser.id;

    const profileId = crypto.randomUUID();
    const membership = await fetch(`${ctx.supabaseUrl}/rest/v1/ec_members`, {
      method: "POST",
      headers: serviceHeaders(ctx.serviceKey, { Prefer: "return=minimal" }),
      body: JSON.stringify({ user_id: authId, org_id: orgId, rol: "admin", activo: true }),
    });
    if (!membership.ok) throw new Error("MEMBERSHIP_CREATE_FAILED");
    const profile = {
      id: profileId, authId, email,
      nombre: String(input.nombreAdmin || "").trim().slice(0, 160) || email,
      rol: "admin", estudios: [], facturacion: true, activo: true,
      creado: new Date().toISOString(),
    };
    const profileResponse = await fetch(`${ctx.supabaseUrl}/rest/v1/ec_users`, {
      method: "POST",
      headers: serviceHeaders(ctx.serviceKey, { Prefer: "return=minimal" }),
      body: JSON.stringify({ id: profileId, org_id: orgId, data: profile }),
    });
    if (!profileResponse.ok) throw new Error("PROFILE_CREATE_FAILED");
  } catch (error) {
    const authRollback = authId ? await fetch(`${ctx.supabaseUrl}/auth/v1/admin/users/${authId}`, {
      method: "DELETE", headers: serviceHeaders(ctx.serviceKey),
    }).catch(() => null) : null;
    const orgRollback = await fetch(`${ctx.supabaseUrl}/rest/v1/ec_orgs?id=eq.${encodeURIComponent(orgId)}`, {
      method: "DELETE", headers: serviceHeaders(ctx.serviceKey, { Prefer: "return=minimal" }),
    }).catch(() => null);
    if ((authId && !authRollback?.ok) || !orgRollback?.ok) throw new Error("ROLLBACK_INCOMPLETE");
    throw error;
  }

  return completed(ctx, "alta de sitio", orgId, `Sitio ${name}; administrador ${email}`,
    password ? "Sitio creado con una clave temporal para su administrador." : "Sitio creado; se envió la invitación al administrador.");
}

async function changePassword(ctx: Awaited<ReturnType<typeof requireAdministrator>>, input: Record<string, unknown>) {
  const target = await targetMember(ctx, input.authId);
  const password = validTemporaryPassword(input.claveTemporal);
  await audit(ctx, "cambio de clave solicitado", target.user_id, "Asignación de clave temporal; contenido no registrado");
  const response = await fetch(`${ctx.supabaseUrl}/auth/v1/admin/users/${target.user_id}`, {
    method: "PUT",
    headers: serviceHeaders(ctx.serviceKey),
    body: JSON.stringify({ password, user_metadata: { clave_temporal: true } }),
  });
  if (!response.ok) throw new Error("PASSWORD_UPDATE_FAILED");
  return completed(ctx, "cambio de clave", target.user_id, "Clave temporal asignada; contenido no registrado",
    "Clave cambiada. El usuario deberá reemplazarla al iniciar sesión.");
}

async function targetProfiles(ctx: Awaited<ReturnType<typeof requireAdministrator>>, target: Member, requestedId: unknown) {
  const base = `${ctx.supabaseUrl}/rest/v1/ec_users?select=id,data&org_id=eq.${encodeURIComponent(target.org_id)}`;
  const response = await fetch(`${base}&data->>authId=eq.${encodeURIComponent(target.user_id)}`, {
    headers: serviceHeaders(ctx.serviceKey),
  });
  if (!response.ok) throw new Error("PROFILE_LOOKUP_FAILED");
  let profiles = await responseJson(response);
  if (!Array.isArray(profiles)) throw new Error("PROFILE_LOOKUP_FAILED");
  // Respaldo exclusivamente para fichas anteriores al vínculo authId.
  if (!profiles.length) {
    const authResponse = await fetch(`${ctx.supabaseUrl}/auth/v1/admin/users/${target.user_id}`, {
      headers: serviceHeaders(ctx.serviceKey),
    });
    if (!authResponse.ok) throw new Error("PROFILE_LOOKUP_FAILED");
    const body = await responseJson(authResponse);
    const email = String((body.user || body).email || "").toLowerCase();
    if (email) {
      const emailPattern = `^${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
      const legacy = await fetch(`${base}&data->>email=imatch.${encodeURIComponent(emailPattern)}&or=(data->>authId.is.null,data->>authId.eq.)`, {
        headers: serviceHeaders(ctx.serviceKey),
      });
      if (!legacy.ok) throw new Error("PROFILE_LOOKUP_FAILED");
      profiles = await responseJson(legacy);
      if (!Array.isArray(profiles)) throw new Error("PROFILE_LOOKUP_FAILED");
      profiles = profiles.filter((row: { data?: Record<string, unknown> }) => !row.data?.authId && String(row.data?.email || "").toLowerCase() === email);
    }
  }
  if (requestedId && !profiles.some((row: { id: string }) => row.id === requestedId)) throw new Error("PROFILE_MISMATCH_FORBIDDEN");
  return profiles as { id: string }[];
}

async function deleteUser(ctx: Awaited<ReturnType<typeof requireAdministrator>>, input: Record<string, unknown>) {
  const target = await targetMember(ctx, input.authId);
  if (target.user_id === ctx.user.id) throw new Error("SELF_DELETE_FORBIDDEN");
  const profiles = await targetProfiles(ctx, target, input.profileId);
  if (target.rol === "admin" && target.activo) {
    const response = await fetch(
      `${ctx.supabaseUrl}/rest/v1/ec_members?select=user_id&org_id=eq.${encodeURIComponent(target.org_id)}&rol=eq.admin&activo=eq.true`,
      { headers: serviceHeaders(ctx.serviceKey) },
    );
    const admins = response.ok ? await responseJson(response) : [];
    if (admins.length <= 1) throw new Error("LAST_ADMIN_FORBIDDEN");
  }

  await audit(ctx, "baja solicitada", target.user_id, "Eliminación de cuenta y asignaciones; datos clínicos conservados");

  const response = await fetch(`${ctx.supabaseUrl}/auth/v1/admin/users/${target.user_id}`, {
    method: "DELETE",
    headers: serviceHeaders(ctx.serviceKey),
  });
  if (!response.ok) throw new Error("USER_DELETE_FAILED");

  for (const profile of profiles) {
    const profileResponse = await fetch(`${ctx.supabaseUrl}/rest/v1/ec_users?id=eq.${encodeURIComponent(profile.id)}&org_id=eq.${encodeURIComponent(target.org_id)}`, {
      method: "DELETE",
      headers: serviceHeaders(ctx.serviceKey, { Prefer: "return=minimal" }),
    }).catch(() => null);
    if (!profileResponse?.ok) {
      const result = await completed(ctx, "baja parcial", target.user_id, "Cuenta de acceso eliminada; limpieza de ficha pendiente",
        "La cuenta de acceso fue eliminada. Quedó pendiente la limpieza de su ficha; no repitas la baja.");
      return { ...result, cleanup_pending: true };
    }
  }
  return completed(ctx, "baja", target.user_id, "Cuenta de acceso y asignaciones eliminadas; datos clínicos conservados", "Usuario eliminado definitivamente.");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  try {
    const ctx = await requireAdministrator(req);
    const input = await req.json().catch(() => { throw new Error("INPUT_INVALID"); }) as Record<string, unknown>;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("INPUT_INVALID");
    const action = String(input.accion || "");
    if (action === "usuario") return json(await createUser(ctx, input));
    if (action === "organizacion") return json(await createOrganization(ctx, input));
    if (action === "cambiar_clave") return json(await changePassword(ctx, input));
    if (action === "eliminar_usuario") return json(await deleteUser(ctx, input));
    return json({ error: "ACTION_INVALID" }, 400);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    const code = /^[A-Z_]{3,60}$/.test(detail) ? detail : "INTERNAL_ERROR";
    const messages: Record<string, string> = {
      AUTH_REQUIRED: "La sesión venció. Volvé a ingresar.",
      MEMBERSHIP_REQUIRED: "Tu cuenta no pertenece a un sitio activo.",
      ADMIN_REQUIRED: "Solo un administrador puede gestionar usuarios.",
      SUPERADMIN_REQUIRED: "Solo un superadministrador puede crear sitios.",
      ORGANIZATION_INVALID: "Escribí un nombre de sitio válido.",
      EMAIL_INVALID: "Escribí un email válido.",
      ROLE_INVALID: "El rol seleccionado no es válido.",
      PASSWORD_WEAK: "La clave debe tener 12+ caracteres, mayúscula, minúscula, número y símbolo.",
      USER_INVALID: "El usuario seleccionado no es válido.",
      USER_NOT_FOUND: "La cuenta de acceso ya no existe.",
      USER_OUTSIDE_SITE: "No podés administrar usuarios de otro sitio.",
      SELF_DELETE_FORBIDDEN: "No podés eliminar tu propio usuario.",
      LAST_ADMIN_FORBIDDEN: "Tiene que quedar al menos un administrador activo.",
      SUPERADMIN_TARGET_FORBIDDEN: "Solo un superadministrador puede modificar esta cuenta.",
      PROFILE_MISMATCH_FORBIDDEN: "La ficha seleccionada no corresponde a la cuenta de acceso.",
      REDIRECT_INVALID: "La dirección de regreso debe pertenecer a Zonda.",
      STUDIES_INVALID: "Los estudios asignados deben existir en tu sitio.",
      INPUT_INVALID: "La solicitud no tiene un formato válido.",
      USER_CREATE_FAILED: "No se pudo crear la cuenta. Revisá si el email ya está registrado.",
      PASSWORD_UPDATE_FAILED: "No se pudo actualizar la clave. Volvé a intentar.",
      USER_DELETE_FAILED: "No se pudo eliminar la cuenta de acceso.",
      ROLLBACK_INCOMPLETE: "El alta quedó incompleta y no se pudo revertir por completo. Revisá la cuenta y el sitio antes de reintentar.",
      AUDIT_WRITE_FAILED: "No se pudo registrar la operación en la auditoría; no se aplicaron cambios de acceso.",
    };
    const status = /AUTH_REQUIRED|MEMBERSHIP_REQUIRED/.test(code) ? 401
      : /ADMIN_REQUIRED|SUPERADMIN_REQUIRED|SUPERADMIN_TARGET_FORBIDDEN/.test(code) ? 403
      : /INVALID|WEAK|FORBIDDEN|OUTSIDE|NOT_FOUND|OWN_PASSWORD/.test(code) ? 400 : 500;
    return json({ error: messages[code] || "No se pudo completar la operación. Volvé a intentar.", code,
      ...(code === "ROLLBACK_INCOMPLETE" ? { applied: "partial" } : {}) }, status);
  }
});

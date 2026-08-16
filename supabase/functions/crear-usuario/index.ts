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

async function targetMember(ctx: Awaited<ReturnType<typeof requireAdministrator>>, authId: unknown) {
  const id = String(authId || "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("USER_INVALID");
  const response = await fetch(
    `${ctx.supabaseUrl}/rest/v1/ec_members?select=user_id,org_id,rol,superadmin,activo&user_id=eq.${encodeURIComponent(id)}&limit=1`,
    { headers: serviceHeaders(ctx.serviceKey) },
  );
  const rows = response.ok ? await responseJson(response) : [];
  const target = rows[0] as Member | undefined;
  if (!target) throw new Error("USER_NOT_FOUND");
  if (!ctx.member.superadmin && target.org_id !== ctx.member.org_id) throw new Error("USER_OUTSIDE_SITE");
  return target;
}

async function audit(ctx: Awaited<ReturnType<typeof requireAdministrator>>, action: string, refId: string, detail: string) {
  await fetch(`${ctx.supabaseUrl}/rest/v1/ec_audit`, {
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
  });
}

async function createUser(ctx: Awaited<ReturnType<typeof requireAdministrator>>, input: Record<string, unknown>) {
  const email = validEmail(input.email);
  const role = validRole(input.rol);
  const password = input.claveTemporal ? validTemporaryPassword(input.claveTemporal) : "";
  const authResponse = await fetch(`${ctx.supabaseUrl}/auth/v1/${password ? "admin/users" : "invite"}`, {
    method: "POST",
    headers: serviceHeaders(ctx.serviceKey),
    body: JSON.stringify(password
      ? { email, password, email_confirm: true, user_metadata: { clave_temporal: true } }
      : { email, redirect_to: String(input.redirect || ""), data: { clave_temporal: false } }),
  });
  const authBody = await responseJson(authResponse);
  const authUser = authBody.user || authBody;
  if (!authResponse.ok || !authUser?.id) throw new Error(authBody.msg || authBody.message || "USER_CREATE_FAILED");

  const profileId = crypto.randomUUID();
  const profile = {
    id: profileId,
    authId: authUser.id,
    email,
    nombre: String(input.nombre || "").trim() || email,
    rol: role,
    estudios: Array.isArray(input.estudios) ? input.estudios.map(String) : [],
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
    await fetch(`${ctx.supabaseUrl}/auth/v1/admin/users/${authUser.id}`, {
      method: "DELETE",
      headers: serviceHeaders(ctx.serviceKey),
    });
    throw error;
  }

  await audit(ctx, "alta", profileId, `Usuario ${email}; rol ${role}`);
  return { mensaje: password ? "Usuario creado con clave temporal." : "Usuario creado; se envió la invitación por email." };
}

async function createOrganization(ctx: Awaited<ReturnType<typeof requireAdministrator>>, input: Record<string, unknown>) {
  if (!ctx.member.superadmin) throw new Error("SUPERADMIN_REQUIRED");
  const name = String(input.nombre || "").trim();
  if (name.length < 3 || name.length > 160) throw new Error("ORGANIZATION_INVALID");
  const email = validEmail(input.email);
  const password = input.claveTemporal ? validTemporaryPassword(input.claveTemporal) : "";

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
    const authResponse = await fetch(`${ctx.supabaseUrl}/auth/v1/${password ? "admin/users" : "invite"}`, {
      method: "POST",
      headers: serviceHeaders(ctx.serviceKey),
      body: JSON.stringify(password
        ? { email, password, email_confirm: true, user_metadata: { clave_temporal: true } }
        : { email, redirect_to: String(input.redirect || ""), data: { clave_temporal: false } }),
    });
    const authBody = await responseJson(authResponse);
    const authUser = authBody.user || authBody;
    if (!authResponse.ok || !authUser?.id) throw new Error(authBody.msg || authBody.message || "USER_CREATE_FAILED");
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
      nombre: String(input.nombreAdmin || "").trim() || email,
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
    if (authId) await fetch(`${ctx.supabaseUrl}/auth/v1/admin/users/${authId}`, {
      method: "DELETE", headers: serviceHeaders(ctx.serviceKey),
    });
    await fetch(`${ctx.supabaseUrl}/rest/v1/ec_orgs?id=eq.${encodeURIComponent(orgId)}`, {
      method: "DELETE", headers: serviceHeaders(ctx.serviceKey, { Prefer: "return=minimal" }),
    });
    throw error;
  }

  await audit(ctx, "alta de sitio", orgId, `Sitio ${name}; administrador ${email}`);
  return { mensaje: password ? "Sitio creado con una clave temporal para su administrador." : "Sitio creado; se envió la invitación al administrador." };
}

async function changePassword(ctx: Awaited<ReturnType<typeof requireAdministrator>>, input: Record<string, unknown>) {
  const target = await targetMember(ctx, input.authId);
  const password = validTemporaryPassword(input.claveTemporal);
  const response = await fetch(`${ctx.supabaseUrl}/auth/v1/admin/users/${target.user_id}`, {
    method: "PUT",
    headers: serviceHeaders(ctx.serviceKey),
    body: JSON.stringify({ password, user_metadata: { clave_temporal: true } }),
  });
  const body = await responseJson(response);
  if (!response.ok) throw new Error(body.msg || body.message || "PASSWORD_UPDATE_FAILED");
  await audit(ctx, "cambio de clave", target.user_id, "Clave temporal asignada; contenido no registrado");
  return { mensaje: "Clave cambiada. El usuario deberá reemplazarla al iniciar sesión." };
}

async function deleteUser(ctx: Awaited<ReturnType<typeof requireAdministrator>>, input: Record<string, unknown>) {
  const target = await targetMember(ctx, input.authId);
  if (target.user_id === ctx.user.id) throw new Error("SELF_DELETE_FORBIDDEN");
  if (target.rol === "admin" && target.activo) {
    const response = await fetch(
      `${ctx.supabaseUrl}/rest/v1/ec_members?select=user_id&org_id=eq.${encodeURIComponent(target.org_id)}&rol=eq.admin&activo=eq.true`,
      { headers: serviceHeaders(ctx.serviceKey) },
    );
    const admins = response.ok ? await responseJson(response) : [];
    if (admins.length <= 1) throw new Error("LAST_ADMIN_FORBIDDEN");
  }

  const response = await fetch(`${ctx.supabaseUrl}/auth/v1/admin/users/${target.user_id}`, {
    method: "DELETE",
    headers: serviceHeaders(ctx.serviceKey),
  });
  const body = await responseJson(response);
  if (!response.ok) throw new Error(body.msg || body.message || "USER_DELETE_FAILED");

  const profileId = String(input.profileId || "");
  if (profileId) {
    await fetch(`${ctx.supabaseUrl}/rest/v1/ec_users?id=eq.${encodeURIComponent(profileId)}&org_id=eq.${encodeURIComponent(target.org_id)}`, {
      method: "DELETE",
      headers: serviceHeaders(ctx.serviceKey, { Prefer: "return=minimal" }),
    });
  }
  await audit(ctx, "baja", target.user_id, "Cuenta de acceso y asignaciones eliminadas; datos clínicos conservados");
  return { mensaje: "Usuario eliminado definitivamente." };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  try {
    const ctx = await requireAdministrator(req);
    const input = await req.json() as Record<string, unknown>;
    const action = String(input.accion || "");
    if (action === "usuario") return json(await createUser(ctx, input));
    if (action === "organizacion") return json(await createOrganization(ctx, input));
    if (action === "cambiar_clave") return json(await changePassword(ctx, input));
    if (action === "eliminar_usuario") return json(await deleteUser(ctx, input));
    return json({ error: "ACTION_INVALID" }, 400);
  } catch (error) {
    const code = error instanceof Error ? error.message : "INTERNAL_ERROR";
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
    };
    const status = /AUTH_REQUIRED|MEMBERSHIP_REQUIRED/.test(code) ? 401
      : /ADMIN_REQUIRED|SUPERADMIN_REQUIRED/.test(code) ? 403
      : /INVALID|WEAK|FORBIDDEN|OUTSIDE|NOT_FOUND|OWN_PASSWORD/.test(code) ? 400 : 500;
    return json({ error: messages[code] || code }, status);
  }
});

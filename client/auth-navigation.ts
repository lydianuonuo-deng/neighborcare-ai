import type { AccountRole } from "../shared/auth";

export function destinationAfterLogin(
  role: AccountRole,
  requested?: string | null,
) {
  const fallback = role === "resident" ? "/" : "/staff";
  if (!requested || !requested.startsWith("/") || /[\\%\r\n]/.test(requested))
    return fallback;
  const path = requested.split("?")[0];
  if (path === "/account") return requested;
  if (role === "resident")
    return /^(?:\/|\/new|\/tickets(?:\/[\w-]+)?)$/.test(path)
      ? requested
      : fallback;
  if (path === "/staff/users") return role === "admin" ? requested : fallback;
  return /^\/staff(?:\/(?:tickets(?:\/[\w-]+)?|board|analytics|help))?$/.test(
    path,
  )
    ? requested
    : fallback;
}

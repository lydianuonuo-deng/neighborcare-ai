import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction, Express } from "express";
import { z } from "zod";
import type { PublicAccount, AccountRole } from "../../shared/auth.js";
import type { Store } from "../db/index.js";
import { ApiError, fail, hash, id, now, rateLimit } from "../http/index.js";

export interface Resident {
  id: string;
  siteId: string;
  expiresAt: string;
  createdAt: string;
  sessionVersion?: number;
}
export interface Staff {
  id: string;
  name: string;
  username: string;
  siteId: string;
  role: "staff" | "admin";
  expiresAt: string;
  sessionVersion?: number;
}
export interface Account extends PublicAccount {
  usernameNormalized: string;
  passwordHash: string;
  passwordSalt: string;
  sessionVersion: number;
}
export interface AuthConfig {
  secureCookies: boolean;
  origin?: string;
  seedAccounts: Array<{
    id: string;
    name: string;
    username: string;
    password: string;
    siteId: string;
    role?: AccountRole;
  }>;
}
const derivationOptions = { N: 16384, r: 8, p: 5, maxmem: 64 * 1024 * 1024 };
const passwordSchema = z.string().min(12).max(128);
const usernameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{3,32}$/)
  .transform((value) => value.toLowerCase());
const registrationSchema = z
  .object({
    siteId: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(40),
    username: usernameSchema,
    password: passwordSchema,
  })
  .strict();
const loginSchema = z
  .object({
    siteId: z.string().min(1).max(100),
    username: usernameSchema,
    password: z.string().min(1).max(128),
  })
  .strict();
let runningHashes = 0;
const waitingHashes: Array<() => void> = [];
// Limit expensive work across all app instances, including requests with unknown usernames.
async function derive(password: string, salt: string): Promise<Buffer> {
  if (runningHashes >= 2) {
    if (waitingHashes.length >= 32)
      fail(429, "AUTH_BUSY", "登录请求较多，请稍后再试。");
    await new Promise<void>((resolve) => waitingHashes.push(resolve));
  } else runningHashes++;
  try {
    return await new Promise<Buffer>((resolve, reject) =>
      scrypt(password, salt, 64, derivationOptions, (error, value) =>
        error ? reject(error) : resolve(value),
      ),
    );
  } finally {
    const next = waitingHashes.shift();
    if (next) next();
    else runningHashes--;
  }
}
const dummySalt = randomBytes(16).toString("hex");
function decodeCookie(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}
const cookies = (req: Request) =>
  Object.fromEntries(
    (req.headers.cookie || "").split(";").map((s) => {
      const i = s.indexOf("=");
      return i < 0
        ? ["", ""]
        : [s.slice(0, i).trim(), decodeCookie(s.slice(i + 1))];
    }),
  );
export class Auth {
  constructor(
    readonly store: Store,
    readonly config: AuthConfig,
  ) {
    for (const seed of config.seedAccounts) {
      const username = usernameSchema.parse(seed.username);
      // Seeds are creation-only: password changes, disabled state and names survive restarts.
      if (
        store.get<Account>("account", seed.id) ||
        this.find(seed.siteId, username)
      )
        continue;
      const passwordSalt = randomBytes(16).toString("hex");
      const timestamp = now();
      store.put("account", {
        id: seed.id,
        siteId: seed.siteId,
        name: seed.name,
        username,
        usernameNormalized: username,
        role: seed.role || "staff",
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
        sessionVersion: 1,
        passwordSalt,
        passwordHash: scryptSync(
          seed.password,
          passwordSalt,
          64,
          derivationOptions,
        ).toString("hex"),
      } satisfies Account);
    }
  }
  view(account: Account): PublicAccount {
    const { id, siteId, name, username, role, status, createdAt, updatedAt } =
      account;
    return { id, siteId, name, username, role, status, createdAt, updatedAt };
  }
  find(siteId: string, username: string): Account | undefined {
    const row = this.store.db
      .prepare(
        "SELECT data FROM objects WHERE kind='account' AND json_extract(data,'$.siteId')=? AND json_extract(data,'$.usernameNormalized')=?",
      )
      .get(siteId, username.toLowerCase()) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Account) : undefined;
  }
  private storedSession<T extends Resident | Staff>(
    req: Request,
    kind: "resident" | "staff",
  ): T | undefined {
    const raw = cookies(req)[kind === "resident" ? "nr_resident" : "nr_staff"];
    if (!raw) return undefined;
    const h = hash(raw);
    const row = this.store.db
      .prepare("SELECT data FROM credentials WHERE hash=? AND kind=?")
      .get(h, kind) as { data: string } | undefined;
    if (!row) return undefined;
    const principal = JSON.parse(row.data) as T;
    if (
      !this.config.seedAccounts.some(
        (account) => account.siteId === principal.siteId,
      )
    )
      return undefined;
    if (
      !Number.isFinite(Date.parse(principal.expiresAt)) ||
      Date.parse(principal.expiresAt) <= Date.now()
    ) {
      this.store.db.prepare("DELETE FROM credentials WHERE hash=?").run(h);
      return undefined;
    }
    return principal;
  }
  legacyGuest(req: Request): Resident | undefined {
    const principal = this.storedSession<Resident>(req, "resident");
    if (
      !principal ||
      principal.sessionVersion !== undefined ||
      this.store.get<Account>("account", principal.id)
    )
      return undefined;
    return principal;
  }
  read<T extends Resident | Staff>(
    req: Request,
    kind: "resident" | "staff",
  ): T | undefined {
    const principal = this.storedSession<T>(req, kind);
    if (!principal) return undefined;
    const account = this.store.get<Account>("account", principal.id);
    if (
      !account ||
      account.status !== "active" ||
      account.siteId !== principal.siteId ||
      account.sessionVersion !== principal.sessionVersion ||
      (kind === "resident"
        ? account.role !== "resident"
        : !["staff", "admin"].includes(account.role))
    )
      return undefined;
    return (
      kind === "staff"
        ? {
            ...principal,
            name: account.name,
            username: account.username,
            role: account.role,
          }
        : principal
    ) as T;
  }
  current(req: Request): Account | undefined {
    const principal = this.read(req, "staff") || this.read(req, "resident");
    return principal
      ? this.store.get<Account>("account", principal.id)
      : undefined;
  }
  resident(req: Request): Resident {
    const resident = this.read<Resident>(req, "resident");
    if (resident) return resident;
    if (this.read(req, "staff"))
      fail(403, "RESIDENT_REQUIRED", "请使用居民账号报修。");
    return fail(401, "SESSION_REQUIRED", "请先注册或登录居民账号。");
  }
  staff(req: Request): Staff {
    const staff = this.read<Staff>(req, "staff");
    if (staff) return staff;
    if (this.read(req, "resident"))
      fail(403, "STAFF_REQUIRED", "此操作需要工作人员权限。");
    return fail(401, "STAFF_LOGIN_REQUIRED", "请先登录工作人员账户。");
  }
  admin(req: Request): Staff {
    const staff = this.staff(req);
    if (staff.role !== "admin")
      fail(403, "ADMIN_REQUIRED", "此操作需要管理员权限。");
    return staff;
  }
  private cookieOptions() {
    return {
      httpOnly: true,
      secure: this.config.secureCookies,
      sameSite: "strict" as const,
      path: "/",
    };
  }
  issue(
    res: Response,
    kind: "resident" | "staff",
    principal: Resident | Staff,
  ) {
    const token = randomBytes(32).toString("base64url");
    this.store.db
      .prepare("INSERT INTO credentials(hash,kind,data) VALUES(?,?,?)")
      .run(hash(token), kind, JSON.stringify(principal));
    res.cookie(kind === "resident" ? "nr_resident" : "nr_staff", token, {
      ...this.cookieOptions(),
      maxAge: kind === "resident" ? 30 * 86400000 : 8 * 3600000,
    });
  }
  logout(req: Request, res: Response) {
    for (const kind of ["resident", "staff"] as const) {
      const token = cookies(req)[`nr_${kind}`];
      if (token)
        this.store.db
          .prepare("DELETE FROM credentials WHERE hash=? AND kind=?")
          .run(hash(token), kind);
      res.clearCookie(`nr_${kind}`, this.cookieOptions());
    }
  }
  private login(req: Request, res: Response, account: Account) {
    this.logout(req, res);
    const expiresAt = new Date(
      Date.now() + (account.role === "resident" ? 30 * 86400000 : 8 * 3600000),
    ).toISOString();
    if (account.role === "resident")
      this.issue(res, "resident", {
        id: account.id,
        siteId: account.siteId,
        createdAt: account.createdAt,
        expiresAt,
        sessionVersion: account.sessionVersion,
      });
    else
      this.issue(res, "staff", {
        id: account.id,
        siteId: account.siteId,
        name: account.name,
        username: account.username,
        role: account.role,
        expiresAt,
        sessionVersion: account.sessionVersion,
      });
  }
  private revoke(accountId: string) {
    this.store.db
      .prepare("DELETE FROM credentials WHERE json_extract(data,'$.id')=?")
      .run(accountId);
  }
  private async verify(
    siteId: string,
    username: string,
    password: string,
    roles?: AccountRole[],
  ): Promise<Account> {
    const found = this.find(siteId, username);
    const actual = await derive(password, found?.passwordSalt || dummySalt);
    const expected = found
      ? Buffer.from(found.passwordHash, "hex")
      : Buffer.alloc(64);
    const current = found && this.store.get<Account>("account", found.id);
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected) ||
      !found ||
      !current ||
      current.passwordHash !== found.passwordHash ||
      current.sessionVersion !== found.sessionVersion ||
      current.status !== "active" ||
      (roles && !roles.includes(current.role))
    )
      fail(401, "INVALID_CREDENTIALS", "账号或密码不正确，或账号已停用。");
    return current;
  }
  refresh = (req: Request, res: Response, next: NextFunction) => {
    res.locals.principal =
      this.read(req, "staff") || this.read(req, "resident");
    next();
  };
  requireAccount = (req: Request, _res: Response, next: NextFunction) => {
    const current = this.current(req);
    if (!current) fail(401, "SESSION_REQUIRED", "请先注册或登录账号。");
    if (req.get("X-Account-Id") && req.get("X-Account-Id") !== current.id)
      fail(403, "ACCOUNT_CHANGED", "当前账号已切换，请刷新后重新操作。");
    next();
  };
  csrf = (req: Request, _res: Response, next: NextFunction) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const expected =
      this.config.origin || `${req.protocol}://${req.get("host")}`;
    if (
      (req.headers.origin && req.headers.origin !== expected) ||
      req.headers["sec-fetch-site"] === "cross-site"
    )
      return next(
        new ApiError(403, "CROSS_ORIGIN", "请求来源无效，请从当前站点操作。"),
      );
    next();
  };
  routes(app: Express, sites: string[]) {
    const checkSite = (siteId: string) => {
      if (!sites.includes(siteId))
        fail(422, "INVALID_SITE", "请选择有效场地。");
    };
    app.post("/api/sessions/anonymous", rateLimit(30, 60000), (req, res) => {
      const input = z
        .object({
          siteId: z.enum(sites as [string, ...string[]]).default(sites[0]!),
        })
        .parse(req.body || {});
      const current =
        this.read<Resident>(req, "resident") || this.legacyGuest(req);
      if (current) {
        if (current.siteId !== input.siteId)
          fail(
            409,
            "SESSION_SITE_CONFLICT",
            "当前会话属于另一个空间，请使用独立浏览器。",
          );
        return res.json({
          id: current.id,
          siteId: current.siteId,
          expiresAt: current.expiresAt,
        });
      }
      if (this.read(req, "staff"))
        fail(403, "RESIDENT_REQUIRED", "请使用居民账号报修。");
      const guest = {
        id: id(),
        siteId: input.siteId,
        expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
        createdAt: now(),
      };
      this.issue(res, "resident", guest);
      res.json({
        id: guest.id,
        siteId: guest.siteId,
        expiresAt: guest.expiresAt,
      });
    });
    app.post(
      "/api/auth/register",
      rateLimit(30, 60000, { key: (req) => req.ip || "unknown" }),
      async (req, res) => {
        const input = registrationSchema.parse(req.body);
        checkSite(input.siteId);
        if (this.find(input.siteId, input.username))
          fail(409, "USERNAME_TAKEN", "此账号已存在，请更换账号或登录。");
        const passwordSalt = randomBytes(16).toString("hex");
        const passwordHash = (
          await derive(input.password, passwordSalt)
        ).toString("hex");
        const account = this.store.tx(() => {
          if (this.find(input.siteId, input.username))
            fail(409, "USERNAME_TAKEN", "此账号已存在，请更换账号或登录。");
          const guest = this.legacyGuest(req),
            timestamp = now();
          const value: Account = {
            id: guest?.siteId === input.siteId ? guest.id : id(),
            siteId: input.siteId,
            name: input.name,
            username: input.username,
            usernameNormalized: input.username,
            role: "resident",
            status: "active",
            createdAt: timestamp,
            updatedAt: timestamp,
            sessionVersion: 1,
            passwordSalt,
            passwordHash,
          };
          this.store.put("account", value);
          return value;
        });
        this.login(req, res, account);
        res.status(201).json({ user: this.view(account) });
      },
    );
    const loginLimits = [
      rateLimit(60, 60000, { key: (req) => req.ip || "unknown" }),
      rateLimit(10, 60000, {
        key: (req) =>
          `${req.ip || "unknown"}:${String(req.body?.siteId || sites[0]).slice(0, 100)}:${String(
            req.body?.username || "",
          )
            .trim()
            .toLowerCase()
            .slice(0, 32)}`,
        skipSuccessful: true,
      }),
    ];
    app.post("/api/auth/login", ...loginLimits, async (req, res) => {
      const input = loginSchema.parse(req.body);
      checkSite(input.siteId);
      const account = await this.verify(
        input.siteId,
        input.username,
        input.password,
      );
      this.login(req, res, account);
      res.json({ user: this.view(account) });
    });
    app.delete("/api/auth/session", (req, res) => {
      this.logout(req, res);
      res.status(204).end();
    });
    app.patch("/api/auth/password", rateLimit(6, 60000), async (req, res) => {
      const current =
        this.current(req) || fail(401, "SESSION_REQUIRED", "请先登录账号。");
      const input = z
        .object({
          currentPassword: z.string().min(1).max(128),
          newPassword: passwordSchema,
        })
        .strict()
        .parse(req.body);
      const verified = await this.verify(
        current.siteId,
        current.username,
        input.currentPassword,
      );
      const passwordSalt = randomBytes(16).toString("hex"),
        passwordHash = (await derive(input.newPassword, passwordSalt)).toString(
          "hex",
        );
      this.store.tx(() => {
        const latest = this.store.get<Account>("account", current.id)!;
        if (
          latest.sessionVersion !== verified.sessionVersion ||
          latest.status !== "active"
        )
          fail(401, "SESSION_REQUIRED", "账号状态已更新，请重新登录。");
        this.store.put("account", {
          ...latest,
          passwordSalt,
          passwordHash,
          sessionVersion: latest.sessionVersion + 1,
          updatedAt: now(),
        });
        this.revoke(latest.id);
      });
      this.logout(req, res);
      res.status(204).end();
    });
    app.post("/api/staff/sessions", ...loginLimits, async (req, res) => {
      const input = z
        .object({
          username: usernameSchema,
          password: z.string().min(1).max(128),
          siteId: z.string().optional(),
        })
        .strict()
        .parse(req.body);
      const siteId = input.siteId || sites[0]!;
      checkSite(siteId);
      const account = await this.verify(
        siteId,
        input.username,
        input.password,
        ["staff", "admin"],
      );
      this.login(req, res, account);
      res.json({ staff: { ...this.view(account) }, user: this.view(account) });
    });
    app.delete("/api/staff/sessions", (req, res) => {
      this.logout(req, res);
      res.status(204).end();
    });
    app.get("/api/admin/users", (req, res) => {
      const admin = this.admin(req);
      res.json({
        users: this.store
          .all<Account>("account")
          .filter((a) => a.siteId === admin.siteId)
          .map((a) => this.view(a)),
      });
    });
    app.post("/api/admin/users", rateLimit(20, 60000), async (req, res) => {
      const admin = this.admin(req);
      const input = registrationSchema
        .extend({ role: z.literal("staff") })
        .parse(req.body);
      if (input.siteId !== admin.siteId)
        fail(403, "FORBIDDEN", "只能管理当前场地账号。");
      const passwordSalt = randomBytes(16).toString("hex"),
        passwordHash = (await derive(input.password, passwordSalt)).toString(
          "hex",
        );
      const account = this.store.tx(() => {
        this.admin(req);
        if (this.find(input.siteId, input.username))
          fail(409, "USERNAME_TAKEN", "此账号已存在。");
        const timestamp = now();
        const value: Account = {
          id: id(),
          siteId: input.siteId,
          username: input.username,
          usernameNormalized: input.username,
          name: input.name,
          role: "staff",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          sessionVersion: 1,
          passwordSalt,
          passwordHash,
        };
        this.store.put("account", value);
        return value;
      });
      res.status(201).json({ user: this.view(account) });
    });
    app.patch("/api/admin/users/:id", (req, res) => {
      const admin = this.admin(req),
        input = z
          .object({ status: z.enum(["active", "disabled"]) })
          .strict()
          .parse(req.body);
      const target =
        this.store.get<Account>("account", String(req.params.id)) ||
        fail(404, "NOT_FOUND", "没有找到此账号。");
      if (target.siteId !== admin.siteId)
        fail(403, "FORBIDDEN", "只能管理当前场地账号。");
      if (
        input.status === "disabled" &&
        (target.id === admin.id || target.role === "admin")
      )
        fail(403, "ADMIN_PROTECTED", "不能停用自己或管理员账号。");
      const account = {
        ...target,
        status: input.status,
        sessionVersion: target.sessionVersion + 1,
        updatedAt: now(),
      };
      this.store.tx(() => {
        this.store.put("account", account);
        this.revoke(account.id);
      });
      res.json({ user: this.view(account) });
    });
  }
}

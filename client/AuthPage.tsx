import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Buildings,
  Check,
  Eye,
  EyeSlash,
  Leaf,
  ShieldCheck,
  UserCircle,
  Wrench,
} from "@phosphor-icons/react";
import type { Bootstrap } from "../shared/types";
import type { PublicAccount } from "../shared/auth";
import { ROLE_LABELS } from "../shared/auth";
import { DEMO_ACCOUNTS } from "../shared/demo-accounts";
import { api, message } from "./api";
import { Link, Notice, navigate } from "./ui";
import { destinationAfterLogin } from "./auth-navigation";

export function PasswordField({
  id,
  label,
  value,
  onChange,
  fresh = false,
  disabled = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  fresh?: boolean;
  disabled?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="password-input">
        <input
          id={id}
          type={visible ? "text" : "password"}
          autoComplete={fresh ? "new-password" : "current-password"}
          minLength={fresh ? 12 : undefined}
          maxLength={128}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
          disabled={disabled}
        />
        <button
          type="button"
          className="password-toggle"
          aria-label={`${visible ? "隐藏" : "显示"}${label}`}
          aria-pressed={visible}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? <EyeSlash size={20} /> : <Eye size={20} />}
        </button>
      </div>
    </div>
  );
}

export default function AuthPage({
  bootstrap,
  register,
  onAuthenticated,
}: {
  bootstrap: Bootstrap;
  register: boolean;
  onAuthenticated: (user: PublicAccount) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const next = new URLSearchParams(window.location.search).get("next");
  const opposite = `${register ? "/login" : "/register"}${next ? `?next=${encodeURIComponent(next)}` : ""}`;
  const site = bootstrap.sites[0];
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!site) return;
    if (register && password !== confirm) {
      setError("两次输入的密码不一致，请重新核对。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const input = { siteId: site.id, username: username.trim(), password };
      const result = register
        ? await api.register({ ...input, name: name.trim() })
        : await api.login(input);
      setPassword("");
      setConfirm("");
      await onAuthenticated(result.user);
      navigate(destinationAfterLogin(result.user.role, next));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function demoLogin(account: (typeof DEMO_ACCOUNTS)[number]) {
    if (!site || busy) return;
    setUsername(account.username);
    setPassword(account.password);
    setBusy(true);
    setError("");
    try {
      const result = await api.login({
        siteId: site.id,
        username: account.username,
        password: account.password,
      });
      setPassword("");
      await onAuthenticated(result.user);
      navigate(destinationAfterLogin(result.user.role, next));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const signedIn = bootstrap.user;
  return (
    <div className="auth-shell">
      <a className="skip-link" href="#auth-main">
        跳到账号表单
      </a>
      <aside className="auth-story">
        <Link href="/" className="brand auth-brand">
          <span className="brand-mark">
            <Buildings size={29} weight="duotone" />
          </span>
          <div>
            邻里报修<span>把小事，放在心上</span>
          </div>
        </Link>
        <div className="auth-story-body">
          <span className="auth-eyebrow">
            <span className="live-dot" /> NEIGHBORHOOD, CONNECTED
          </span>
          <h1>
            每一件小事，
            <br />
            都值得被
            <br />
            <em>认真回应。</em>
          </h1>
          <p>
            从发现问题到收到回音，
            <br />
            一个账号，连接你的每一次报修。
          </p>
          <div className="auth-benefits">
            <div>
              <Check size={18} />
              <span>换一台设备，也能查看进展</span>
            </div>
            <div>
              <Check size={18} />
              <span>诉求、处理、反馈，记录完整</span>
            </div>
            <div>
              <Check size={18} />
              <span>不同身份，各有清楚的权限</span>
            </div>
          </div>
        </div>
        <div className="auth-story-footer">
          <Leaf size={25} weight="duotone" />
          <span>一起照顾好，我们的公共空间。</span>
          <span>01 / 邻里相连</span>
        </div>
      </aside>
      <main id="auth-main" className="auth-main">
        <div className="auth-topline">
          <span>{site?.name || "邻里公共服务"}</span>
          {bootstrap.demoMode && <span className="demo-tag">演示空间</span>}
        </div>
        <div className="auth-form-wrap">
          <div className="auth-tabs" aria-label="账号入口">
            <Link
              href={
                register
                  ? opposite
                  : `/login${next ? `?next=${encodeURIComponent(next)}` : ""}`
              }
              className={!register ? "active" : ""}
              aria-current={!register ? "page" : undefined}
            >
              登录
            </Link>
            <Link
              href={
                register
                  ? `/register${next ? `?next=${encodeURIComponent(next)}` : ""}`
                  : opposite
              }
              className={register ? "active" : ""}
              aria-current={register ? "page" : undefined}
            >
              注册居民账号
            </Link>
          </div>
          <span className="auth-form-icon">
            {register ? <UserCircle size={29} /> : <ShieldCheck size={29} />}
          </span>
          <h2>{register ? "成为邻里的一员" : "欢迎回来"}</h2>
          <p className="auth-intro">
            {register
              ? "创建居民账号，开始反馈身边的小问题。"
              : "登录你的账号，接着把小事办好。"}
          </p>
          {new URLSearchParams(window.location.search).get(
            "passwordChanged",
          ) === "1" && (
            <Notice>密码已修改，旧登录已失效，请使用新密码登录。</Notice>
          )}
          {signedIn ? (
            <div className="auth-current">
              <Notice>
                当前已登录为 {signedIn.name}（{ROLE_LABELS[signedIn.role]}
                ）。切换账号前请先退出。
              </Notice>
              <Link
                href={destinationAfterLogin(signedIn.role, next)}
                className="button primary full"
              >
                进入我的空间 <ArrowRight size={20} />
              </Link>
              <Link href="/account" className="text-link">
                账号与安全
              </Link>
            </div>
          ) : (
            <>
              {!register && bootstrap.demoMode && (
                <section
                  className="auth-demo"
                  id="built-in-accounts"
                  aria-labelledby="demo-accounts-title"
                >
                  <div className="demo-accounts-heading">
                    <h3 id="demo-accounts-title">内置演示账号</h3>
                    <span>无需注册 · 一键体验</span>
                  </div>
                  <div className="demo-accounts-list">
                    {DEMO_ACCOUNTS.map((account) => (
                      <article className="demo-account-card" key={account.role}>
                        <div className="demo-account-title">
                          <span className={`demo-account-icon ${account.role}`}>
                            {account.role === "resident" ? (
                              <UserCircle size={21} />
                            ) : account.role === "staff" ? (
                              <Wrench size={21} />
                            ) : (
                              <ShieldCheck size={21} />
                            )}
                          </span>
                          <div>
                            <h4>{ROLE_LABELS[account.role]}</h4>
                            <p>{account.description}</p>
                          </div>
                        </div>
                        <dl>
                          <div>
                            <dt>账号</dt>
                            <dd>{account.username}</dd>
                          </div>
                          <div>
                            <dt>密码</dt>
                            <dd>{account.password}</dd>
                          </div>
                        </dl>
                        <button
                          className="button secondary full"
                          type="button"
                          disabled={busy || !site}
                          aria-label={`一键体验${ROLE_LABELS[account.role]}`}
                          onClick={() => void demoLogin(account)}
                        >
                          {busy && username === account.username
                            ? "正在进入…"
                            : "一键体验"}
                          <ArrowRight size={16} />
                        </button>
                      </article>
                    ))}
                  </div>
                  <p className="demo-accounts-note">
                    内置账号共用演示记录；个人报修请注册自己的账号。以上为默认凭据，修改过账号或密码后请使用下方表单登录。
                  </p>
                </section>
              )}
              {!register && bootstrap.demoMode && (
                <div className="auth-manual-label">或使用账号密码登录</div>
              )}
              <form
                onSubmit={(event) => void submit(event)}
                aria-label={register ? "居民注册" : "账号登录"}
              >
                {error && <Notice error>{error}</Notice>}
                {register && (
                  <div className="field">
                    <label htmlFor="display-name">称呼</label>
                    <input
                      id="display-name"
                      autoComplete="nickname"
                      placeholder="怎么称呼你"
                      value={name}
                      maxLength={40}
                      onChange={(e) => setName(e.target.value)}
                      required
                      disabled={busy}
                    />
                  </div>
                )}
                <div className="field">
                  <label htmlFor="auth-username">账号</label>
                  <input
                    id="auth-username"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder={
                      register
                        ? "3–32 位字母、数字、下划线或短横线"
                        : "请输入账号"
                    }
                    value={username}
                    minLength={3}
                    maxLength={32}
                    pattern="[A-Za-z0-9_-]{3,32}"
                    onChange={(e) => setUsername(e.target.value)}
                    required
                    disabled={busy}
                  />
                </div>
                <PasswordField
                  id="auth-password"
                  label="密码"
                  value={password}
                  onChange={setPassword}
                  fresh={register}
                  disabled={busy}
                />
                {register && (
                  <>
                    <p className="field-hint auth-password-hint">
                      使用 12–128 个字符；请勿使用其他重要账号的密码。
                    </p>
                    <PasswordField
                      id="auth-confirm"
                      label="确认密码"
                      value={confirm}
                      onChange={setConfirm}
                      fresh
                      disabled={busy}
                    />
                  </>
                )}
                {!register && (
                  <p className="auth-recovery">
                    忘记密码？请联系场地服务负责人。
                  </p>
                )}
                <button
                  type="submit"
                  className="button primary full auth-submit"
                  disabled={busy || !site}
                >
                  {busy
                    ? register
                      ? "正在创建账号…"
                      : "正在登录…"
                    : register
                      ? "注册并进入居民空间"
                      : "登录"}
                  <ArrowRight size={21} />
                </button>
              </form>
              <p className="auth-switch">
                {register ? "已有账号？" : "还没有居民账号？"}
                <Link href={opposite} className="text-link">
                  {register ? "去登录" : "立即注册"}
                </Link>
              </p>
              {register ? (
                <div className="auth-boundary">
                  <ShieldCheck size={22} />
                  <p>
                    公开注册仅开通居民权限。工作人员由管理员开通。
                    <br />
                    {bootstrap.guestId
                      ? "在此注册会保留当前浏览器原有的游客记录。"
                      : "无需提供手机号或家庭住址。"}
                  </p>
                </div>
              ) : (
                <>
                  <div className="auth-boundary">
                    <Wrench size={21} />
                    <p>
                      居民、工作人员与管理员使用同一登录入口，登录后自动进入对应空间。
                    </p>
                  </div>
                </>
              )}
            </>
          )}
        </div>
        <footer className="auth-footer">
          <ShieldCheck size={16} />
          <span>账号权限校验 · 私密记录 · 非应急服务</span>
          <Link href="/" aria-label="返回服务入口">
            <ArrowLeft size={16} />
          </Link>
        </footer>
      </main>
    </div>
  );
}

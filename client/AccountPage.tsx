import { useState } from "react";
import { Key, ShieldCheck, SignOut } from "@phosphor-icons/react";
import type { PublicAccount } from "../shared/auth";
import { ROLE_LABELS } from "../shared/auth";
import { api, message } from "./api";
import { PasswordField } from "./AuthPage";
import { date, Notice, PageHeader } from "./ui";

export default function AccountPage({
  user,
  onSignedOut,
}: {
  user: PublicAccount;
  onSignedOut: (passwordChanged?: boolean) => Promise<void>;
}) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function change(event: React.FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setError("两次输入的新密码不一致。");
      return;
    }
    if (password === current) {
      setError("新密码应与当前密码不同。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.changePassword(current, password);
      setCurrent("");
      setPassword("");
      setConfirm("");
      await onSignedOut(true);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="ACCOUNT / 账号与安全"
        title="照顾好你的账号。"
        text="你的报修归属于账号。换设备后登录同一账号，即可继续查看。"
      />
      <div className="account-grid">
        <section className="account-profile">
          <span className="account-avatar">{user.name.slice(0, 1)}</span>
          <h2>{user.name}</h2>
          <span className="role-badge">{ROLE_LABELS[user.role]}</span>
          <dl>
            <div>
              <dt>账号</dt>
              <dd>{user.username}</dd>
            </div>
            <div>
              <dt>注册时间</dt>
              <dd>{date(user.createdAt)}</dd>
            </div>
            <div>
              <dt>账号状态</dt>
              <dd>正常使用</dd>
            </div>
          </dl>
          <div className="account-permission">
            <ShieldCheck size={22} />
            <p>
              {user.role === "resident"
                ? "你可以创建报修、查看自己的记录，并对处理结果作出反馈。"
                : user.role === "admin"
                  ? "你可以管理本场地工单和账号。居民对处理结果的确认仍由本人完成。"
                  : "你可以查看本场地工单、认领处理并提交回执；账号由管理员管理。"}
            </p>
          </div>
          <button
            className="button secondary full"
            disabled={busy}
            onClick={() => {
              void onSignedOut().catch((e) => setError(message(e)));
            }}
          >
            <SignOut size={18} />
            退出登录
          </button>
        </section>
        <section className="account-password">
          <span className="auth-form-icon">
            <Key size={25} />
          </span>
          <h2>修改密码</h2>
          <p>修改后，所有设备的旧登录都会失效。</p>
          <form onSubmit={(e) => void change(e)}>
            {error && <Notice error>{error}</Notice>}
            <PasswordField
              id="current-password"
              label="当前密码"
              value={current}
              onChange={setCurrent}
              disabled={busy}
            />
            <PasswordField
              id="new-password"
              label="新密码"
              value={password}
              onChange={setPassword}
              fresh
              disabled={busy}
            />
            <p className="field-hint auth-password-hint">
              12–128 个字符，请与当前密码保持不同。
            </p>
            <PasswordField
              id="confirm-new"
              label="确认新密码"
              value={confirm}
              onChange={setConfirm}
              fresh
              disabled={busy}
            />
            <button className="button primary" type="submit" disabled={busy}>
              {busy ? "正在保存…" : "保存新密码并重新登录"}
            </button>
          </form>
        </section>
      </div>
    </>
  );
}

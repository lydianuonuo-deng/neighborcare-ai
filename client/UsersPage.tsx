import { useCallback, useEffect, useState } from "react";
import {
  ArrowClockwise,
  MagnifyingGlass,
  Plus,
  ShieldCheck,
  Users,
  X,
} from "@phosphor-icons/react";
import type { PublicAccount } from "../shared/auth";
import { ROLE_LABELS } from "../shared/auth";
import { api, message } from "./api";
import { PasswordField } from "./AuthPage";
import { Empty, Loading, Notice, PageHeader, date } from "./ui";

export default function UsersPage({ user }: { user: PublicAccount }) {
  const [users, setUsers] = useState<PublicAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("all");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmId, setConfirmId] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setUsers((await api.users()).users);
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api.createStaff({
        siteId: user.siteId,
        name: name.trim(),
        username: username.trim(),
        password,
        role: "staff",
      });
      setUsers((previous) => [...previous, result.user]);
      setName("");
      setUsername("");
      setPassword("");
      setAdding(false);
      setNotice(
        `已开通工作人员 ${result.user.name}。请将账号和初始密码线下交给本人，首次登录后可修改密码。`,
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function toggle(account: PublicAccount) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api.setAccountStatus(
        account.id,
        account.status === "active" ? "disabled" : "active",
      );
      setUsers((previous) =>
        previous.map((value) =>
          value.id === account.id ? result.user : value,
        ),
      );
      setConfirmId("");
      setNotice(
        result.user.status === "disabled"
          ? `已停用 ${account.name}，其所有旧登录已失效。历史工单已保留。`
          : `已恢复 ${account.name}，本人现在可以重新登录。`,
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const visible = users.filter(
    (account) =>
      (role === "all" || account.role === role) &&
      `${account.username} ${account.name}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  return (
    <>
      <PageHeader
        eyebrow="ACCESS CONTROL / 场地账号管理"
        title="每个身份，各司其职。"
        text="为服务人员开通账号，管理本场地的访问权限。"
        action={
          <button
            className="button primary"
            onClick={() => {
              setAdding(true);
              setError("");
            }}
          >
            <Plus size={20} />
            开通工作人员
          </button>
        }
      />
      <div className="permission-strip">
        <ShieldCheck size={25} />
        <div>
          <strong>公开注册仅开通居民权限</strong>
          <p>
            工作人员由管理员创建。停用账号立即撤销旧登录，保留历史工单；管理员账号不能在此停用。
          </p>
        </div>
      </div>
      {error && <Notice error>{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      {adding && (
        <section className="user-create">
          <div className="row spread">
            <h2>开通工作人员账号</h2>
            <button
              className="icon-button"
              aria-label="取消开通账号"
              disabled={busy}
              onClick={() => {
                setAdding(false);
                setPassword("");
              }}
            >
              <X size={21} />
            </button>
          </div>
          <form onSubmit={(event) => void create(event)}>
            <div className="user-create-fields">
              <div className="field">
                <label htmlFor="staff-name">工作人员姓名</label>
                <input
                  id="staff-name"
                  value={name}
                  maxLength={40}
                  required
                  disabled={busy}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="staff-username">工作人员账号</label>
                <input
                  id="staff-username"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={username}
                  minLength={3}
                  maxLength={32}
                  pattern="[A-Za-z0-9_-]{3,32}"
                  required
                  disabled={busy}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </div>
              <PasswordField
                id="staff-password"
                label="初始密码"
                fresh
                value={password}
                onChange={setPassword}
                disabled={busy}
              />
            </div>
            <p className="field-hint">
              账号 3–32 位字母、数字、下划线或短横线；初始密码 12–128
              个字符。角色固定为工作人员。
            </p>
            <div className="row">
              <button className="button primary" type="submit" disabled={busy}>
                {busy ? "正在开通…" : "确认开通"}
              </button>
              <button
                className="button secondary"
                type="button"
                disabled={busy}
                onClick={() => {
                  setAdding(false);
                  setPassword("");
                }}
              >
                取消
              </button>
            </div>
          </form>
        </section>
      )}
      <section className="users-section">
        <div className="users-toolbar">
          <h2>
            <Users size={22} />
            场地账号 <span>{users.length}</span>
          </h2>
          <button
            className="button secondary"
            disabled={loading || busy}
            onClick={() => void load()}
          >
            <ArrowClockwise size={18} />
            刷新账号
          </button>
        </div>
        <div className="users-filters">
          <label className="user-search">
            <MagnifyingGlass size={20} />
            <input
              aria-label="搜索账号或称呼"
              placeholder="搜索账号或称呼"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <select
            aria-label="筛选账号角色"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            <option value="all">全部角色</option>
            <option value="resident">居民</option>
            <option value="staff">工作人员</option>
            <option value="admin">管理员</option>
          </select>
        </div>
        {loading ? (
          <Loading text="正在读取账号…" />
        ) : !visible.length ? (
          <Empty title="没有符合条件的账号">试试其他关键词或角色。</Empty>
        ) : (
          <div className="user-list">
            {visible.map((account) => (
              <article className="user-row" key={account.id}>
                <span
                  className={`user-avatar ${account.status === "disabled" ? "disabled" : ""}`}
                >
                  {account.name.slice(0, 1)}
                </span>
                <div className="user-identity">
                  <strong>
                    {account.name}
                    {account.id === user.id && <small>我</small>}
                  </strong>
                  <span>{account.username}</span>
                </div>
                <div className="user-role">
                  <span className="role-badge">
                    {ROLE_LABELS[account.role]}
                  </span>
                  <small>创建于 {date(account.createdAt)}</small>
                </div>
                <span className={`account-status ${account.status}`}>
                  {account.status === "active" ? "正常" : "已停用"}
                </span>
                <div className="user-control">
                  {account.role === "admin" ? (
                    <span className="field-hint">管理员受保护</span>
                  ) : confirmId === account.id ? (
                    <div className="disable-confirm">
                      <span>立即撤销该账号登录？</span>
                      <div>
                        <button
                          className="text-button danger"
                          disabled={busy}
                          onClick={() => void toggle(account)}
                        >
                          确认停用
                        </button>
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={() => setConfirmId("")}
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      className={`button secondary ${account.status === "active" ? "danger" : ""}`}
                      disabled={busy}
                      onClick={() =>
                        account.status === "active"
                          ? setConfirmId(account.id)
                          : void toggle(account)
                      }
                    >
                      {account.status === "active" ? "停用账号" : "恢复账号"}
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

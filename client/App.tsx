import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowClockwise,
  ArrowUpRight,
  Buildings,
  ClipboardText,
  ChartBar,
  Columns,
  Info,
  House,
  Leaf,
  Plus,
  ShieldCheck,
  Wrench,
  UserCircle,
  Users,
  SignOut,
} from "@phosphor-icons/react";
import type { Bootstrap, Ticket } from "../shared/types";
import { api, message } from "./api";
import {
  Empty,
  Link,
  navigate,
  Loading,
  Notice,
  PageHeader,
  SectionTitle,
  TicketList,
} from "./ui";
import NewReport from "./NewReport";
import TicketDetail from "./TicketDetail";
import StaffPage from "./StaffPage";
import TicketFilters from "./TicketFilters";
import {
  DEFAULT_TICKET_FILTERS,
  filterTickets,
  type TicketFilters as Filters,
} from "../shared/operations";

import AuthPage from "./AuthPage";
import { announceAuthChange, watchAuthChange } from "./auth-events";
import AccountPage from "./AccountPage";
import UsersPage from "./UsersPage";
import { ROLE_LABELS } from "../shared/auth";
import { destinationAfterLogin } from "./auth-navigation";
import { createDraftStorage, migrateGuestDraft } from "./draft-storage";

export default function App() {
  const [location, setLocation] = useState(
    window.location.pathname + window.location.search,
  );
  const path = location.split("?")[0];
  const [logoutError, setLogoutError] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const initializationVersion = useRef(0);
  const initialize = useCallback(async () => {
    const version = ++initializationVersion.current;
    setError("");
    setReady(false);
    try {
      const boot = await api.bootstrap();
      if (version !== initializationVersion.current) return;
      setBootstrap(boot);
      migrateGuestDraft(
        createDraftStorage(() => window.localStorage),
        boot.guestId,
      );
      setReady(true);
    } catch (e) {
      if (version === initializationVersion.current) setError(message(e));
    }
  }, []);
  useEffect(() => {
    void initialize();
    const listener = () =>
      setLocation(window.location.pathname + window.location.search);
    const expired = () => {
      void initialize();
    };
    window.addEventListener("auth-expired", expired);
    const unwatch = watchAuthChange(expired);
    window.addEventListener("popstate", listener);
    return () => {
      window.removeEventListener("popstate", listener);
      window.removeEventListener("auth-expired", expired);
      unwatch();
    };
  }, [initialize]);
  const user = bootstrap?.user;
  const authRoute = path === "/login" || path === "/register";
  const staffMode =
    path.startsWith("/staff") ||
    (path === "/account" && user?.role !== "resident");
  const site = bootstrap?.sites[0];
  const ticketId = path.match(/^\/(?:staff\/)?tickets\/([^/]+)$/)?.[1];
  const denied =
    !!user &&
    ((path.startsWith("/staff") && user.role === "resident") ||
      (path === "/staff/users" && user.role !== "admin"));
  useEffect(() => {
    if (!ready || !bootstrap || authRoute) return;
    if (!user) {
      window.history.replaceState(
        {},
        "",
        `/login?next=${encodeURIComponent(location)}`,
      );
      window.dispatchEvent(new PopStateEvent("popstate"));
    } else if (
      user.role !== "resident" &&
      !path.startsWith("/staff") &&
      path !== "/account"
    ) {
      navigate("/staff");
    }
  }, [ready, bootstrap, authRoute, user, path, location]);
  async function signedOut(passwordChanged = false) {
    setLoggingOut(true);
    setLogoutError("");
    try {
      if (!passwordChanged) await api.logout();
      announceAuthChange();
      setBootstrap(null);
      await initialize();
      navigate(`/login${passwordChanged ? "?passwordChanged=1" : ""}`);
    } catch (e) {
      setLogoutError(message(e));
      throw e;
    } finally {
      setLoggingOut(false);
    }
  }
  if (error)
    return (
      <main className="auth-unavailable">
        <PageHeader eyebrow="连接服务" title="暂时无法打开服务" />
        <Notice error>{error}</Notice>
        <button className="button primary" onClick={() => void initialize()}>
          重新连接
        </button>
      </main>
    );
  if (!ready || !bootstrap)
    return (
      <main className="auth-unavailable">
        <Loading text="正在验证登录状态…" />
      </main>
    );
  if (authRoute)
    return (
      <AuthPage
        key={path}
        bootstrap={bootstrap}
        register={path === "/register"}
        onAuthenticated={async () => {
          announceAuthChange();
          await initialize();
        }}
      />
    );
  if (!user)
    return (
      <main className="auth-unavailable">
        <Loading text="正在前往登录页面…" />
      </main>
    );
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        跳到主要内容
      </a>
      <aside className="sidebar">
        <Link href="/" className="brand">
          <span className="brand-mark">
            <Buildings size={29} weight="duotone" />
          </span>
          <div>
            邻里报修<span>把小事，放在心上</span>
          </div>
        </Link>
        <div className="space-label">
          {staffMode ? "工作人员空间" : "居民服务空间"}
        </div>
        <nav aria-label="主导航">
          <Link
            href={staffMode ? "/staff" : "/"}
            className={path === "/" || path === "/staff" ? "active" : ""}
          >
            <House size={22} /> {staffMode ? "工作台" : "服务首页"}
          </Link>
          <Link
            href={staffMode ? "/staff/tickets" : "/tickets"}
            className={path.includes("/tickets") ? "active" : ""}
          >
            <ClipboardText size={22} /> {staffMode ? "场地工单" : "我的报修"}
          </Link>
          {staffMode && (
            <>
              <Link
                href="/staff/board"
                className={path === "/staff/board" ? "active" : ""}
              >
                <Columns size={22} /> 状态看板
              </Link>
              <Link
                href="/staff/analytics"
                className={path === "/staff/analytics" ? "active" : ""}
              >
                <ChartBar size={22} /> 数据统计
              </Link>
              {user.role === "admin" && (
                <Link
                  href="/staff/users"
                  className={path === "/staff/users" ? "active" : ""}
                >
                  <Users size={22} />
                  账号管理
                </Link>
              )}
              <Link
                href="/staff/help"
                className={path === "/staff/help" ? "active" : ""}
              >
                <Info size={22} /> 服务说明
              </Link>
            </>
          )}
          {!staffMode && (
            <Link href="/new" className={path === "/new" ? "active" : ""}>
              <Plus size={22} /> 新建报修
            </Link>
          )}
        </nav>
        <nav className="account-navigation" aria-label="账号导航">
          <Link href="/account" className={path === "/account" ? "active" : ""}>
            <UserCircle size={22} />
            账号与安全
          </Link>
        </nav>
        <div className="sidebar-bottom">
          <div className="neighbor-note">
            <Leaf size={28} weight="duotone" />
            <p>
              让公共空间
              <br />
              多一分安心。
            </p>
            <span>每一件小事，都有回音。</span>
          </div>
          <Link href="/account" className="staff-link">
            <Wrench size={18} />
            {user.name} · {ROLE_LABELS[user.role]}
            <ArrowUpRight size={17} />
          </Link>
          <span className="version">邻里报修 AI · V0.4 / PRD V1.3</span>
        </div>
      </aside>
      <div className="app-main">
        <div className="topbar">
          <div className="site-name">
            <MapIcon />
            {site?.name || "邻里公共服务"}
            {bootstrap?.demoMode && <span className="demo-tag">演示空间</span>}
          </div>
          <div className="topbar-account">
            <Link href="/account" className="account-chip">
              <UserCircle size={20} />
              <span>{user.name}</span>
              <small>{ROLE_LABELS[user.role]}</small>
            </Link>
            <button
              className="text-button logout-button"
              disabled={loggingOut}
              onClick={() => {
                void signedOut().catch(() => undefined);
              }}
            >
              <SignOut size={18} />
              <span>{loggingOut ? "正在退出…" : "退出登录"}</span>
            </button>
          </div>
        </div>
        <main id="main" className="main-content">
          {logoutError && <Notice error>{logoutError}</Notice>}
          {denied ? (
            <>
              <PageHeader
                eyebrow="ACCESS / 访问权限"
                title="当前账号没有访问权限"
                text="该页面仅对对应身份开放。需要工作人员权限时，请联系本场地管理员开通账号。"
              />
              <Link
                href={destinationAfterLogin(user.role)}
                className="button primary"
              >
                返回我的空间
              </Link>
              <Link href="/account" className="button secondary">
                账号与安全
              </Link>
            </>
          ) : !site ? (
            <Notice error>尚未配置有效场地，请联系服务负责人。</Notice>
          ) : path === "/account" ? (
            <AccountPage user={user} onSignedOut={signedOut} />
          ) : path === "/staff/users" ? (
            <UsersPage user={user} />
          ) : ticketId ? (
            <TicketDetail
              key={`${user.id}:${staffMode}:${ticketId}`}
              id={ticketId}
              staffMode={staffMode}
              bootstrap={bootstrap}
            />
          ) : staffMode ? (
            <StaffPage key={user.id} bootstrap={bootstrap} path={path} />
          ) : path === "/new" ? (
            <NewReport key={user.id} bootstrap={bootstrap} />
          ) : (
            <ResidentHome key={user.id} listOnly={path === "/tickets"} />
          )}
        </main>
        <footer className="page-footer">
          <span>一起照顾好，我们的公共空间。</span>
          <span>
            非应急服务 · {site?.emergency || "紧急情况请使用现场应急渠道"}
          </span>
          <Link href="/account" className="footer-work-link">
            账号与安全
          </Link>
        </footer>
      </div>
      <nav className="mobile-nav" aria-label="移动端导航">
        <Link
          href={staffMode ? "/staff" : "/"}
          className={path === "/" || path === "/staff" ? "active" : ""}
        >
          <House size={23} />
          <span>{staffMode ? "工作台" : "首页"}</span>
        </Link>
        <Link href={staffMode ? "/staff/board" : "/new"} className="new-mobile">
          {staffMode ? <Columns size={22} /> : <Plus size={22} />}
          <span>{staffMode ? "状态看板" : "报个问题"}</span>
        </Link>
        <Link
          href={staffMode ? "/staff/tickets" : "/tickets"}
          className={path.includes("tickets") ? "active" : ""}
        >
          <ClipboardText size={23} />
          <span>{staffMode ? "场地工单" : "我的报修"}</span>
        </Link>
      </nav>
    </div>
  );
}
function MapIcon() {
  return <Buildings size={20} />;
}
function ResidentHome({ listOnly }: { listOnly: boolean }) {
  const [filters, setFilters] = useState<Filters>({
    ...DEFAULT_TICKET_FILTERS,
  });
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setTickets((await api.tickets()).tickets);
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const visibleTickets = listOnly
    ? filterTickets(tickets, filters)
    : tickets.slice(0, 4);
  const attention = tickets.filter(
    (t) => t.status === "needs_info" || t.status === "awaiting_confirmation",
  );
  return (
    <>
      <PageHeader
        eyebrow={
          listOnly ? "MY REPORTS / 我的记录" : "NEIGHBORHOOD SERVICE / 邻里服务"
        }
        title={listOnly ? "我的报修" : "让每一件小事，都有回音。"}
        text={
          listOnly
            ? "记录每一次反馈，也看见每一步进展。"
            : "公共照明、设施、环境问题，在这里告诉我们。"
        }
      />
      {!listOnly && (
        <section className="report-hero">
          <div>
            <span className="hero-kicker">
              <span className="live-dot" /> 随手报事 · 共同维护
            </span>
            <h2>
              发现问题？
              <br />
              我们一起解决。
            </h2>
            <p>
              拍张现场照片，或者写下你看到的情况。
              <br className="desktop-only" />
              简单说明，接下来的进展在这里查看。
            </p>
            <Link href="/new" className="button lime">
              报个问题 <ArrowRight size={23} />
            </Link>
          </div>
          <div className="neighborhood-art" aria-hidden="true">
            <div className="sun" />
            <div className="art-building building-left">
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
            </div>
            <div className="art-building building-right">
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
              <div className="art-door" />
            </div>
            <div className="art-tree">
              <span />
              <i />
            </div>
            <div className="art-ground" />
            <span className="art-caption">A BETTER PLACE, TOGETHER.</span>
          </div>
        </section>
      )}
      {!listOnly && (
        <div className="overview">
          <div>
            <span>进行中的报修</span>
            <strong>
              {loading
                ? "—"
                : tickets
                    .filter((t) => !["closed", "withdrawn"].includes(t.status))
                    .length.toString()
                    .padStart(2, "0")}
            </strong>
            <small>每一步进展，及时查看</small>
          </div>
          <div>
            <span>需要我的回应</span>
            <strong>
              {loading ? "—" : attention.length.toString().padStart(2, "0")}
            </strong>
            <small>补充情况或确认处理结果</small>
          </div>
          <div className="overview-tip">
            <ShieldCheck size={27} />
            <p>
              账号专属，安心反馈。<span>登录同一账号，随时查看报修进展。</span>
            </p>
          </div>
        </div>
      )}
      {error && (
        <Notice error>
          {error}
          <button className="text-button" onClick={() => void load()}>
            重试
          </button>
        </Notice>
      )}
      <SectionTitle
        title={listOnly ? "全部记录" : "最近的报修"}
        sub="仅展示归属于你当前账号的记录"
      >
        <div className="row">
          <button
            className="button secondary"
            aria-label="刷新报修记录"
            disabled={loading}
            onClick={() => void load()}
          >
            <ArrowClockwise size={18} />
            {loading ? "正在刷新…" : "刷新记录"}
          </button>
          {listOnly ? (
            <Link href="/new" className="button secondary">
              <Plus size={20} />
              新建报修
            </Link>
          ) : (
            tickets.length > 0 && (
              <Link href="/tickets" className="text-link">
                查看全部 <ArrowRight size={18} />
              </Link>
            )
          )}
        </div>
      </SectionTitle>
      {listOnly && <TicketFilters value={filters} onChange={setFilters} />}
      {listOnly && tickets.length > 0 && (
        <p className="field-hint">
          当前筛选 {visibleTickets.length} 条 / 我的报修共 {tickets.length} 条
        </p>
      )}
      {loading && tickets.length === 0 ? (
        <Loading />
      ) : visibleTickets.length ? (
        <TicketList tickets={visibleTickets} />
      ) : (
        <Empty
          title={tickets.length ? "没有符合筛选条件的报修" : "还没有报修记录"}
          action={
            <Link href="/new" className="text-link">
              发现公共区域问题？去报修 <ArrowRight size={18} />
            </Link>
          }
        >
          {tickets.length ? (
            "试试其他关键词、状态或类别，也可以清空筛选。"
          ) : (
            <>
              从一盏不亮的灯，到一处需要清理的角落，
              <br className="desktop-only" />
              你反馈的小事，也是大家关心的事。
            </>
          )}
        </Empty>
      )}
      <div className="home-notes">
        <span>温馨提醒</span>
        <p>
          这里处理公共区域的日常问题。涉及即时危险时，请远离危险区域，并使用现场公布的应急渠道。
        </p>
      </div>
    </>
  );
}

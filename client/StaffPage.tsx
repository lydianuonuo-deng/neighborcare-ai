import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowClockwise,
  ClipboardText,
  ShieldCheck,
} from "@phosphor-icons/react";
import type { Bootstrap, Ticket, TicketStatus } from "../shared/types";
import { STATUS_LABELS } from "../shared/types";
import { api, message } from "./api";
import {
  DEFAULT_TICKET_FILTERS,
  filterTickets,
  type TicketFilters as Filters,
} from "../shared/operations";
import TicketFilters from "./TicketFilters";
import TicketBoard from "./TicketBoard";
import StaffAnalytics from "./StaffAnalytics";
import {
  Empty,
  Loading,
  Notice,
  PageHeader,
  SectionTitle,
  TicketList,
  Link,
  navigate,
} from "./ui";

export default function StaffPage({
  bootstrap,
  path,
}: {
  bootstrap: Bootstrap;
  path: string;
}) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const loadVersion = useRef(0);
  const [filters, setFilters] = useState<Filters>({
    ...DEFAULT_TICKET_FILTERS,
  });
  const [page, setPage] = useState(1);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [exampleBusy, setExampleBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!bootstrap.staff) return;
    const requestVersion = ++loadVersion.current;
    setBusy(true);
    setError("");
    try {
      const result = await api.tickets(true);
      if (requestVersion !== loadVersion.current) return;
      setTickets(result.tickets);
      setRefreshVersion((value) => value + 1);
    } catch (e) {
      if (requestVersion === loadVersion.current) setError(message(e));
    } finally {
      if (requestVersion === loadVersion.current) setBusy(false);
    }
  }, [bootstrap.staff]);
  useEffect(() => {
    void load();
    return () => {
      loadVersion.current++;
    };
  }, [load, path]);
  if (!bootstrap.staff) return <Notice error>请先登录工作人员账号。</Notice>;
  const filtered = filterTickets(tickets, filters, bootstrap.staff.id);
  const view =
    path === "/staff/board"
      ? "board"
      : path === "/staff/analytics"
        ? "analytics"
        : path === "/staff/help"
          ? "help"
          : path === "/staff/tickets"
            ? "tickets"
            : "home";
  const titles = {
    home: "工作台",
    tickets: "工单中心",
    board: "状态看板",
    analytics: "数据统计",
    help: "服务说明",
  };
  const pages = Math.max(1, Math.ceil(filtered.length / 12));
  const currentPage = Math.min(page, pages);
  const manualCount = tickets.filter((ticket) => !ticket.isExample).length;
  function changeFilters(next: Filters) {
    setFilters(next);
    setPage(1);
  }
  function inspect(patch: Partial<Filters>, keepFilters = false) {
    changeFilters({
      ...(keepFilters ? filters : DEFAULT_TICKET_FILTERS),
      ...patch,
    });
    navigate("/staff/tickets");
  }
  async function examples() {
    setExampleBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api.loadExamples();
      setNotice(
        `只读样例已就绪：本次新增 ${result.created} 条，已有 ${result.existing} 条。`,
      );
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setExampleBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="STAFF WORKSPACE / 场地工作空间"
        title={titles[view]}
        text={`${bootstrap.staff.name}，你好。查看本场地报修、记录处理进展，让每一件事都有交代。`}
        action={
          <div className="workspace-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => void load()}
            >
              <ArrowClockwise size={18} />
              {busy ? "正在刷新…" : "刷新数据"}
            </button>
          </div>
        }
      />
      <nav className="workspace-nav" aria-label="工作台功能">
        {[
          ["/staff", "工作台"],
          ["/staff/tickets", "工单中心"],
          ["/staff/board", "状态看板"],
          ["/staff/analytics", "数据统计"],
          ["/staff/help", "服务说明"],
        ].map(([href, label]) => (
          <Link
            key={href}
            href={href}
            className={path === href ? "selected" : ""}
            aria-current={path === href ? "page" : undefined}
          >
            {label}
          </Link>
        ))}
      </nav>
      {bootstrap.demoMode && (
        <div className="demo-notice">
          演示空间 · 手动提交 {manualCount} 条，另有{" "}
          {tickets.length - manualCount} 条只读样例。与试点空间隔离。
        </div>
      )}
      {notice && <Notice>{notice}</Notice>}
      {error && <Notice error>{error}</Notice>}
      {bootstrap.demoMode && (
        <section className="demo-tools">
          <div>
            <strong>浏览不同阶段的只读样例</strong>
            <p>
              手动载入12条合成记录，不覆盖已有报修；重复点击不会追加。样例仅用于浏览，实际处理请从居民端新建报修。
            </p>
          </div>
          <button
            className="button secondary"
            disabled={exampleBusy || busy}
            onClick={() => void examples()}
          >
            {exampleBusy ? "正在载入…" : "载入12条只读样例"}
          </button>
        </section>
      )}
      {view === "home" && (
        <>
          <div className="staff-overview">
            {(
              [
                "pending",
                "processing",
                "needs_info",
                "awaiting_confirmation",
              ] as TicketStatus[]
            ).map((status) => (
              <button key={status} onClick={() => inspect({ status })}>
                <span>{STATUS_LABELS[status]}</span>
                <strong>
                  {tickets
                    .filter((ticket) => ticket.status === status)
                    .length.toString()
                    .padStart(2, "0")}
                </strong>
              </button>
            ))}
          </div>
          <section className="workspace-shortcuts" aria-label="快捷待办">
            <button
              onClick={() => inspect({ assignee: "mine", status: "active" })}
            >
              <ShieldCheck size={24} />
              <strong>我负责的进行中工单</strong>
              <span>
                {
                  tickets.filter(
                    (ticket) =>
                      ticket.assigneeId === bootstrap.staff?.id &&
                      !["closed", "withdrawn"].includes(ticket.status),
                  ).length
                }{" "}
                条待继续跟进 <ArrowRight size={18} />
              </span>
            </button>
            <button
              onClick={() =>
                inspect({
                  assignee: "unassigned",
                  status: "pending",
                  sort: "oldest",
                })
              }
            >
              <ClipboardText size={24} />
              <strong>查看待接单队列</strong>
              <span>
                按提交时间从早到晚查看 <ArrowRight size={18} />
              </span>
            </button>
            <button onClick={() => navigate("/staff/analytics")}>
              <ArrowClockwise size={24} />
              <strong>了解本场地报修分布</strong>
              <span>
                类别、状态、每日新增及导出 <ArrowRight size={18} />
              </span>
            </button>
          </section>
          <SectionTitle title="最近更新" sub="数量包含当前演示空间的只读样例">
            <button className="text-button" onClick={() => inspect({})}>
              查看全部 <ArrowRight size={18} />
            </button>
          </SectionTitle>
          {busy && !tickets.length ? (
            <Loading />
          ) : tickets.length ? (
            <TicketList tickets={filterTickets(tickets).slice(0, 6)} staff />
          ) : (
            <Empty title="还没有本场地报修">
              可以从居民端新建报修，或手动载入只读样例浏览工作台。
            </Empty>
          )}
        </>
      )}
      {["tickets", "board", "analytics"].includes(view) && (
        <TicketFilters
          value={filters}
          onChange={changeFilters}
          locations={bootstrap.locations}
          staff
        />
      )}
      {view === "tickets" && (
        <>
          <div className="result-summary">
            <span>
              筛选到 <strong>{filtered.length}</strong> 条记录
            </span>
            <span>每页12条 · 点击进入详情处理</span>
          </div>
          {busy && !tickets.length ? (
            <Loading />
          ) : filtered.length ? (
            <TicketList
              tickets={filtered.slice((currentPage - 1) * 12, currentPage * 12)}
              staff
            />
          ) : (
            <Empty title="没有符合筛选条件的工单">
              调整筛选或清空条件后再试。
            </Empty>
          )}
          {pages > 1 && (
            <nav className="pagination" aria-label="工单分页">
              <button
                className="button secondary"
                disabled={currentPage === 1}
                onClick={() => setPage(currentPage - 1)}
              >
                上一页
              </button>
              <span>
                第 {currentPage} / {pages} 页
              </span>
              <button
                className="button secondary"
                disabled={currentPage === pages}
                onClick={() => setPage(currentPage + 1)}
              >
                下一页
              </button>
            </nav>
          )}
        </>
      )}
      {view === "board" && (
        <>
          <p className="field-hint">
            按当前状态分组，共 {filtered.length}{" "}
            条。打开工单详情执行操作，所有变更仍按负责人和版本校验。
          </p>
          <TicketBoard
            tickets={filtered}
            onOpen={(status) => inspect({ status }, true)}
          />
        </>
      )}
      {view === "analytics" && (
        <StaffAnalytics
          filters={filters}
          refreshVersion={refreshVersion}
          onInspect={(patch) => inspect(patch, true)}
        />
      )}
      {view === "help" && (
        <div className="help-grid">
          <section className="analytics-panel">
            <h2>服务能力</h2>
            <dl className="service-capabilities">
              <div>
                <dt>报修与人工回执</dt>
                <dd>可使用</dd>
              </div>
              <div>
                <dt>AI辅助整理</dt>
                <dd>
                  {bootstrap.ai.enabled
                    ? "已配置，需通过实际任务验证"
                    : "未配置，可手动继续"}
                </dd>
              </div>
              <div>
                <dt>回执文字核对</dt>
                <dd>
                  {bootstrap.features.receiptCheck && bootstrap.ai.enabled
                    ? "已配置，保留人工检查"
                    : "使用人工对照"}
                </dd>
              </div>
              <div>
                <dt>事项反馈</dt>
                <dd>
                  {bootstrap.features.responseItems
                    ? "可使用"
                    : "可填写未解决原因"}
                </dd>
              </div>
            </dl>
            <p className="field-hint">
              配置状态不代表模型实测成功。AI只提供信息整理和文字核对建议，不替人确认维修效果。
            </p>
          </section>
          <section className="analytics-panel">
            <h2>处理一份报修</h2>
            <ol className="help-steps">
              <li>在工单中心打开原报，核对位置与完整说明。</li>
              <li>认领后记录进展；信息不足时向居民请求补充。</li>
              <li>人工确认需回应事项，上传处理照片并填写回执。</li>
              <li>人工核对或使用AI辅助检查后发布，由居民确认。</li>
              <li>居民反馈仍未解决时，工单重新待接单。</li>
            </ol>
          </section>
          <section className="analytics-panel">
            <h2>数据与样例</h2>
            <p>
              工作人员仅能访问本场地工单；居民仅能访问自己会话中的记录。演示样例有专门标识，只能浏览。
            </p>
            <p>
              统计是当前状态快照，汇总导出不含自由文本、身份或照片。样例数量不得当作试点成绩。
            </p>
          </section>
          <section className="analytics-panel">
            <h2>使用中的边界</h2>
            <p>
              当前入口处理公共空间日常问题。即时危险请远离风险位置并使用现场应急渠道。
            </p>
            <p>
              工作人员不能代居民确认解决，图片和文字核对也不能证明现场安全。居民可以登录报修时的账号查看进展。
            </p>
            <Link href="/new" className="text-link">
              从居民端新建报修 <ArrowRight size={18} />
            </Link>
          </section>
        </div>
      )}
    </>
  );
}

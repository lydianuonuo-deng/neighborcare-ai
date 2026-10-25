import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowClockwise,
  ArrowRight,
  Check,
  Clock,
  MapPin,
  ShieldCheck,
} from "@phosphor-icons/react";
import type {
  Bootstrap,
  EventAction,
  EventInput,
  Receipt,
  Ticket,
} from "../shared/types";
import { CATEGORY_LABELS } from "../shared/types";
import { api, key, message } from "./api";
import {
  date,
  Link,
  Loading,
  Notice,
  PageHeader,
  Photos,
  SectionTitle,
  Status,
} from "./ui";
import ReceiptEditor from "./ReceiptEditor";

const actions: Record<string, string> = {
  created: "报修已提交",
  claim: "工作人员已接单",
  progress: "更新处理进展",
  request_info: "需要补充情况",
  reply_info: "居民补充情况",
  receipt: "发布处理回执",
  confirm: "居民确认解决",
  reopen: "居民反馈未解决",
  withdraw: "居民撤回报修",
  return: "工作人员退回工单",
};
export default function TicketDetail({
  id,
  staffMode,
  bootstrap,
}: {
  id: string;
  staffMode: boolean;
  bootstrap: Bootstrap;
}) {
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [action, setAction] = useState<EventAction>("progress");
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackKind, setFeedbackKind] = useState<
    "items" | "other" | "not_sure"
  >("items");
  const [itemIds, setItemIds] = useState<string[]>([]);
  const [feedbackReason, setFeedbackReason] = useState("");
  const eventKeys = useRef(new Map<string, string>());
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setTicket(await api.ticket(id));
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  async function event(next: Omit<EventInput, "version" | "idempotencyKey">) {
    if (!ticket) return;
    setBusy(true);
    setError("");
    const content = { ...next, version: ticket.version };
    const fingerprint = JSON.stringify(content);
    const idempotencyKey = eventKeys.current.get(fingerprint) || key();
    eventKeys.current.set(fingerprint, idempotencyKey);
    try {
      const updated = await api.event(ticket.id, {
        ...content,
        idempotencyKey,
      });
      setTicket(updated);
      setReason("");
      setFeedbackOpen(false);
      setItemIds([]);
      setFeedbackReason("");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  if (staffMode && !bootstrap.staff)
    return (
      <>
        <PageHeader
          back="/staff"
          eyebrow="STAFF ACCESS"
          title="请先登录工作人员账户"
        />
        <Notice>登录后才能查看本场地的报修详情。</Notice>
        <Link href="/staff" className="button primary">
          前往登录
          <ArrowRight size={20} />
        </Link>
      </>
    );
  if (loading && !ticket) return <Loading text="正在读取报修记录…" />;
  if (!ticket)
    return (
      <>
        <PageHeader
          back={staffMode ? "/staff/tickets" : "/tickets"}
          eyebrow="REPORT ACCESS / 查询报修"
          title="暂时无法查看这份报修"
        />
        <Notice error>
          {error || "未找到记录。"}
          <p>
            请确认已登录提交这份报修的居民账号。链接和工单号不授予访问权限；如仍无法查看，可联系场地服务人员。
          </p>
        </Notice>
        <button className="button secondary" onClick={() => void load()}>
          重新读取
        </button>
      </>
    );
  const receipt = ticket.currentReceipt;
  const assigned =
    staffMode && !ticket.isExample && ticket.assigneeId === bootstrap.staff?.id;
  const canReopen =
    receipt &&
    (ticket.status === "awaiting_confirmation" ||
      (ticket.status === "closed" &&
        !!ticket.closedAt &&
        Date.now() - Date.parse(ticket.closedAt) <= 7 * 86400000));
  const feedbackHasItems = !!(
    bootstrap.features.responseItems && receipt?.items.length
  );
  return (
    <>
      <PageHeader
        back={staffMode ? "/staff/tickets" : "/tickets"}
        eyebrow={`REPORT DETAIL / ${ticket.number}`}
        title="每一步进展，都在这里。"
        action={
          <button
            className="button secondary"
            disabled={loading || busy}
            onClick={() => void load()}
          >
            <ArrowClockwise size={18} />
            刷新进展
          </button>
        }
      />
      {ticket.isExample && (
        <Notice>
          这是只读演示样例，合成内容仅用于浏览状态与界面，不代表真实报修或处理结果。请新建报修体验实际操作。
        </Notice>
      )}
      {window.location.search.includes("submitted=1") &&
        !staffMode &&
        !ticket.isExample && (
          <Notice>
            报修已提交，等待工作人员查看。请收藏这个查询入口，登录当前账号即可继续查看进展。
          </Notice>
        )}
      {error && (
        <Notice error>
          {error}
          <button className="text-button" onClick={() => void load()}>
            刷新当前记录
          </button>
        </Notice>
      )}
      <div className="detail-banner">
        <Status value={ticket.status} />
        <div>
          <strong>
            {ticket.status === "pending"
              ? "已收到，等待工作人员查看"
              : ticket.status === "processing"
                ? "已接单，正在跟进处理"
                : ticket.status === "needs_info"
                  ? "还需要你补充一些情况"
                  : ticket.status === "awaiting_confirmation"
                    ? "已发布回执，请核对处理情况"
                    : ticket.status === "closed"
                      ? "你已确认本次问题解决"
                      : "本次报修已撤回"}
          </strong>
          <p>
            {ticket.assigneeName
              ? `当前负责人：${ticket.assigneeName}`
              : "处理进展会记录在下方时间线中。"}
          </p>
        </div>
        <Clock size={30} />
      </div>
      <div className="detail-layout">
        <div>
          <section className="paper-section">
            <SectionTitle
              title="原始报修"
              sub="保留完整现场说明，作为沟通依据"
            />
            <div className="original-meta">
              <span>
                <MapPin size={18} />
                {ticket.locationName}
              </span>
              <span>{CATEGORY_LABELS[ticket.category]}</span>
              <span>{date(ticket.createdAt)}</span>
            </div>
            <p className="original-description">{ticket.description}</p>
            {(ticket.needsReview || ticket.stopReason) && (
              <Notice>
                {ticket.needsReview && <strong>待人工核对。 </strong>}
                {ticket.stopReason && <strong>保留未知。 </strong>}
                {ticket.stopReason === "not_sure"
                  ? "居民已选择“不确定”，现有内容不会被视为已证实。"
                  : ticket.stopReason === "skip"
                    ? "居民已跳过补问，请根据完整原始说明继续人工沟通。"
                    : "请结合原始说明判断受理所需的信息，不根据照片或整理建议推断原因与安全。"}
              </Notice>
            )}
            <Photos photos={ticket.attachments} label="报修照片" />
            {ticket.facts.length > 0 && (
              <details className="source-details">
                <summary>查看当时确认的信息来源</summary>
                {ticket.facts.slice(0, 3).map((fact) => (
                  <div className="fact" key={fact.id}>
                    <span className="source-tag">
                      {fact.origin === "photo"
                        ? "照片提示"
                        : fact.origin === "reported"
                          ? "居民陈述"
                          : "图文共同"}
                    </span>
                    {fact.needsConfirmation && (
                      <span className="review-tag">当时待核对</span>
                    )}
                    <p>{fact.text}</p>
                    <span className="small muted">
                      依据：{fact.evidenceRefs.join("、")}
                    </span>
                  </div>
                ))}
              </details>
            )}
          </section>
          {receipt && (
            <section className="paper-section">
              <PublishedReceipt receipt={receipt} />
              {!staffMode &&
                !ticket.isExample &&
                ticket.status === "awaiting_confirmation" && (
                  <div className="receipt-actions">
                    <p>
                      请根据现场情况自行确认，文字核对不能证明问题已经修好。
                    </p>
                    <div className="button-row">
                      <button
                        className="button primary"
                        disabled={busy}
                        onClick={() =>
                          void event({
                            action: "confirm",
                            receiptId: receipt.id,
                            receiptVersion: receipt.version,
                          })
                        }
                      >
                        <Check size={20} />
                        确认已解决
                      </button>
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() => setFeedbackOpen(true)}
                      >
                        仍未解决 / 暂无法确认
                      </button>
                    </div>
                  </div>
                )}
              {!staffMode &&
                !ticket.isExample &&
                ticket.status === "closed" &&
                (canReopen ? (
                  <div className="receipt-actions">
                    <p>关闭后 7 天内仍可反馈同一问题。</p>
                    <button
                      className="button secondary"
                      onClick={() => setFeedbackOpen(true)}
                    >
                      问题仍在，反馈重开
                    </button>
                  </div>
                ) : (
                  <Notice>
                    此工单关闭已超过 7 天。如有新情况，请重新报修。
                  </Notice>
                ))}
              {!staffMode && !ticket.isExample && feedbackOpen && canReopen && (
                <div className="feedback-box">
                  <h3>还有哪些情况需要继续跟进？</h3>
                  <p className="field-hint">
                    提交后，本工单会重新进入待接单状态，由工作人员继续查看。
                  </p>
                  {feedbackHasItems && (
                    <fieldset>
                      <legend>选择仍未解决的事项，可多选</legend>
                      {receipt.items.map((item) => (
                        <label className="check-label" key={item.id}>
                          <input
                            type="checkbox"
                            checked={
                              feedbackKind === "items" &&
                              itemIds.includes(item.id)
                            }
                            onChange={(e) => {
                              setFeedbackKind("items");
                              setItemIds(
                                e.target.checked
                                  ? [...itemIds, item.id]
                                  : itemIds.filter(
                                      (value) => value !== item.id,
                                    ),
                              );
                            }}
                          />
                          <span>{item.text}</span>
                        </label>
                      ))}
                    </fieldset>
                  )}
                  <label className="check-label">
                    <input
                      type="radio"
                      name="feedback"
                      checked={feedbackKind === "other"}
                      onChange={() => {
                        setFeedbackKind("other");
                        setItemIds([]);
                      }}
                    />
                    <span>其他问题</span>
                  </label>
                  <label className="check-label">
                    <input
                      type="radio"
                      name="feedback"
                      checked={feedbackKind === "not_sure"}
                      onChange={() => {
                        setFeedbackKind("not_sure");
                        setItemIds([]);
                      }}
                    />
                    <span>暂时无法确认 / 看不懂回执</span>
                  </label>
                  <div className="field">
                    <label htmlFor="feedback-reason">
                      补充说明{" "}
                      {feedbackHasItems && feedbackKind === "items"
                        ? "（选填）"
                        : "（必填）"}
                    </label>
                    <textarea
                      id="feedback-reason"
                      rows={3}
                      maxLength={300}
                      value={feedbackReason}
                      onChange={(e) => setFeedbackReason(e.target.value)}
                      placeholder="告诉工作人员还需要跟进的情况。"
                    />
                  </div>
                  {feedbackKind === "not_sure" && (
                    <Notice>
                      如果只是想再看看本次回执，可以先取消。点击“提交反馈并重开”后才会改变工单状态。
                    </Notice>
                  )}
                  <div className="button-row">
                    <button
                      className="button primary"
                      disabled={
                        busy ||
                        (feedbackHasItems && feedbackKind === "items"
                          ? !itemIds.length
                          : !feedbackReason.trim())
                      }
                      onClick={() =>
                        void event({
                          action: "reopen",
                          receiptId: receipt.id,
                          receiptVersion: receipt.version,
                          ...(feedbackHasItems
                            ? {
                                scopeVersion: receipt.scopeVersion,
                                feedbackKind,
                                itemIds:
                                  feedbackKind === "items" ? itemIds : [],
                              }
                            : {}),
                          reason: feedbackReason,
                        })
                      }
                    >
                      提交反馈并重开
                    </button>
                    <button
                      className="button secondary"
                      onClick={() => setFeedbackOpen(false)}
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}
          {!staffMode &&
            !ticket.isExample &&
            ticket.status === "needs_info" && (
              <section className="paper-section">
                <SectionTitle
                  title="补充现场情况"
                  sub="你的回复会完整保留在工单中"
                />
                <Notice>
                  {[...ticket.events]
                    .reverse()
                    .find((event) => event.action === "request_info")?.reason ||
                    "请按工作人员的问题补充情况。"}
                </Notice>
                <div className="field">
                  <label htmlFor="reply">我的补充说明</label>
                  <textarea
                    id="reply"
                    maxLength={500}
                    rows={4}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </div>
                <button
                  className="button primary"
                  disabled={busy || !reason.trim()}
                  onClick={() => void event({ action: "reply_info", reason })}
                >
                  发送补充
                  <ArrowRight size={20} />
                </button>
              </section>
            )}
          {staffMode && !ticket.isExample && (
            <section className="paper-section">
              <SectionTitle
                title="处理操作"
                sub="所有进展和状态变化都会保留记录"
              />
              {ticket.status === "pending" && (
                <div className="button-row">
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() => void event({ action: "claim" })}
                  >
                    认领并开始处理
                    <ArrowRight size={20} />
                  </button>
                </div>
              )}
              {(ticket.status === "pending" ||
                (assigned &&
                  ["processing", "needs_info"].includes(ticket.status))) && (
                <div className="staff-action-form">
                  <div className="field">
                    <label htmlFor="action">记录类型</label>
                    <select
                      id="action"
                      value={
                        ticket.status === "pending"
                          ? "request_info"
                          : ticket.status === "needs_info"
                            ? "return"
                            : action
                      }
                      onChange={(e) => setAction(e.target.value as EventAction)}
                    >
                      {ticket.status === "processing" && (
                        <option value="progress">更新处理进展</option>
                      )}
                      {ticket.status !== "needs_info" && (
                        <option value="request_info">请求居民补充</option>
                      )}
                      {assigned && <option value="return">退回待接单</option>}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="staff-reason">具体说明</label>
                    <textarea
                      id="staff-reason"
                      maxLength={500}
                      rows={3}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="写下已做的工作、需要补充的内容，或无法继续处理的原因。"
                    />
                  </div>
                  <button
                    className="button secondary"
                    disabled={busy || !reason.trim()}
                    onClick={() =>
                      void event({
                        action:
                          ticket.status === "pending"
                            ? "request_info"
                            : ticket.status === "needs_info"
                              ? "return"
                              : action,
                        reason,
                      })
                    }
                  >
                    保存这条记录
                  </button>
                </div>
              )}
              {ticket.status === "processing" && !assigned && (
                <Notice>
                  当前负责人为 {ticket.assigneeName}
                  。仅负责人可以更新进展、编辑回执或退回。
                </Notice>
              )}
              {["awaiting_confirmation", "closed", "withdrawn"].includes(
                ticket.status,
              ) && (
                <Notice>
                  当前无需工作人员操作。居民会根据实际情况确认或继续反馈。
                </Notice>
              )}
            </section>
          )}
          {assigned && ticket.status === "processing" && (
            <ReceiptEditor
              key={`${ticket.id}:${ticket.version}`}
              ticket={ticket}
              bootstrap={bootstrap}
              onPublished={setTicket}
            />
          )}
          <section className="paper-section">
            <SectionTitle title="处理时间线" sub="保留每一次沟通与反馈" />
            <ol className="timeline">
              {[...ticket.events].reverse().map((event) => (
                <li key={event.id}>
                  <span className="timeline-dot" />
                  <div className="row spread">
                    <h3>{actions[event.action] || event.action}</h3>
                    <time>{date(event.createdAt)}</time>
                  </div>
                  <span className="timeline-actor">{event.actorName}</span>
                  {event.reason && <p>{event.reason}</p>}
                  {event.feedback && (
                    <p className="feedback-summary">
                      反馈：
                      {event.feedback.kind === "items"
                        ? event.feedback.itemTexts.join("；")
                        : event.feedback.kind === "not_sure"
                          ? "暂时无法确认"
                          : "其他问题"}
                    </p>
                  )}
                  {event.receipt && event.receipt.id !== receipt?.id && (
                    <details>
                      <summary>查看此版完整回执</summary>
                      <PublishedReceipt receipt={event.receipt} />
                    </details>
                  )}
                </li>
              ))}
            </ol>
          </section>
        </div>
        <aside className="detail-aside">
          <ShieldCheck size={29} weight="duotone" />
          <h3>{staffMode ? "回应每一件小事" : "把查询入口留在身边"}</h3>
          <p>
            {staffMode
              ? "完整原报内容始终可见。回执中的每条事项应引用居民原话，AI 只核对是否写明回应，不判断维修质量。"
              : "这份报修归属于你的账号。换设备后登录同一账号，也能查看进展。"}
          </p>
          <div className="aside-divider" />
          <dl>
            <dt>报修编号</dt>
            <dd>{ticket.number}</dd>
            <dt>最后更新</dt>
            <dd>{date(ticket.updatedAt)}</dd>
            <dt>所属场地</dt>
            <dd>{ticket.siteName}</dd>
          </dl>
          {!staffMode && !ticket.isExample && ticket.status === "pending" && (
            <details>
              <summary>需要撤回这次报修？</summary>
              <p>仅未开始处理的工单可以撤回，历史记录仍会保留。</p>
              <div className="field">
                <label htmlFor="withdraw-reason">撤回原因（选填）</label>
                <textarea
                  id="withdraw-reason"
                  rows={2}
                  value={reason}
                  maxLength={300}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void event({ action: "withdraw", reason })}
              >
                确认撤回报修
              </button>
            </details>
          )}
        </aside>
      </div>
    </>
  );
}
export function PublishedReceipt({ receipt }: { receipt: Receipt }) {
  return (
    <div className="published-receipt">
      <SectionTitle
        title="处理回执"
        sub={`第 ${receipt.version} 版 · ${date(receipt.createdAt)}`}
      />
      <p className="original-description">{receipt.description}</p>
      {receipt.items.length > 0 && (
        <div className="receipt-items">
          <h3>本次回应的事项</h3>
          <p className="field-hint">
            事项是工作人员整理的回应范围，完整原始诉求见上方。
          </p>
          {receipt.items.map((item, index) => {
            const coverage = receipt.coverage?.rows.find(
              (row) => row.itemId === item.id,
            );
            return (
              <article key={item.id}>
                <span className="item-index">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div>
                  <h4>{item.text}</h4>
                  <details>
                    <summary>查看引用的居民原话</summary>
                    {item.sourceRefs.map((ref, i) => (
                      <blockquote key={i}>{ref.quote}</blockquote>
                    ))}
                  </details>
                  {coverage ? (
                    <div className={`coverage ${coverage.status}`}>
                      <strong>
                        {coverage.status === "response_found"
                          ? "有对应说明"
                          : coverage.status === "response_missing"
                            ? "未找到对应说明"
                            : "对应关系不清"}
                      </strong>
                      <p>{coverage.explanation}</p>
                      {coverage.receiptTextRefs.map((ref) => (
                        <blockquote key={ref}>
                          {receipt.segments.find(
                            (segment) => segment.id === ref,
                          )?.text || "原句暂不可读"}
                        </blockquote>
                      ))}
                    </div>
                  ) : (
                    <p className="small muted">
                      本次未使用自动文字核对，请人工对照回执全文。
                    </p>
                  )}
                </div>
              </article>
            );
          })}
          <p className="small muted">
            核对仅提示文字是否回应，不代表问题已解决或维修质量合格。
          </p>
        </div>
      )}
      <div className="receipt-photo-title">本次处理照片</div>
      <Photos photos={receipt.attachments} label="处理照片" />
    </div>
  );
}

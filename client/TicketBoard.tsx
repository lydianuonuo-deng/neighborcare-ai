import type { Ticket, TicketStatus } from "../shared/types";
import { CATEGORY_LABELS, STATUS_LABELS } from "../shared/types";
import { date, Link } from "./ui";

export default function TicketBoard({
  tickets,
  onOpen,
}: {
  tickets: Ticket[];
  onOpen: (status: TicketStatus) => void;
}) {
  return (
    <div className="ticket-board">
      {(Object.entries(STATUS_LABELS) as [TicketStatus, string][]).map(
        ([status, label]) => {
          const group = tickets.filter((ticket) => ticket.status === status);
          return (
            <section
              className={`board-column board-${status}`}
              key={status}
              aria-label={`${label}看板`}
            >
              <header>
                <h2>{label}</h2>
                <span>{group.length}</span>
              </header>
              <div className="board-cards">
                {group.slice(0, 8).map((ticket) => (
                  <Link
                    key={ticket.id}
                    href={`/staff/tickets/${ticket.id}`}
                    className="board-card"
                  >
                    <div className="row spread">
                      <span className="eyebrow">{ticket.number}</span>
                      {ticket.isExample && (
                        <span className="example-badge">只读样例</span>
                      )}
                    </div>
                    <h3>{ticket.description}</h3>
                    <p>{ticket.locationName}</p>
                    <div className="row spread">
                      <span className="board-category">
                        {CATEGORY_LABELS[ticket.category]}
                      </span>
                      <time>{date(ticket.updatedAt)}</time>
                    </div>
                    {ticket.assigneeName && (
                      <small>负责人：{ticket.assigneeName}</small>
                    )}
                  </Link>
                ))}
                {!group.length && (
                  <p className="board-empty">当前没有{label}的工单</p>
                )}
              </div>
              {group.length > 8 && (
                <button className="text-button" onClick={() => onOpen(status)}>
                  查看全部 {group.length} 条
                </button>
              )}
            </section>
          );
        },
      )}
    </div>
  );
}

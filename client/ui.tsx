import { date } from "./format";
import {
  ArrowLeft,
  ArrowRight,
  CaretRight,
  Check,
  CircleNotch,
  Clock,
  MapPin,
  WarningCircle,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { Attachment, Ticket, TicketStatus } from "../shared/types";
import { CATEGORY_LABELS, STATUS_LABELS } from "../shared/types";

export function navigate(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo({ top: 0, behavior: "instant" });
}
export function Link({
  href,
  children,
  className = "",
  ...props
}: {
  href: string;
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
  "aria-current"?: "page";
}) {
  return (
    <a
      href={href}
      className={className}
      {...props}
      onClick={(e) => {
        if (!e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
          e.preventDefault();
          navigate(href);
        }
      }}
    >
      {children}
    </a>
  );
}
export function Notice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className={`notice ${error ? "error" : ""}`}
      role={error ? "alert" : "status"}
    >
      <WarningCircle size={22} weight="bold" />
      <div>{children}</div>
    </div>
  );
}
export function Loading({ text = "正在读取…" }: { text?: string }) {
  return (
    <div className="loading" role="status">
      <CircleNotch className="spin" size={24} />
      <span>{text}</span>
    </div>
  );
}
export function Status({ value }: { value: TicketStatus }) {
  return (
    <span className={`status ${value}`}>
      <span />
      {STATUS_LABELS[value]}
    </span>
  );
}
export { date } from "./format";
export function Photos({
  photos,
  label = "现场照片",
  remove,
}: {
  photos: Attachment[];
  label?: string;
  remove?: (photo: Attachment) => void;
}) {
  return photos.length ? (
    <div className="photos">
      {photos.map((photo, index) => (
        <figure key={photo.id}>
          <a
            href={photo.url}
            target="_blank"
            rel="noreferrer"
            aria-label={`查看${label} ${index + 1}，在新窗口打开`}
          >
            <img src={photo.url} alt={`${label} ${index + 1}`} loading="lazy" />
          </a>
          <figcaption>
            {label} {index + 1}
            {remove && (
              <button
                type="button"
                className="text-button"
                onClick={() => remove(photo)}
                aria-label={`移除${label} ${index + 1}`}
              >
                移除
              </button>
            )}
          </figcaption>
        </figure>
      ))}
    </div>
  ) : null;
}
export function TicketList({
  tickets,
  staff = false,
}: {
  tickets: Ticket[];
  staff?: boolean;
}) {
  return (
    <div className="ticket-list">
      {tickets.map((ticket) => (
        <Link
          className="ticket-row"
          key={ticket.id}
          href={`${staff ? "/staff" : ""}/tickets/${ticket.id}`}
        >
          <div className="ticket-category">
            {CATEGORY_LABELS[ticket.category].slice(0, 2)}
          </div>
          <div className="ticket-body">
            <div className="row spread">
              <span className="eyebrow">{ticket.number}</span>
              {ticket.isExample && (
                <span className="example-badge">只读样例</span>
              )}
              <Status value={ticket.status} />
            </div>
            <h3>{ticket.description}</h3>
            <div className="ticket-meta">
              <span>
                <MapPin size={16} />
                {ticket.locationName}
              </span>
              <span>{date(ticket.createdAt)}</span>
              {staff && ticket.assigneeName && (
                <span>负责人 {ticket.assigneeName}</span>
              )}
            </div>
          </div>
          <CaretRight size={22} className="row-chevron" />
        </Link>
      ))}
    </div>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-symbol">
        <Check size={30} />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function PageHeader({
  eyebrow,
  title,
  text,
  back,
  action,
}: {
  eyebrow: string;
  title: string;
  text?: string;
  back?: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-header">
      {back && (
        <Link href={back} className="back">
          <ArrowLeft size={18} />
          返回
        </Link>
      )}
      <div className="row spread align-start">
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <h1>{title}</h1>
          {text && <p>{text}</p>}
        </div>
        {action}
      </div>
    </header>
  );
}
export function SectionTitle({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string;
  children?: ReactNode;
}) {
  return (
    <div className="section-title row spread">
      <div>
        <h2>{title}</h2>
        {sub && <p>{sub}</p>}
      </div>
      {children}
    </div>
  );
}
export function ArrowButton({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <ArrowRight size={20} />
    </>
  );
}
export function TimeLabel({ value }: { value: string }) {
  return (
    <span className="muted small">
      <Clock size={16} /> {date(value)}
    </span>
  );
}

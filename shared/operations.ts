import type { Category, Ticket, TicketStatus } from "./types.js";
import { CATEGORY_LABELS } from "./types.js";

export interface TicketFilters {
  query: string;
  status: TicketStatus | "all" | "active" | "attention" | "ended";
  category: Category | "all";
  locationId: string;
  assignee: "all" | "mine" | "unassigned";
  source: "all" | "manual" | "example";
  period: "all" | "7" | "30";
  sort: "updated" | "newest" | "oldest";
}
export const DEFAULT_TICKET_FILTERS: Readonly<TicketFilters> = Object.freeze({
  query: "",
  status: "all",
  category: "all",
  locationId: "",
  assignee: "all",
  source: "all",
  period: "all",
  sort: "updated",
});
export interface OperationsSummary {
  generatedAt: string;
  filters: TicketFilters;
  totals: {
    total: number;
    active: number;
    attention: number;
    closed: number;
    withdrawn: number;
    examples: number;
  };
  byStatus: { key: TicketStatus; label: string; count: number }[];
  byCategory: { key: Category; label: string; count: number }[];
  byLocation: { key: string; label: string; count: number }[];
  daily: { date: string; count: number }[];
}
export interface ExampleLoadResult {
  created: number;
  existing: number;
}
export const chinaDateKey = (value: string | number | Date) =>
  new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 10);
export function filterTickets(
  tickets: readonly Ticket[],
  input: Partial<TicketFilters> = {},
  staffId?: string,
  clock = Date.now(),
): Ticket[] {
  const filters = { ...DEFAULT_TICKET_FILTERS, ...input };
  const words = filters.query
    .trim()
    .normalize("NFKC")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const day = 86400000;
  const start = Math.floor((clock + 8 * 3600000) / day) * day - 8 * 3600000;
  return tickets
    .filter((ticket) => {
      const active =
        ticket.status !== "closed" && ticket.status !== "withdrawn";
      if (
        (filters.status === "active" && !active) ||
        (filters.status === "ended" && active)
      )
        return false;
      if (
        filters.status === "attention" &&
        !["needs_info", "awaiting_confirmation"].includes(ticket.status)
      )
        return false;
      if (
        !["all", "active", "ended", "attention"].includes(filters.status) &&
        ticket.status !== filters.status
      )
        return false;
      if (filters.category !== "all" && ticket.category !== filters.category)
        return false;
      if (filters.locationId && ticket.locationId !== filters.locationId)
        return false;
      if (
        filters.assignee === "mine" &&
        (!staffId || ticket.assigneeId !== staffId)
      )
        return false;
      if (filters.assignee === "unassigned" && ticket.assigneeId !== null)
        return false;
      if (
        (filters.source === "manual" && ticket.isExample === true) ||
        (filters.source === "example" && ticket.isExample !== true)
      )
        return false;
      if (filters.period !== "all") {
        const time = Date.parse(ticket.createdAt);
        if (
          !Number.isFinite(time) ||
          time > clock ||
          time < start - (Number(filters.period) - 1) * day
        )
          return false;
      }
      const haystack = [
        ticket.number,
        ticket.description,
        ticket.locationName,
        CATEGORY_LABELS[ticket.category],
      ]
        .join(" ")
        .normalize("NFKC")
        .toLowerCase();
      return words.every((word) => haystack.includes(word));
    })
    .sort((a, b) => {
      const field = filters.sort === "updated" ? "updatedAt" : "createdAt";
      const direction = filters.sort === "oldest" ? 1 : -1;
      return (
        direction * a[field].localeCompare(b[field]) || a.id.localeCompare(b.id)
      );
    });
}

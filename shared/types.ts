export type Category = "lighting" | "facility" | "cleaning" | "unknown";
export const CATEGORY_LABELS: Record<Category, string> = {
  lighting: "公共照明",
  facility: "设施损坏",
  cleaning: "环境清洁",
  unknown: "暂不确定",
};
export type TicketStatus =
  | "pending"
  | "processing"
  | "needs_info"
  | "awaiting_confirmation"
  | "closed"
  | "withdrawn";
export const STATUS_LABELS: Record<TicketStatus, string> = {
  pending: "待接单",
  processing: "处理中",
  needs_info: "待补充",
  awaiting_confirmation: "待确认",
  closed: "已关闭",
  withdrawn: "已撤回",
};
export interface Location {
  id: string;
  siteId: string;
  name: string;
}
export interface Site {
  id: string;
  name: string;
  emergency: string;
  demo: boolean;
}
export interface Staff {
  id: string;
  name: string;
  username: string;
  siteId: string;
  role: "staff" | "admin";
}
export interface Bootstrap {
  sites: Site[];
  locations: Location[];
  staff: Staff | null;
  user: import("./auth.js").PublicAccount | null;
  guestId: string | null;
  demoMode: boolean;
  ai: { enabled: boolean; model: string };
  features: {
    semantic: boolean;
    receiptCheck: boolean;
    responseItems: boolean;
  };
}
export interface Attachment {
  id: string;
  url: string;
  fileName: string;
  mime: string;
  size: number;
  createdAt: string;
}
export interface Fact {
  id: string;
  text: string;
  origin: "photo" | "reported" | "mixed";
  evidenceRefs: string[];
  needsConfirmation: boolean;
}
export type GapKind = "object" | "phenomenon" | "conflict";
export interface SemanticGap {
  kind: GapKind;
  factIds: string[];
  policyId: string;
}
export interface AnalysisResult {
  category: Category;
  facts: Fact[];
  gap: SemanticGap | null;
  needsReview: boolean;
  summary?: string;
}
export interface AnalyzeInput {
  description: string;
  category: Category;
  images: { id: string; dataUrl: string }[];
  inputVersion: number;
}
export interface Clarification {
  id: string;
  inputVersion: number;
  kind: "location" | "semantic";
  policyId: string;
  text: string;
}
export interface ClarificationAnswer {
  questionId: string;
  inputVersion: number;
  kind: "text" | "photo" | "not_sure" | "skip";
  value?: string;
  attachmentIds?: string[];
}
export interface Draft {
  id: string;
  version: number;
  siteId: string;
  locationId: string | null;
  category: Category;
  description: string;
  attachmentIds: string[];
  attachments: Attachment[];
  analysis: AnalysisResult | null;
  question: Clarification | null;
  clarificationCount: number;
  semanticCount: number;
  stopReason: string | null;
  updatedAt: string;
}
export interface DraftPatch {
  version: number;
  locationId?: string | null;
  category?: Category;
  description?: string;
  attachmentIds?: string[];
  answer?: ClarificationAnswer;
}
export interface SubmitTicket {
  draftId: string;
  version: number;
  category: Category;
  locationId: string;
  description: string;
  confirmed: true;
  idempotencyKey: string;
}
export interface SourceRef {
  source: "submission" | "supplement";
  sourceId: string;
  quote: string;
}
export interface ResponseItem {
  id: string;
  text: string;
  sourceRefs: SourceRef[];
}
export interface ReceiptSegment {
  id: string;
  text: string;
}
export interface CoverageRow {
  itemId: string;
  status: "response_found" | "response_missing" | "unclear";
  receiptTextRefs: string[];
  explanation: string;
}
export interface ReceiptCoverageResult {
  rows: CoverageRow[];
}
export interface ReceiptCheckInput {
  description: string;
  supplements: { id: string; text: string }[];
  items: ResponseItem[];
  segments: ReceiptSegment[];
}
export interface ReceiptDraft {
  segments?: ReceiptSegment[];
  id: string;
  ticketId: string;
  version: number;
  scopeVersion: number;
  items: ResponseItem[];
  description: string;
  attachmentIds: string[];
  attachments: Attachment[];
  check: ReceiptCoverageResult | null;
  checkTaskId: string | null;
}
export interface ReceiptDraftInput {
  version: number;
  draftVersion?: number;
  scopeVersion?: number;
  items: ResponseItem[];
  description: string;
  attachmentIds: string[];
}
export interface Receipt {
  id: string;
  version: number;
  scopeVersion: number;
  items: ResponseItem[];
  description: string;
  attachments: Attachment[];
  coverage: ReceiptCoverageResult | null;
  segments: ReceiptSegment[];
  createdAt: string;
}
export type EventAction =
  | "claim"
  | "progress"
  | "request_info"
  | "reply_info"
  | "receipt"
  | "confirm"
  | "reopen"
  | "withdraw"
  | "return";
export interface TicketEvent {
  id: string;
  action: EventAction | "created";
  actorName: string;
  createdAt: string;
  reason: string;
  fromStatus: TicketStatus | null;
  toStatus: TicketStatus;
  receipt?: Receipt;
  feedback?: {
    kind: "items" | "other" | "not_sure";
    itemIds: string[];
    itemTexts: string[];
  };
}
export interface Ticket {
  isExample?: boolean;
  needsReview?: boolean;
  stopReason?: string | null;
  inputVersion?: number;
  id: string;
  number: string;
  siteId: string;
  siteName: string;
  locationId: string;
  locationName: string;
  category: Category;
  description: string;
  submissionId: string;
  status: TicketStatus;
  assigneeId: string | null;
  assigneeName: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  returnStatus: TicketStatus | null;
  facts: Fact[];
  attachments: Attachment[];
  events: TicketEvent[];
  currentReceipt: Receipt | null;
  receiptDraft: ReceiptDraft | null;
}
export interface EventInput {
  action: EventAction;
  version: number;
  idempotencyKey: string;
  reason?: string;
  feedbackKind?: "items" | "other" | "not_sure";
  itemIds?: string[];
  receiptId?: string;
  receiptVersion?: number;
  scopeVersion?: number;
  draftVersion?: number;
}
export interface Task {
  id: string;
  purpose: "analysis" | "receipt_coverage";
  state: "queued" | "running" | "succeeded" | "failed";
  result?: AnalysisResult | ReceiptCoverageResult;
  error?: string;
  createdAt: string;
}
export interface ApiErrorBody {
  error: { code: string; message: string; requestId?: string };
}
export interface AiService {
  analyze(input: AnalyzeInput): Promise<AnalysisResult>;
  checkReceipt(input: ReceiptCheckInput): Promise<ReceiptCoverageResult>;
}
export interface AiConfig {
  mode: "live" | "disabled";
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}
export const SEMANTIC_POLICIES = {
  object: {
    id: "object-1",
    text: "问题发生在哪件物体上？可以补一句说明，或选择已有的整体照片。",
  },
  phenomenon: {
    id: "phenomenon-1",
    text: "你已经观察到了什么现象？不确定可以直接选择“不确定”。",
  },
  conflict: {
    id: "conflict-1",
    text: "这些说明看起来不一致，请确认哪种情况更符合你已经观察到的现象。",
  },
} as const;

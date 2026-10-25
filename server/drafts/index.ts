import { readFileSync, unlinkSync } from "node:fs";
import type { Express, Request } from "express";
import { z } from "zod";
import type {
  AiService,
  AnalysisResult,
  Draft,
  ClarificationAnswer,
  Location,
  Category,
} from "../../shared/types.js";
import { SEMANTIC_POLICIES } from "../../shared/types.js";
import type { AppConfig } from "../config.js";
import type { Store } from "../db/index.js";
import type { Auth } from "../auth/index.js";
import type { Tasks } from "../tasks/index.js";
import type {
  Uploads,
  Attachment as StoredAttachment,
} from "../uploads/index.js";
import { detectEmergency } from "../ai/emergency.js";
import { fail, hash, id, now, rateLimit, version } from "../http/index.js";

export interface StoredDraft extends Draft {
  ownerId: string;
  createdAt: string;
  analysisVersion?: number;
  analysisHash?: string;
  descriptionSource: "resident" | "resident_edit" | "ai";
  effectiveFactIds: string[];
  answers: Record<string, { hash: string; result: Draft }>;
  history: unknown[];
  submittedTicketId?: string;
  analysisTaskId?: string;
}
const category = z.enum(["lighting", "facility", "cleaning", "unknown"]);
const patch = z
  .object({
    version: z.number().int().positive(),
    locationId: z.string().min(1).max(100).nullable().optional(),
    category: category.optional(),
    description: z.string().trim().max(500).optional(),
    attachmentIds: z.array(z.string().uuid()).max(3).optional(),
    answer: z
      .object({
        questionId: z.string().uuid(),
        inputVersion: z.number().int().positive(),
        kind: z.enum(["text", "photo", "not_sure", "skip"]),
        value: z.string().trim().max(500).optional(),
        attachmentIds: z.array(z.string().uuid()).max(3).optional(),
      })
      .optional(),
  })
  .refine(
    (x) =>
      !(
        x.answer &&
        (x.description !== undefined ||
          x.attachmentIds !== undefined ||
          x.locationId !== undefined ||
          x.category !== undefined)
      ),
    "请分别保存输入和回答。",
  );
export class Drafts {
  constructor(
    readonly store: Store,
    readonly auth: Auth,
    readonly tasks: Tasks,
    readonly uploads: Uploads,
    readonly ai: AiService,
    readonly config: AppConfig,
    readonly locations: Location[],
  ) {}
  get(req: Request, draftId: string): StoredDraft {
    const resident = this.auth.resident(req);
    const draft =
      this.store.get<StoredDraft>("draft", draftId) ||
      fail(404, "NOT_FOUND", "没有找到此草稿。");
    if (draft.ownerId !== resident.id || draft.siteId !== resident.siteId)
      fail(403, "FORBIDDEN", "无权访问此草稿。");
    return draft;
  }
  view(draft: StoredDraft): Draft {
    const {
      ownerId,
      createdAt,
      analysisVersion,
      analysisHash,
      descriptionSource,
      effectiveFactIds,
      answers,
      history,
      submittedTicketId,
      analysisTaskId,
      ...visible
    } = draft;
    return {
      ...visible,
      attachments: draft.attachmentIds.map((a) => this.attachment(a)),
    };
  }
  attachment(attachmentId: string) {
    const item =
      this.store.get<StoredAttachment>("attachment", attachmentId) ||
      fail(422, "INVALID_ATTACHMENT", "图片已不可用。");
    return {
      id: item.id,
      url: `/api/attachments/${item.id}`,
      fileName: item.fileName || "现场照片.webp",
      mime: item.mimeType,
      size: item.size,
      createdAt: item.createdAt,
    };
  }
  bindIntake(req: Request, draftId: string, attachmentId: string) {
    const draft = this.get(req, draftId);
    if (draft.submittedTicketId)
      fail(409, "DRAFT_SUBMITTED", "此草稿已经提交，不能追加图片。");
    if (draft.attachmentIds.includes(attachmentId)) return;
    if (draft.attachmentIds.length >= 3)
      fail(422, "PHOTO_LIMIT", "报修与补充图片合计最多三张。");
    draft.history.push({
      kind: "image_added",
      version: draft.version,
      attachmentId,
      analysis: draft.analysis,
      at: now(),
    });
    draft.attachmentIds.push(attachmentId);
    draft.analysis = null;
    draft.effectiveFactIds = [];
    draft.analysisVersion = undefined;
    draft.analysisHash = undefined;
    draft.question = null;
    draft.version++;
    draft.updatedAt = now();
    this.store.put("draft", draft);
  }
  checkLocation(siteId: string, locationId: string | null) {
    if (
      locationId &&
      !this.locations.some((l) => l.siteId === siteId && l.id === locationId)
    )
      fail(422, "INVALID_LOCATION", "请选择当前场地中的具体位置。");
  }
  emergency(text: string) {
    if (detectEmergency(text))
      fail(
        422,
        "EMERGENCY",
        "可能涉及即时危险。请离开危险区域，使用现场公布的应急渠道；本入口不提供应急响应。",
      );
  }
  issueQuestion(draft: StoredDraft, result: AnalysisResult) {
    if (draft.question || draft.stopReason || draft.clarificationCount >= 2)
      return;
    let question: Draft["question"] = null;
    if (!draft.locationId)
      question = {
        id: id(),
        inputVersion: draft.version,
        kind: "location",
        policyId: "location-required-v1",
        text: "问题发生在哪个具体位置？请选择现场位置；不知道时可手动补齐后继续。",
      };
    else if (
      this.config.semanticEnabled &&
      result.gap &&
      draft.semanticCount < 1
    ) {
      const policy = SEMANTIC_POLICIES[result.gap.kind];
      if (
        policy &&
        result.gap.policyId === policy.id &&
        result.gap.factIds.length > 0 &&
        result.gap.factIds.every((f) => result.facts.some((v) => v.id === f))
      )
        question = {
          id: id(),
          inputVersion: draft.version,
          kind: "semantic",
          policyId: policy.id,
          text: policy.text,
        };
    }
    if (question) {
      draft.question = question;
      draft.clarificationCount++;
      if (question.kind === "semantic") draft.semanticCount++;
      draft.history.push({ kind: "question", question, at: now() });
    }
  }
  answer(draft: StoredDraft, answer: ClarificationAnswer): Draft {
    const answerHash = hash(answer),
      replay = draft.answers[answer.questionId];
    if (replay) {
      if (replay.hash !== answerHash)
        fail(
          409,
          "ANSWER_CONFLICT",
          "这个问题已经收到不同答复，请保留输入并刷新。",
        );
      return replay.result;
    }
    const question = draft.question;
    if (
      !question ||
      question.id !== answer.questionId ||
      question.inputVersion !== answer.inputVersion ||
      draft.version !== answer.inputVersion
    )
      fail(
        409,
        "QUESTION_EXPIRED",
        "这个问题对应的输入已更新，请保留输入并刷新。",
      );
    if (answer.kind === "not_sure" || answer.kind === "skip")
      draft.stopReason = answer.kind;
    else if (answer.kind === "text") {
      if (!answer.value) fail(422, "ANSWER_REQUIRED", "请填写回答。");
      this.emergency(answer.value);
      if (question.kind === "location") {
        this.checkLocation(draft.siteId, answer.value);
        draft.locationId = answer.value;
      } else {
        const combined = `${draft.description}\n补充：${answer.value}`.trim();
        if (combined.length > 500)
          fail(422, "TEXT_LIMIT", "原说明与补充合计不能超过 500 字。");
        draft.description = combined;
        draft.descriptionSource = "resident_edit";
      }
    } else {
      if (!answer.attachmentIds?.length)
        fail(422, "PHOTO_REQUIRED", "请选择已上传的图片。");
      const combined = [
        ...new Set([...draft.attachmentIds, ...answer.attachmentIds]),
      ];
      if (combined.length > 3)
        fail(422, "PHOTO_LIMIT", "报修与补充图片合计最多三张。");
      this.uploads.refs(combined, { draftId: draft.id }, "intake");
      draft.attachmentIds = combined;
    }
    draft.history.push({ kind: "answer", question, answer, at: now() });
    draft.question = null;
    draft.analysis = null;
    draft.effectiveFactIds = [];
    draft.version++;
    draft.updatedAt = now();
    if (draft.clarificationCount >= 2 && !draft.stopReason)
      draft.stopReason = "limit";
    const visible = this.view(draft);
    draft.answers[answer.questionId] = { hash: answerHash, result: visible };
    this.store.put("draft", draft);
    return visible;
  }
  routes(app: Express) {
    app.post("/api/drafts", rateLimit(40, 60000), (req, res) => {
      const resident = this.auth.resident(req);
      const input = z
        .object({
          siteId: z.string().optional(),
          locationId: z.string().min(1).max(100).nullable().optional(),
          description: z.string().trim().max(500).default(""),
          category: category.default("unknown"),
        })
        .parse(req.body || {});
      if (input.siteId && input.siteId !== resident.siteId)
        fail(403, "FORBIDDEN", "当前会话不属于此场地。");
      this.checkLocation(resident.siteId, input.locationId || null);
      this.emergency(input.description);
      const draft: StoredDraft = {
        id: id(),
        version: 1,
        siteId: resident.siteId,
        ownerId: resident.id,
        locationId: input.locationId || null,
        category: input.category,
        description: input.description,
        attachmentIds: [],
        attachments: [],
        analysis: null,
        question: null,
        clarificationCount: 0,
        semanticCount: 0,
        stopReason: null,
        updatedAt: now(),
        createdAt: now(),
        descriptionSource: "resident",
        effectiveFactIds: [],
        answers: {},
        history: [],
      };
      this.store.put("draft", draft);
      res.status(201).json(this.view(draft));
    });
    app.get("/api/drafts/:id", (req, res) =>
      res.json(this.view(this.get(req, String(req.params.id)))),
    );
    app.patch("/api/drafts/:id", (req, res) => {
      const input = patch.parse(req.body);
      const draft = this.get(req, String(req.params.id));
      if (draft.submittedTicketId)
        fail(409, "DRAFT_SUBMITTED", "此草稿已经提交，请查看原工单。", {
          ticketId: draft.submittedTicketId,
        });
      if (input.answer && draft.answers[input.answer.questionId])
        return res.json(this.answer(draft, input.answer));
      version(draft.version, input.version);
      if (input.answer)
        return res.json(this.store.tx(() => this.answer(draft, input.answer!)));
      this.checkLocation(
        draft.siteId,
        input.locationId === undefined ? draft.locationId : input.locationId,
      );
      if (input.description !== undefined) this.emergency(input.description);
      if (input.attachmentIds)
        this.uploads.refs(input.attachmentIds, { draftId: draft.id }, "intake");
      this.store.tx(() => {
        draft.history.push({
          kind: "edit",
          version: draft.version,
          description: draft.description,
          analysis: draft.analysis,
          at: now(),
        });
        const changed =
          (input.description !== undefined &&
            input.description !== draft.description) ||
          (input.attachmentIds !== undefined &&
            hash(input.attachmentIds) !== hash(draft.attachmentIds));
        if (input.description !== undefined) {
          draft.description = input.description;
          draft.descriptionSource = "resident_edit";
        }
        if (input.attachmentIds !== undefined)
          draft.attachmentIds = input.attachmentIds;
        if (input.category !== undefined) draft.category = input.category;
        if (input.locationId !== undefined) draft.locationId = input.locationId;
        if (
          changed ||
          input.category !== undefined ||
          input.locationId !== undefined
        ) {
          draft.analysis = null;
          draft.effectiveFactIds = [];
          draft.analysisVersion = undefined;
          draft.analysisHash = undefined;
        }
        draft.question = null;
        draft.version++;
        draft.updatedAt = now();
        this.store.put("draft", draft);
      });
      res.json(this.view(draft));
    });
    app.delete("/api/drafts/:id", (req, res) => {
      const draft = this.get(req, String(req.params.id));
      if (draft.submittedTicketId)
        fail(409, "DRAFT_SUBMITTED", "正式工单记录不能删除。");
      const files = this.store
        .all<StoredAttachment>("attachment")
        .filter(
          (a) =>
            (a.draftId === draft.id || a.originatingDraftId === draft.id) &&
            !a.ticketId,
        );
      const tasks = this.store
        .all<{ id: string; draftId?: string }>("task")
        .filter((t) => t.draftId === draft.id);
      this.store.tx(() => {
        this.store.remove("draft", draft.id);
        for (const file of files) this.store.remove("attachment", file.id);
        for (const task of tasks) {
          this.store.remove("task", task.id);
          this.store.remove("ai_run", task.id);
        }
      });
      for (const file of files)
        try {
          unlinkSync(file.path);
        } catch {}
      res.status(204).end();
    });
    app.post("/api/drafts/:id/analyze", rateLimit(15, 60000), (req, res) => {
      const draft = this.get(req, String(req.params.id));
      const input = z
        .object({
          version: z.number().int().positive(),
          consent: z.literal(true),
        })
        .parse(req.body);
      version(draft.version, input.version);
      if (draft.submittedTicketId)
        fail(409, "DRAFT_SUBMITTED", "此草稿已经提交。");
      this.emergency(draft.description);
      if (!draft.description.trim() && !draft.attachmentIds.length)
        fail(422, "INPUT_REQUIRED", "至少写下问题或上传一张可读取的图片。");
      if (!draft.locationId)
        this.store.tx(() => {
          this.issueQuestion(draft, {
            category: draft.category,
            facts: [],
            gap: null,
            needsReview: true,
          });
          this.store.put("draft", draft);
        });
      const fingerprint = hash({
        purpose: "analysis",
        draftId: draft.id,
        version: draft.version,
        description: draft.description,
        photos: draft.attachmentIds,
        category: draft.category,
        site: draft.siteId,
        model: this.config.ai.model,
        policy: "v1.3",
      });
      const task = this.tasks.schedule(
        {
          purpose: "analysis",
          ownerId: draft.ownerId,
          siteId: draft.siteId,
          draftId: draft.id,
          inputVersion: draft.version,
          fingerprint,
        },
        async () => {
          const images = draft.attachmentIds.map((a) => {
            const image = this.store.get<StoredAttachment>("attachment", a)!;
            return {
              id: a,
              dataUrl: `data:${image.mimeType};base64,${readFileSync(image.path).toString("base64")}`,
            };
          });
          return this.ai.analyze({
            description: draft.description,
            category: draft.category,
            images,
            inputVersion: draft.version,
          });
        },
        (value) => {
          const current = this.store.get<StoredDraft>("draft", draft.id);
          if (
            !current ||
            current.submittedTicketId ||
            current.version !== draft.version
          )
            fail(409, "STALE_ANALYSIS", "原输入已更新，旧分析不再应用。");
          const result = value as AnalysisResult;
          current.analysis = result;
          current.analysisVersion = current.version;
          current.analysisHash = hash({
            description: current.description,
            attachmentIds: current.attachmentIds,
          });
          current.effectiveFactIds = result.facts.map((f) => f.id);
          if (current.category === "unknown")
            current.category = result.category;
          this.issueQuestion(current, result);
          current.updatedAt = now();
          this.store.put("draft", current);
          return result;
        },
      );
      draft.analysisTaskId = task.id;
      this.store.put("draft", draft);
      res.status(202).json(this.tasks.view(task));
    });
  }
}

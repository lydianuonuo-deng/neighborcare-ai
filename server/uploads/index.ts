import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import multer from "multer";
import sharp from "sharp";
import { z } from "zod";
import type { Express, Request } from "express";
import type { Store } from "../db/index.js";
import type { Auth } from "../auth/index.js";
import { fail, id, now, rateLimit } from "../http/index.js";

export interface Attachment {
  id: string;
  siteId: string;
  ownerId: string;
  draftId?: string;
  originatingDraftId?: string;
  ticketId?: string;
  purpose: "intake" | "receipt";
  fileName: string;
  mimeType: string;
  size: number;
  createdAt: string;
  path: string;
}
export type UploadAccess = (
  req: Request,
  target: { draftId?: string; ticketId?: string },
  write: boolean,
) => { siteId: string; ownerId: string };
export class Uploads {
  constructor(
    readonly store: Store,
    readonly auth: Auth,
    readonly directory: string,
    readonly access: UploadAccess,
    readonly bindIntake: (
      req: Request,
      draftId: string,
      attachmentId: string,
    ) => void,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  refs(
    ids: string[],
    target: { draftId?: string; ticketId?: string },
    purpose: "intake" | "receipt",
  ) {
    if (new Set(ids).size !== ids.length)
      fail(422, "DUPLICATE_ATTACHMENTS", "请勿重复选择同一张图片。");
    for (const attachmentId of ids) {
      const item = this.store.get<Attachment>("attachment", attachmentId);
      if (
        !item ||
        item.purpose !== purpose ||
        (target.draftId && item.draftId !== target.draftId) ||
        (target.ticketId && item.ticketId !== target.ticketId)
      )
        fail(422, "INVALID_ATTACHMENT", "图片不属于当前内容。");
    }
  }
  routes(app: Express) {
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: {
        fileSize: 10 * 1024 * 1024,
        files: 1,
        fields: 6,
        fieldSize: 300,
      },
    });
    app.post(
      "/api/attachments",
      rateLimit(30, 60000),
      (req, _res, next) => {
        if (!this.auth.read(req, "resident") && !this.auth.read(req, "staff"))
          fail(401, "SESSION_REQUIRED", "请先建立会话或登录。");
        next();
      },
      upload.single("file"),
      async (req, res) => {
        const input = z
          .object({
            draftId: z.string().uuid().optional(),
            ticketId: z.string().uuid().optional(),
            purpose: z
              .enum(["draft", "intake", "receipt"])
              .default("draft")
              .transform((v) => (v === "draft" ? "intake" : v)),
          })
          .refine((v) => !!v.draftId !== !!v.ticketId, "请选择图片所属内容。")
          .parse(req.body);
        const owner = this.access(req, input, true);
        const file = req.file || fail(422, "FILE_REQUIRED", "请选择一张图片。");
        if (input.purpose === "receipt" && !input.ticketId)
          fail(422, "INVALID_TARGET", "回执图片需要所属工单。");
        if (input.purpose === "intake" && !input.draftId)
          fail(422, "INVALID_TARGET", "报修图片需要所属草稿。");
        const existing = this.store
          .all<Attachment>("attachment")
          .filter(
            (a) =>
              a.purpose === input.purpose &&
              (input.draftId
                ? a.draftId === input.draftId
                : a.ticketId === input.ticketId),
          );
        if (input.purpose === "intake" && existing.length >= 3)
          fail(
            422,
            "PHOTO_LIMIT",
            "报修与补充图片合计最多三张，请先删除不需要的图片。",
          );
        let buffer: Buffer;
        try {
          const source = sharp(file.buffer, {
            limitInputPixels: 40000000,
            failOn: "error",
            animated: false,
          });
          const meta = await source.metadata();
          if (
            !["jpeg", "png", "webp"].includes(meta.format || "") ||
            (meta.pages || 1) > 1
          )
            fail(422, "INVALID_IMAGE", "仅支持静态 JPEG、PNG 或 WebP 图片。");
          buffer = await source
            .rotate()
            .resize({
              width: 2400,
              height: 2400,
              fit: "inside",
              withoutEnlargement: true,
            })
            .webp({ quality: 85 })
            .toBuffer();
        } catch (error) {
          if (error && typeof error === "object" && "status" in error)
            throw error;
          fail(
            422,
            "INVALID_IMAGE",
            "图片无法读取，请重新选择 JPEG、PNG 或 WebP 文件。",
          );
        }
        const attachmentId = id(),
          path = join(this.directory, `${attachmentId}.webp`);
        const item: Attachment = {
          id: attachmentId,
          ...owner,
          ...input,
          ...(input.draftId ? { originatingDraftId: input.draftId } : {}),
          mimeType: "image/webp",
          size: buffer!.length,
          createdAt: now(),
          fileName:
            file.originalname
              .replace(/[^\p{L}\p{N} ._-]/gu, "")
              .slice(0, 100) || "现场照片.webp",
          path,
        };
        try {
          this.store.tx(() => {
            const count = this.store
              .all<Attachment>("attachment")
              .filter(
                (a) => a.purpose === "intake" && a.draftId === input.draftId,
              ).length;
            if (input.purpose === "intake" && count >= 3)
              fail(422, "PHOTO_LIMIT", "报修与补充图片合计最多三张。");
            this.access(req, input, true);
            this.store.put("attachment", item);
            if (input.purpose === "intake")
              this.bindIntake(req, input.draftId!, item.id);
            writeFileSync(path, buffer!, { mode: 0o600 });
          });
        } catch (error) {
          try {
            unlinkSync(path);
          } catch {}
          throw error;
        }
        res
          .status(201)
          .json({
            id: item.id,
            url: `/api/attachments/${item.id}`,
            fileName: item.fileName,
            mime: item.mimeType,
            size: item.size,
            createdAt: item.createdAt,
          });
      },
    );
    app.get("/api/attachments/:id", (req, res) => {
      const item =
        this.store.get<Attachment>("attachment", String(req.params.id)) ||
        fail(404, "NOT_FOUND", "没有找到此图片。");
      this.access(req, item, false);
      if (
        item.purpose === "receipt" &&
        !(item as Attachment & { receiptId?: string }).receiptId &&
        this.auth.read(req, "staff")?.siteId !== item.siteId
      )
        fail(
          403,
          "UNPUBLISHED_ATTACHMENT",
          "未发布的回执照片仅工作人员可查看。",
        );
      res.set({
        "Content-Type": item.mimeType,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.send(readFileSync(item.path));
    });
    app.delete("/api/attachments/:id", (req, res) => {
      const item =
        this.store.get<Attachment>("attachment", String(req.params.id)) ||
        fail(404, "NOT_FOUND", "没有找到此图片。");
      this.access(req, item, true);
      if (!item.draftId)
        fail(409, "IMMUTABLE_ATTACHMENT", "正式工单照片需要保留。");
      const draft = this.store.get<{
        id: string;
        version: number;
        attachmentIds: string[];
        analysis: unknown;
        effectiveFactIds: string[];
        question: unknown;
        updatedAt: string;
      }>("draft", item.draftId);
      this.store.tx(() => {
        if (draft && draft.attachmentIds.includes(item.id)) {
          draft.attachmentIds = draft.attachmentIds.filter(
            (a) => a !== item.id,
          );
          draft.analysis = null;
          draft.effectiveFactIds = [];
          draft.question = null;
          draft.version++;
          draft.updatedAt = now();
          this.store.put("draft", draft);
        }
        this.store.remove("attachment", item.id);
      });
      try {
        unlinkSync(item.path);
      } catch {}
      res.status(204).end();
    });
  }
}

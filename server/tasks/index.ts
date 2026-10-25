import type { Express } from "express";
import type { Store } from "../db/index.js";
import type { Auth } from "../auth/index.js";
import { fail, id, now } from "../http/index.js";

export interface Job {
  id: string;
  purpose: "analysis" | "receipt_coverage";
  status: "queued" | "running" | "succeeded" | "failed";
  ownerId: string;
  siteId: string;
  draftId?: string;
  ticketId?: string;
  inputVersion?: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: unknown;
  error?: { code: string; message: string };
  fingerprint: string;
}
export class Tasks {
  private running = new Set<AbortController>();
  private closed = false;
  constructor(
    readonly store: Store,
    readonly auth: Auth,
    readonly model = "unknown",
  ) {
    for (const job of store.all<Job>("task"))
      if (job.status === "running" || job.status === "queued")
        store.put("task", {
          ...job,
          status: "failed",
          completedAt: now(),
          error: {
            code: "PROCESS_RESTARTED",
            message: "服务重启中断了整理，请保留输入后重试。",
          },
        });
  }
  find(fingerprint: string, includeFailed = false): Job | undefined {
    return this.store
      .all<Job>("task")
      .find(
        (j) =>
          j.fingerprint === fingerprint &&
          (includeFailed || j.status !== "failed"),
      );
  }
  schedule(
    input: Omit<Job, "id" | "status" | "createdAt">,
    work: (signal: AbortSignal) => Promise<unknown>,
    apply: (value: unknown, job: Job) => unknown,
  ): Job {
    const prior = this.find(input.fingerprint);
    if (prior) return prior;
    const job: Job = { ...input, id: id(), status: "queued", createdAt: now() };
    this.store.put("task", job);
    const controller = new AbortController();
    this.running.add(controller);
    const timer = setTimeout(
      () => controller.abort(new Error("AI_TIMEOUT")),
      25000,
    );
    timer.unref();
    const execute = async () => {
      if (this.closed) return;
      const running = { ...job, status: "running" as const, startedAt: now() };
      this.store.put("task", running);
      let attempts: unknown = [];
      let succeeded = false;
      try {
        const value = await Promise.race([
          work(controller.signal),
          new Promise<never>((_, reject) =>
            controller.signal.addEventListener(
              "abort",
              () => reject(controller.signal.reason),
              { once: true },
            ),
          ),
        ]);
        if (
          controller.signal.aborted ||
          this.closed ||
          !this.store.get<Job>("task", job.id)
        )
          return;
        attempts = (value as { attempts?: unknown })?.attempts || [];
        this.store.tx(() => {
          const result = apply(value, running);
          this.store.put("task", {
            ...running,
            status: "succeeded",
            result,
            completedAt: now(),
          });
          succeeded = true;
        });
      } catch (error) {
        attempts = (error as { attempts?: unknown })?.attempts || attempts;
        if (!this.closed && this.store.get<Job>("task", job.id)) {
          this.store.put("task", {
            ...running,
            status: "failed",
            completedAt: now(),
            error: {
              code: controller.signal.aborted ? "AI_TIMEOUT" : "AI_FAILED",
              message: controller.signal.aborted
                ? "整理超过 25 秒，请手动继续或重试。"
                : "整理暂时不可用，输入已保留，可以手动继续。",
            },
          });
        }
      } finally {
        if (!this.closed && this.store.get<Job>("task", job.id))
          this.store.put("ai_run", {
            id: job.id,
            taskId: job.id,
            purpose: job.purpose,
            inputHash: job.fingerprint,
            model: this.model,
            rulesVersion: "v1.3",
            createdAt: now(),
            elapsedMs: Date.now() - Date.parse(running.startedAt!),
            attempts,
            success: succeeded,
          });
        clearTimeout(timer);
        this.running.delete(controller);
      }
    };
    queueMicrotask(() => void execute());
    return job;
  }
  view(task: Job) {
    return {
      id: task.id,
      purpose: task.purpose,
      state: task.status,
      ...(task.result ? { result: task.result } : {}),
      ...(task.error ? { error: task.error.message } : {}),
      createdAt: task.createdAt,
    };
  }
  routes(app: Express) {
    app.get("/api/tasks/:id", (req, res) => {
      const task =
        this.store.get<Job>("task", String(req.params.id)) ||
        fail(404, "NOT_FOUND", "没有找到此任务。");
      const resident = this.auth.read(req, "resident"),
        staff = this.auth.read(req, "staff");
      if (!resident && !staff) fail(401, "SESSION_REQUIRED", "请先恢复会话。");
      if (
        !(task.ownerId === resident?.id && task.siteId === resident.siteId) &&
        !(task.ownerId === staff?.id && task.siteId === staff.siteId)
      )
        fail(403, "FORBIDDEN", "无权查看此任务。");
      res.json(this.view(task));
    });
  }
  close() {
    this.closed = true;
    for (const c of this.running) c.abort(new Error("SHUTDOWN"));
    this.running.clear();
  }
}

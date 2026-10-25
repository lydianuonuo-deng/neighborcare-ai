import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  FloppyDisk,
  Image,
  MapPin,
  PencilSimple,
  Sparkle,
  UploadSimple,
} from "@phosphor-icons/react";
import type {
  Attachment,
  Bootstrap,
  Category,
  ClarificationAnswer,
  Draft,
} from "../shared/types";
import { CATEGORY_LABELS } from "../shared/types";
import { api, key, message, pollTask } from "./api";
import { refreshAfterClarification } from "./workflows";
import { createDraftStorage, draftKeys, readCachedJson } from "./draft-storage";
import { Link, Loading, navigate, Notice, PageHeader, Photos } from "./ui";

type Fields = { description: string; locationId: string; category: Category };
const defaults: Fields = {
  description: "",
  locationId: "",
  category: "unknown",
};
export default function NewReport({ bootstrap }: { bootstrap: Bootstrap }) {
  const site = bootstrap.sites[0];
  const { cache: cacheKey, pending: pendingKey } = draftKeys(
    bootstrap.user!.id,
  );
  const [storage] = useState(() =>
    createDraftStorage(() => window.localStorage),
  );
  const [fields, setFields] = useState<Fields>(defaults);
  const fieldsRef = useRef(fields);
  const [draft, setDraft] = useState<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const [step, setStep] = useState(1);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [consent, setConsent] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [answer, setAnswer] = useState("");
  const [answerPhoto, setAnswerPhoto] = useState("");
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const uploadRef = useRef<HTMLInputElement>(null);
  function queue<T>(action: () => Promise<T>): Promise<T> {
    const result = queueRef.current.then(action);
    queueRef.current = result.catch(() => undefined);
    return result;
  }
  const accept = useCallback(
    (value: Draft) => {
      draftRef.current = value;
      setDraft(value);
      storage.setItem(
        cacheKey,
        JSON.stringify({ draftId: value.id, fields: fieldsRef.current }),
      );
      return value;
    },
    [storage, cacheKey],
  );
  const updateFields = (next: Fields) => {
    fieldsRef.current = next;
    setFields(next);
    setConfirmed(false);
    setSaved("尚未保存");
    storage.setItem(
      cacheKey,
      JSON.stringify({ draftId: draftRef.current?.id, fields: next }),
    );
  };
  useEffect(() => {
    let active = true;
    async function restore() {
      try {
        const pending = readCachedJson(storage, pendingKey) as {
          idempotencyKey?: unknown;
        } | null;
        if (typeof pending?.idempotencyKey === "string") {
          try {
            const recovered = await api.submission(pending.idempotencyKey);
            if (active) {
              storage.removeItem(cacheKey);
              storage.removeItem(pendingKey);
              navigate(`/tickets/${recovered.ticket.id}?submitted=1`);
              return;
            }
          } catch {
            /* An uncompleted submission can still be retried with the original key. */
          }
        }
        const cached = readCachedJson(storage, cacheKey) as {
          draftId?: string;
          fields?: Fields;
        } | null;
        const candidate = cached?.fields;
        const localFields =
          candidate &&
          typeof candidate.description === "string" &&
          typeof candidate.locationId === "string" &&
          typeof candidate.category === "string" &&
          Object.hasOwn(CATEGORY_LABELS, candidate.category)
            ? candidate
            : undefined;
        if (localFields) {
          fieldsRef.current = localFields;
          setFields(localFields);
        }
        if (typeof cached?.draftId === "string") {
          try {
            const restored = await api.draft(cached.draftId);
            if (active) {
              if (!localFields) {
                const next = {
                  description: restored.description,
                  locationId: restored.locationId || "",
                  category: restored.category,
                };
                fieldsRef.current = next;
                setFields(next);
              }
              accept(restored);
              setSaved("已恢复草稿");
            }
          } catch {
            if (active) setSaved("本地内容已恢复，保存时将建立新草稿。");
          }
        }
      } catch {
        storage.removeItem(cacheKey);
      } finally {
        if (active) setReady(true);
      }
    }
    void restore();
    return () => {
      active = false;
    };
  }, [accept, storage, cacheKey, pendingKey]);
  const ensure = async () => {
    if (draftRef.current) return draftRef.current;
    return accept(await api.newDraft(site.id, bootstrap.user!.id));
  };
  const save = () =>
    queue(async () => {
      const current = await ensure();
      const input = fieldsRef.current;
      if (
        current.description === input.description.trim() &&
        current.category === input.category &&
        (current.locationId || "") === input.locationId
      )
        return current;
      const result = accept(
        await api.saveDraft(current.id, {
          version: current.version,
          description: input.description,
          locationId: input.locationId || null,
          category: input.category,
        }),
      );
      setSaved("草稿已保存");
      return result;
    });
  const saveOnBlur = () => {
    if (ready) void save().catch((e) => setError(message(e)));
  };
  async function perform(label: string, action: () => Promise<void>) {
    setError("");
    setBusy(label);
    try {
      await action();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  }
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setConfirmed(false);
    await perform("正在上传照片…", async () => {
      await save();
      await queue(async () => {
        let current = await ensure();
        if (current.attachments.length + files.length > 3)
          throw new Error(
            "报修与补充照片合计最多 3 张，请先移除不需要的照片。",
          );
        for (const file of Array.from(files)) {
          try {
            await api.upload(file, { draftId: current.id });
          } catch (e) {
            // Upload and draft binding commit together; recover a lost response before retrying.
            try {
              current = accept(await api.draft(current.id));
            } catch {
              /* The stored draft ID also permits recovery on refresh. */
            }
            throw e;
          }
          current = accept(await api.draft(current.id));
        }
        setSaved("照片已保存");
      });
    });
    if (uploadRef.current) uploadRef.current.value = "";
  }
  async function remove(photo: Attachment) {
    setConfirmed(false);
    await perform("正在移除照片…", () =>
      queue(async () => {
        const current = await ensure();
        const result = accept(
          await api.saveDraft(current.id, {
            version: current.version,
            attachmentIds: current.attachmentIds.filter(
              (id) => id !== photo.id,
            ),
          }),
        );
        await api.removeAttachment(photo.id);
        setSaved("照片已移除");
        return void result;
      }),
    );
  }
  async function review(withAi: boolean) {
    await perform(
      withAi ? "正在整理你提供的信息，你仍可返回修改。" : "正在保存…",
      async () => {
        const current = await save();
        if (!current.description.trim() && !current.attachmentIds.length)
          throw new Error("请至少写下你看到的问题，或上传一张现场照片。");
        if (withAi) {
          if (!consent)
            throw new Error("请先同意将本次文字和照片发送给 AI 服务处理。");
          const task = await api.analyze(current.id, current.version);
          await pollTask(task);
          const analyzed = accept(await api.draft(current.id));
          const next = { ...fieldsRef.current, category: analyzed.category };
          fieldsRef.current = next;
          setFields(next);
          storage.setItem(
            cacheKey,
            JSON.stringify({ draftId: analyzed.id, fields: next }),
          );
        }
        setStep(2);
        window.scrollTo({ top: 0, behavior: "smooth" });
      },
    );
  }
  async function answerQuestion(kind: ClarificationAnswer["kind"]) {
    if (!draft?.question) return;
    const question = draft.question;
    setConfirmed(false);
    await perform("正在保存补充…", () =>
      queue(async () => {
        const current = draftRef.current!;
        const result = accept(
          await api.saveDraft(current.id, {
            version: current.version,
            answer: {
              questionId: question.id,
              inputVersion: question.inputVersion,
              kind,
              ...(kind === "text" ? { value: answer } : {}),
              ...(kind === "photo"
                ? { attachmentIds: [answerPhoto || current.attachmentIds[0]] }
                : {}),
            },
          }),
        );
        const next = {
          description: result.description,
          locationId: result.locationId || "",
          category: result.category,
        };
        fieldsRef.current = next;
        setFields(next);
        storage.setItem(
          cacheKey,
          JSON.stringify({ draftId: result.id, fields: next }),
        );
        setAnswer("");
        setSaved("补充已保存，可以继续核对。");
        if (
          (kind === "text" || kind === "photo") &&
          bootstrap.ai.enabled &&
          consent
        ) {
          setBusy("补充已保存，正在重新整理你提供的信息…");
          try {
            const analyzed = await refreshAfterClarification(result, kind, {
              enabled: bootstrap.ai.enabled,
              consent,
            });
            const changedWhileWaiting =
              JSON.stringify(fieldsRef.current) !== JSON.stringify(next);
            accept(analyzed);
            if (!changedWhileWaiting) {
              const updated = { ...next, category: analyzed.category };
              fieldsRef.current = updated;
              setFields(updated);
              storage.setItem(
                cacheKey,
                JSON.stringify({ draftId: analyzed.id, fields: updated }),
              );
            }
            setSaved("补充已重新整理，请核对更新的信息。");
          } catch (e) {
            setSaved("补充已保存，可手动继续。");
            throw new Error(
              `补充已保存，暂时无法重新整理，可以直接手动核对并提交。${message(e)}`,
            );
          }
        }
      }),
    );
  }
  async function submit() {
    await perform("正在提交报修…", async () => {
      if (!fieldsRef.current.locationId)
        throw new Error("还缺具体位置，请先选择现场位置。");
      if (!fieldsRef.current.description.trim())
        throw new Error("请写下一句问题说明，方便工作人员受理。");
      if (!confirmed) throw new Error("请先核对并确认本次报修信息。");
      const current = await save();
      const data = {
        draftId: current.id,
        version: current.version,
        category: fieldsRef.current.category,
        locationId: fieldsRef.current.locationId,
        description: fieldsRef.current.description.trim(),
        confirmed: true as const,
      };
      const stored = readCachedJson(storage, pendingKey) as {
        fingerprint?: unknown;
        idempotencyKey?: unknown;
      } | null;
      const fingerprint = JSON.stringify(data);
      const idempotencyKey =
        stored?.fingerprint === fingerprint &&
        typeof stored.idempotencyKey === "string"
          ? stored.idempotencyKey
          : key();
      storage.setItem(
        pendingKey,
        JSON.stringify({ fingerprint, idempotencyKey }),
      );
      const ticket = await api.submit({ ...data, idempotencyKey });
      storage.removeItem(cacheKey);
      storage.removeItem(pendingKey);
      navigate(`/tickets/${ticket.id}?submitted=1`);
    });
  }
  const locations = bootstrap.locations.filter(
    (location) => location.siteId === site.id,
  );
  const hasCurrentAnalysis =
    draft?.analysis &&
    draft.description === fields.description.trim() &&
    (draft.locationId || "") === fields.locationId &&
    draft.category === fields.category;
  return (
    <>
      <PageHeader
        back="/"
        eyebrow="NEW REPORT / 新建报修"
        title={step === 1 ? "说说你看到的问题" : "最后核对一下，就可以提交"}
        text={
          step === 1
            ? "不需要专业描述，真实说明现场情况就好。"
            : "原始内容始终保留，由你确认后才会创建正式工单。"
        }
        action={
          <div>
            <span className="draft-save">{saved || "草稿随填写保留"}</span>
            <button
              className="button secondary small-button"
              disabled={!ready || !!busy}
              onClick={() =>
                void perform("正在保存…", async () => {
                  await save();
                  setSaved("草稿已保存");
                })
              }
            >
              <FloppyDisk size={18} />
              保存草稿
            </button>
          </div>
        }
      />
      {!storage.persistent && (
        <Notice>
          当前浏览器无法保存本地副本。请先完成提交，再刷新或离开本页；已提交记录可在“我的报修”查看。
        </Notice>
      )}
      <ol className="steps" aria-label="报修步骤">
        <li className="active">
          <span>{step === 2 ? <Check size={17} /> : "1"}</span>说明情况
        </li>
        <li className={step === 2 ? "active" : ""}>
          <span>2</span>核对并提交
        </li>
      </ol>
      {!ready ? (
        <Loading text="正在恢复草稿…" />
      ) : (
        <div className="form-layout">
          <div className="form-main">
            {error && <Notice error>{error}</Notice>}
            {busy && <Loading text={busy} />}
            <section className="form-section">
              <div className="section-number">01</div>
              <div className="section-content">
                <h2>
                  <Camera size={23} />
                  现场照片<span className="optional">选填</span>
                </h2>
                <p className="field-hint">
                  最多 3 张，每张不超过 10 MB。没有照片，也可以直接写说明。
                </p>
                <Photos
                  photos={draft?.attachments || []}
                  remove={busy ? undefined : (photo) => void remove(photo)}
                />
                <label className={`upload-zone ${busy ? "disabled" : ""}`}>
                  <input
                    ref={uploadRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    multiple
                    disabled={!!busy || (draft?.attachments.length || 0) >= 3}
                    onChange={(e) => void upload(e.target.files)}
                  />
                  <UploadSimple size={28} />
                  <strong>
                    {draft?.attachments.length
                      ? "再添加一张照片"
                      : "点击上传现场照片"}
                  </strong>
                  <span>JPEG、PNG 或 WebP · 可选择相机拍摄</span>
                </label>
              </div>
            </section>
            <section className="form-section">
              <div className="section-number">02</div>
              <div className="section-content">
                <h2>
                  <MapPin size={23} />
                  问题在哪里
                </h2>
                <div className="field">
                  <label htmlFor="location">
                    具体位置 <span className="required">必填</span>
                  </label>
                  <select
                    id="location"
                    value={fields.locationId}
                    onChange={(e) =>
                      updateFields({ ...fields, locationId: e.target.value })
                    }
                    onBlur={saveOnBlur}
                  >
                    <option value="">请选择现场位置</option>
                    {locations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.name}
                      </option>
                    ))}
                  </select>
                </div>
                <fieldset className="category-field">
                  <legend>问题类别</legend>
                  <div className="category-options">
                    {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                      <label
                        key={value}
                        className={fields.category === value ? "selected" : ""}
                      >
                        <input
                          type="radio"
                          name="category"
                          value={value}
                          checked={fields.category === value}
                          onChange={() =>
                            updateFields({
                              ...fields,
                              category: value as Category,
                            })
                          }
                          onBlur={saveOnBlur}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
            </section>
            <section className="form-section">
              <div className="section-number">03</div>
              <div className="section-content">
                <h2>
                  <PencilSimple size={23} />
                  你看到了什么
                </h2>
                <div className="field">
                  <label htmlFor="description">
                    现场说明 <span className="required">必填</span>
                  </label>
                  <textarea
                    id="description"
                    rows={5}
                    maxLength={500}
                    placeholder="例如：2 号楼一层楼道灯，最近两个晚上都不亮，白天看外观没有明显破损。"
                    value={fields.description}
                    onChange={(e) =>
                      updateFields({ ...fields, description: e.target.value })
                    }
                    onBlur={saveOnBlur}
                  />
                  <div className="row spread field-hint">
                    <span>写下位置、物体和你实际观察到的现象。</span>
                    <span>{fields.description.length}/500</span>
                  </div>
                </div>
              </div>
            </section>
            {step === 2 && hasCurrentAnalysis && (
              <section className="analysis-section">
                <span className="eyebrow">
                  <Sparkle size={17} /> AI 整理建议 · 请你核对
                </span>
                <h2>这些信息，符合现场情况吗？</h2>
                <p className="field-hint">
                  建议只整理你提供的信息，不能判断原因或现场安全。
                </p>
                {draft.analysis!.facts.slice(0, 3).map((fact) => (
                  <div className="fact" key={fact.id}>
                    <div className="row spread">
                      <span className="source-tag">
                        {fact.origin === "photo"
                          ? "照片提示"
                          : fact.origin === "reported"
                            ? "你提供的情况"
                            : "图文共同"}
                      </span>
                      {fact.needsConfirmation && (
                        <span className="review-tag">待核对</span>
                      )}
                    </div>
                    <p>{fact.text}</p>
                    <details>
                      <summary>查看依据</summary>
                      <p>
                        {fact.evidenceRefs
                          .map((ref) =>
                            ref === "description" || ref === "text"
                              ? "现场说明"
                              : draft.attachmentIds.includes(ref)
                                ? `现场照片 ${draft.attachmentIds.indexOf(ref) + 1}`
                                : ref,
                          )
                          .join("、")}
                      </p>
                    </details>
                  </div>
                ))}
                <button
                  className="text-button"
                  onClick={() => {
                    setStep(1);
                    document.getElementById("description")?.focus();
                  }}
                >
                  需要修改？直接编辑上方原始说明
                </button>
              </section>
            )}
            {step === 2 && draft?.question && (
              <section className="question-box">
                <span className="eyebrow">
                  还想确认一件事 · 第 {draft.clarificationCount}/2 轮
                </span>
                <h2>{draft.question.text}</h2>
                <p className="field-hint">
                  为了让工作人员更容易找到现场、理解问题。你也可以跳过或选择不确定。
                </p>
                {draft.question.kind === "location" ? (
                  <div className="field">
                    <label htmlFor="clarification">现场位置</label>
                    <select
                      id="clarification"
                      value={answer}
                      onChange={(e) => setAnswer(e.target.value)}
                    >
                      <option value="">请选择位置</option>
                      {locations.map((location) => (
                        <option key={location.id} value={location.id}>
                          {location.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div className="field">
                    <label htmlFor="clarification">补充一句说明</label>
                    <textarea
                      id="clarification"
                      value={answer}
                      maxLength={300}
                      rows={3}
                      onChange={(e) => setAnswer(e.target.value)}
                    />
                  </div>
                )}
                <div className="button-row">
                  <button
                    className="button primary"
                    disabled={!!busy || !answer.trim()}
                    onClick={() => void answerQuestion("text")}
                  >
                    保存补充
                  </button>
                  {draft.attachments.length > 0 &&
                    draft.question.kind !== "location" && (
                      <>
                        <select
                          aria-label="选择用于回答的照片"
                          value={answerPhoto || draft.attachmentIds[0]}
                          onChange={(e) => setAnswerPhoto(e.target.value)}
                        >
                          {draft.attachments.map((photo, i) => (
                            <option value={photo.id} key={photo.id}>
                              现场照片 {i + 1}
                            </option>
                          ))}
                        </select>
                        <button
                          className="button secondary"
                          disabled={!!busy}
                          onClick={() => void answerQuestion("photo")}
                        >
                          用这张照片回答
                        </button>
                      </>
                    )}
                </div>
                <div className="button-row">
                  <button
                    className="text-button"
                    disabled={!!busy}
                    onClick={() => void answerQuestion("not_sure")}
                  >
                    不确定
                  </button>
                  <button
                    className="text-button"
                    disabled={!!busy}
                    onClick={() => void answerQuestion("skip")}
                  >
                    跳过，手动继续
                  </button>
                </div>
              </section>
            )}
            {step === 1 ? (
              <section className="form-bottom">
                {bootstrap.ai.enabled ? (
                  <>
                    <label className="check-label">
                      <input
                        type="checkbox"
                        checked={consent}
                        onChange={(e) => setConsent(e.target.checked)}
                      />
                      <span>
                        我同意将本次文字和照片发送给 AI
                        服务，用于整理信息和必要补问。请勿上传未经许可的个人信息。
                      </span>
                    </label>
                    <div className="button-row">
                      <button
                        className="button primary"
                        disabled={!!busy || !consent}
                        onClick={() => void review(true)}
                      >
                        <Sparkle size={20} />让 AI 帮我整理
                        <ArrowRight size={20} />
                      </button>
                      <button
                        className="button secondary"
                        disabled={!!busy}
                        onClick={() => void review(false)}
                      >
                        直接手动核对
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <Notice>
                      自动整理暂不可用。内容已保留，填写说明后可以直接手动提交。
                    </Notice>
                    <button
                      className="button primary"
                      disabled={!!busy}
                      onClick={() => void review(false)}
                    >
                      下一步，核对信息
                      <ArrowRight size={20} />
                    </button>
                  </>
                )}
              </section>
            ) : (
              <section className="form-bottom">
                {(draft?.analysis?.needsReview || draft?.stopReason) && (
                  <Notice>
                    <strong>
                      {draft.stopReason ? "保留未知。" : "待人工核对。"}
                    </strong>{" "}
                    现有说明包含尚未证实或跳过补问的信息。确认提交不会把未知变成事实，工作人员仍可继续人工沟通。
                  </Notice>
                )}
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  <span>
                    我已核对位置、类别和现场说明，确认提交这些信息。未知的情况仍保持未知。
                  </span>
                </label>
                <div className="button-row">
                  <button
                    className="button primary"
                    disabled={!!busy || !confirmed}
                    onClick={() => void submit()}
                  >
                    确认提交报修
                    <ArrowRight size={20} />
                  </button>
                  <button
                    className="button secondary"
                    disabled={!!busy}
                    onClick={() => setStep(1)}
                  >
                    <ArrowLeft size={18} />
                    返回修改
                  </button>
                </div>
              </section>
            )}
          </div>
          <aside className="form-aside">
            <div className="aside-icon">
              <Image size={31} weight="duotone" />
            </div>
            <h3>
              说清情况，
              <br />
              让处理更顺畅。
            </h3>
            <ul>
              <li>只描述亲眼观察到的现象。</li>
              <li>有照片时，整体与细节都很有帮助。</li>
              <li>不用判断故障原因，我们来跟进。</li>
            </ul>
            <div className="aside-divider" />
            <p>
              请保护自己与他人的隐私。
              <br />
              无需为了补拍照片靠近危险区域。
            </p>
            <Link href="/tickets" className="text-link">
              已有报修？查看进展
              <ArrowRight size={17} />
            </Link>
          </aside>
        </div>
      )}
    </>
  );
}

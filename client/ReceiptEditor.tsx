import { useRef, useState } from "react";
import {
  ArrowRight,
  FloppyDisk,
  Plus,
  Sparkle,
  Trash,
  UploadSimple,
} from "@phosphor-icons/react";
import type {
  Attachment,
  Bootstrap,
  ReceiptDraft,
  ResponseItem,
  Ticket,
} from "../shared/types";
import { api, key, message, pollTask } from "./api";
import { receiptTextSegments } from "./workflows";
import { Loading, Notice, Photos, SectionTitle } from "./ui";

type Content = {
  items: ResponseItem[];
  description: string;
  photos: Attachment[];
};
export default function ReceiptEditor({
  ticket,
  bootstrap,
  onPublished,
}: {
  ticket: Ticket;
  bootstrap: Bootstrap;
  onPublished: (ticket: Ticket) => void;
}) {
  const cacheKey = `linli.receipt.${ticket.id}.${ticket.version}`;
  const [savedDraft, setSavedDraft] = useState<ReceiptDraft | null>(
    ticket.receiptDraft,
  );
  const initial: Content = {
    items:
      ticket.receiptDraft?.items ||
      (bootstrap.features.responseItems
        ? [
            {
              id: key(),
              text: "",
              sourceRefs: [
                {
                  source: "submission",
                  sourceId: ticket.submissionId,
                  quote: ticket.description,
                },
              ],
            },
          ]
        : []),
    description: ticket.receiptDraft?.description || "",
    photos: ticket.receiptDraft?.attachments || [],
  };
  const [content, setContent] = useState<Content>(() => {
    try {
      return JSON.parse(localStorage.getItem(cacheKey) || "null") || initial;
    } catch {
      return initial;
    }
  });
  const contentRef = useRef(content);
  const savedRef = useRef(savedDraft);
  const [dirty, setDirty] = useState(
    JSON.stringify(content) !== JSON.stringify(initial),
  );
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const publishRef = useRef<{ fingerprint: string; id: string } | null>(null);
  const sources = [
    {
      id: ticket.submissionId,
      label: "原始报修说明",
      text: ticket.description,
      source: "submission" as const,
    },
    ...ticket.events
      .filter((event) => event.action === "reply_info")
      .map((event, index) => ({
        id: event.id,
        label: `居民补充 ${index + 1}`,
        text: event.reason,
        source: "supplement" as const,
      })),
  ];
  function update(next: Content) {
    contentRef.current = next;
    setContent(next);
    setDirty(true);
    setReviewed(false);
    setNotice("内容已修改，之前的核对提示不再适用。");
    localStorage.setItem(cacheKey, JSON.stringify(next));
  }
  function changeItem(index: number, patch: Partial<ResponseItem>) {
    const items = contentRef.current.items.map((item, i) =>
      i === index ? { ...item, ...patch } : item,
    );
    update({ ...contentRef.current, items });
  }
  async function perform(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  }
  async function save() {
    const current = contentRef.current;
    if (!current.description.trim())
      throw new Error("请写下本次处理情况（1 至 500 字）。");
    if (!current.photos.length)
      throw new Error("处理回执需要至少 1 张本次现场照片，最多 3 张。");
    if (
      bootstrap.features.responseItems &&
      (!current.items.length ||
        current.items.some(
          (item) => !item.text.trim() || !item.sourceRefs[0]?.quote.trim(),
        ))
    )
      throw new Error("请确认 1 至 3 条回应事项，并保留对应的居民原话片段。");
    for (const item of current.items)
      for (const ref of item.sourceRefs) {
        const source = sources.find((source) => source.id === ref.sourceId);
        if (!source?.text.includes(ref.quote))
          throw new Error(
            "事项引用必须是对应居民原文中的连续片段，请重新核对引用。",
          );
      }
    const previous = savedRef.current;
    const unchanged =
      previous &&
      previous.description === current.description.trim() &&
      JSON.stringify(previous.items) === JSON.stringify(current.items) &&
      JSON.stringify(previous.attachmentIds) ===
        JSON.stringify(current.photos.map((photo) => photo.id));
    if (unchanged) return previous;
    const result = await api.receipt(ticket.id, {
      version: ticket.version,
      draftVersion: previous?.version || 0,
      scopeVersion: previous?.scopeVersion || 0,
      items: current.items.map((item) => ({ ...item, text: item.text.trim() })),
      description: current.description,
      attachmentIds: current.photos.map((photo) => photo.id),
    });
    savedRef.current = result;
    setSavedDraft(result);
    setDirty(false);
    setNotice("回执草稿已保存，居民暂时看不到。");
    return result;
  }
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    await perform("正在上传处理照片…", async () => {
      if (contentRef.current.photos.length + files.length > 3)
        throw new Error("每次回执最多 3 张照片。");
      for (const file of Array.from(files)) {
        const photo = await api.upload(file, { ticketId: ticket.id });
        update({
          ...contentRef.current,
          photos: [...contentRef.current.photos, photo],
        });
      }
    });
    if (uploadRef.current) uploadRef.current.value = "";
  }
  async function check() {
    await perform("正在核对回执文字，最长等待 25 秒…", async () => {
      const saved = await save();
      const task = await api.check(
        ticket.id,
        ticket.version,
        saved.version,
        saved.scopeVersion,
      );
      await pollTask(task);
      const refreshed = await api.ticket(ticket.id);
      if (!refreshed.receiptDraft || refreshed.version !== ticket.version)
        throw new Error("工单或草稿已经更新，请刷新后重新核对。");
      savedRef.current = refreshed.receiptDraft;
      setSavedDraft(refreshed.receiptDraft);
      setDirty(false);
      setNotice("文字核对已完成。请结合原始说明人工复核；提示不判断维修质量。");
    });
  }
  async function publish() {
    await perform("正在发布处理回执…", async () => {
      if (!reviewed) throw new Error("请先人工核对并确认本次回执。");
      const saved = await save();
      const payload = {
        action: "receipt" as const,
        version: ticket.version,
        draftVersion: saved.version,
        scopeVersion: saved.scopeVersion,
      };
      const fingerprint = JSON.stringify(payload);
      if (publishRef.current?.fingerprint !== fingerprint)
        publishRef.current = { fingerprint, id: key() };
      const updated = await api.event(ticket.id, {
        ...payload,
        idempotencyKey: publishRef.current.id,
      });
      localStorage.removeItem(cacheKey);
      onPublished(updated);
    });
  }
  return (
    <section className="paper-section receipt-editor">
      <SectionTitle
        title="编辑本次处理回执"
        sub="先确认回应事项，再交代每项处理情况"
      />
      {error && <Notice error>{error}</Notice>}
      {notice && (
        <div className="save-notice" role="status">
          {notice}
        </div>
      )}
      {busy && <Loading text={busy} />}
      <fieldset disabled={!!busy}>
        {bootstrap.features.responseItems && (
          <div className="response-editor">
            <h3>
              1. 需要回应的事项 <span className="small muted">1 至 3 条</span>
            </h3>
            <p className="field-hint">
              每项只写一个需要交代的问题，并引用本单原始说明或居民补充中的原句。
            </p>
            {content.items.map((item, index) => (
              <article className="response-item-edit" key={item.id}>
                <div className="row spread">
                  <strong>事项 {index + 1}</strong>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label={`移除事项 ${index + 1}`}
                    disabled={content.items.length <= 1}
                    onClick={() =>
                      update({
                        ...contentRef.current,
                        items: contentRef.current.items.filter(
                          (value) => value.id !== item.id,
                        ),
                      })
                    }
                  >
                    <Trash size={19} />
                  </button>
                </div>
                <div className="field">
                  <label htmlFor={`item-${item.id}`}>需要回应什么</label>
                  <input
                    id={`item-${item.id}`}
                    maxLength={60}
                    placeholder="例如：楼道灯夜间不亮的处理情况"
                    value={item.text}
                    onChange={(e) =>
                      changeItem(index, { text: e.target.value })
                    }
                  />
                </div>
                <div className="field">
                  <label htmlFor={`source-${item.id}`}>原话来源</label>
                  <select
                    id={`source-${item.id}`}
                    value={item.sourceRefs[0]?.sourceId || ticket.submissionId}
                    onChange={(e) => {
                      const source = sources.find(
                        (source) => source.id === e.target.value,
                      )!;
                      changeItem(index, {
                        sourceRefs: [
                          {
                            source: source.source,
                            sourceId: source.id,
                            quote: source.text,
                          },
                        ],
                      });
                    }}
                  >
                    {sources.map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={`quote-${item.id}`}>引用的原文片段</label>
                  <textarea
                    id={`quote-${item.id}`}
                    rows={2}
                    maxLength={500}
                    value={item.sourceRefs[0]?.quote || ""}
                    onChange={(e) => {
                      const source = sources.find(
                        (source) =>
                          source.id ===
                          (item.sourceRefs[0]?.sourceId || ticket.submissionId),
                      )!;
                      changeItem(index, {
                        sourceRefs: [
                          {
                            source: source.source,
                            sourceId: source.id,
                            quote: e.target.value,
                          },
                        ],
                      });
                    }}
                  />
                  <span className="field-hint">
                    保留原文的连续片段，可删去无关部分。
                  </span>
                </div>
              </article>
            ))}
            <button
              className="button secondary"
              type="button"
              disabled={content.items.length >= 3}
              onClick={() =>
                update({
                  ...contentRef.current,
                  items: [
                    ...contentRef.current.items,
                    {
                      id: key(),
                      text: "",
                      sourceRefs: [
                        {
                          source: "submission",
                          sourceId: ticket.submissionId,
                          quote: ticket.description,
                        },
                      ],
                    },
                  ],
                })
              }
            >
              <Plus size={18} />
              添加回应事项
            </button>
          </div>
        )}
        <div className="field">
          <label htmlFor="receipt-description">
            {bootstrap.features.responseItems ? "2. " : ""}本次处理说明
          </label>
          <textarea
            id="receipt-description"
            rows={5}
            maxLength={500}
            value={content.description}
            onChange={(e) =>
              update({ ...contentRef.current, description: e.target.value })
            }
            placeholder="请逐项交代已做的处理、目前情况，或尚未处理的原因。避免只写“已完成”。"
          />
          <span className="field-hint">
            {content.description.length}/500 · 暂未处理，也请写清原因。
          </span>
        </div>
        <div className="field">
          <label>
            {bootstrap.features.responseItems ? "3. " : ""}本次处理照片{" "}
            <span className="required">1 至 3 张</span>
          </label>
          <Photos
            photos={content.photos}
            label="待发布处理照片"
            remove={(photo) =>
              update({
                ...contentRef.current,
                photos: contentRef.current.photos.filter(
                  (value) => value.id !== photo.id,
                ),
              })
            }
          />
          <label className="upload-zone compact">
            <input
              ref={uploadRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              disabled={content.photos.length >= 3 || !!busy}
              onChange={(e) => void upload(e.target.files)}
            />
            <UploadSimple size={24} />
            <strong>上传本次现场照片</strong>
            <span>每张不超过 10 MB · 请人工检查隐私</span>
          </label>
        </div>
        <div className="button-row">
          <button
            className="button secondary"
            type="button"
            onClick={() =>
              void perform("正在保存回执草稿…", async () => {
                await save();
              })
            }
          >
            <FloppyDisk size={18} />
            保存回执草稿
          </button>
          {bootstrap.features.receiptCheck && (
            <button
              className="button secondary"
              type="button"
              disabled={!bootstrap.ai.enabled}
              onClick={() => void check()}
            >
              <Sparkle size={18} />
              核对回执是否逐项回应
            </button>
          )}
        </div>
      </fieldset>
      {bootstrap.features.receiptCheck && !bootstrap.ai.enabled && (
        <p className="field-hint">
          自动文字核对暂不可用。请人工核对后直接发布，已有内容不会丢失。
        </p>
      )}
      {!dirty && savedDraft?.check && (
        <div className="check-results">
          <h3>回执文字核对提示</h3>
          {savedDraft.check.rows.map((row) => (
            <div className={`coverage ${row.status}`} key={row.itemId}>
              <strong>
                {savedDraft.items.find((item) => item.id === row.itemId)?.text}
              </strong>
              <span>
                {row.status === "response_found"
                  ? "有对应说明"
                  : row.status === "response_missing"
                    ? "未找到对应说明"
                    : "对应关系不清"}
              </span>
              <p>{row.explanation}</p>
              {row.receiptTextRefs.map((ref) => (
                <blockquote key={ref}>
                  {receiptTextSegments(savedDraft).find(
                    (segment) => segment.id === ref,
                  )?.text || "请对照回执全文"}
                </blockquote>
              ))}
            </div>
          ))}
          <p className="field-hint">
            只核对是否写明回应，不判断修好、质量或现场安全。
          </p>
        </div>
      )}
      <div className="publish-section">
        <label className="check-label">
          <input
            type="checkbox"
            checked={reviewed}
            onChange={(e) => setReviewed(e.target.checked)}
            disabled={!!busy}
          />
          <span>
            我已人工核对原始说明、回应事项和本次回执，并对发布内容负责。
          </span>
        </label>
        <button
          className="button primary"
          disabled={!!busy || !reviewed}
          onClick={() => void publish()}
        >
          发布回执，交居民确认
          <ArrowRight size={20} />
        </button>
        <p className="field-hint">
          发布后保存本版记录，工单进入待确认；不会自动关闭。
        </p>
      </div>
    </section>
  );
}

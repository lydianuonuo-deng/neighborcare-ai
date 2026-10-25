import { useEffect, useState } from "react";
import { DownloadSimple } from "@phosphor-icons/react";
import type { OperationsSummary, TicketFilters } from "../shared/operations";
import { api, message } from "./api";
import { date, Loading, Notice } from "./ui";

function Distribution({
  title,
  rows,
  onChoose,
}: {
  title: string;
  rows: { key: string; label: string; count: number }[];
  onChoose: (key: string) => void;
}) {
  const maximum = Math.max(1, ...rows.map((row) => row.count));
  return (
    <section className="analytics-panel">
      <h2>{title}</h2>
      <div className="distribution">
        {rows.map((row) => (
          <button
            key={row.key}
            className="distribution-row"
            onClick={() => onChoose(row.key)}
            aria-label={`查看${row.label}的${row.count}条工单`}
          >
            <span>{row.label}</span>
            <span className="distribution-track">
              <i style={{ width: `${(row.count / maximum) * 100}%` }} />
            </span>
            <strong>{row.count}</strong>
          </button>
        ))}
      </div>
    </section>
  );
}
export default function StaffAnalytics({
  filters,
  refreshVersion,
  onInspect,
}: {
  filters: TicketFilters;
  refreshVersion: number;
  onInspect: (patch: Partial<TicketFilters>) => void;
}) {
  const [summary, setSummary] = useState<OperationsSummary | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  useEffect(() => {
    let active = true;
    setBusy(true);
    setError("");
    const timer = setTimeout(() => {
      api
        .analytics(filters)
        .then((data) => {
          if (active) setSummary(data);
        })
        .catch((e) => {
          if (active) setError(message(e));
        })
        .finally(() => {
          if (active) setBusy(false);
        });
    }, 180);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [filters, refreshVersion]);
  async function download() {
    setExporting(true);
    setExportError("");
    try {
      const blob = await api.exportAnalytics(filters);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "linli-summary.csv";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setExportError(message(e));
    } finally {
      setExporting(false);
    }
  }
  if (!summary && busy) return <Loading text="正在汇总本场地数据…" />;
  return (
    <>
      {error && (
        <Notice error>
          {error} {summary && "下方保留上一次成功统计，当前筛选尚未更新。"}
        </Notice>
      )}
      {exportError && <Notice error>{exportError}</Notice>}
      {summary && (
        <>
          <div className="analytics-toolbar">
            <div>
              <span className="eyebrow">本场地 · 当前筛选</span>
              <p>
                {busy
                  ? "正在更新，图表暂为上次统计。"
                  : `统计时间：${date(summary.generatedAt)}（北京时间）`}
              </p>
            </div>
            <button
              className="button secondary"
              disabled={busy || exporting || !!error}
              onClick={() => void download()}
            >
              <DownloadSimple size={18} />
              {exporting ? "正在导出…" : "导出统计表"}
            </button>
          </div>
          {summary.totals.examples > 0 && (
            <Notice>
              当前统计包含 {summary.totals.examples}{" "}
              条只读样例，不代表真实试点表现。可在“记录来源”切换为手动提交。
            </Notice>
          )}
          <div className="analytics-kpis">
            {[
              ["total", "工单总数", summary.totals.total],
              ["active", "进行中", summary.totals.active],
              ["attention", "待居民回应", summary.totals.attention],
              ["closed", "当前已关闭", summary.totals.closed],
            ].map(([key, label, value]) => (
              <div key={key}>
                <span>{label}</span>
                <strong data-testid={`metric-${key}`}>{value}</strong>
              </div>
            ))}
          </div>
          <p className="analytics-definition">
            进行中包含待接单、处理中、待补充、待确认；“已关闭”是当前状态数量，不代表维修质量评定。当前已撤回{" "}
            {summary.totals.withdrawn} 条。
          </p>
          <div className="analytics-grid">
            <Distribution
              title="按处理状态"
              rows={summary.byStatus}
              onChoose={(key) =>
                onInspect({ status: key as TicketFilters["status"] })
              }
            />
            <Distribution
              title="按报修类别"
              rows={summary.byCategory}
              onChoose={(key) =>
                onInspect({ category: key as TicketFilters["category"] })
              }
            />
            <Distribution
              title="按报修地点"
              rows={summary.byLocation}
              onChoose={(key) => onInspect({ locationId: key })}
            />
            <section className="analytics-panel trend-panel">
              <h2>近14日新增</h2>
              <p>北京时间 · 按当前筛选后的提交记录计数</p>
              <svg
                className="trend-chart"
                viewBox="0 0 560 190"
                role="img"
                aria-label={`近14日每日新增工单，合计${summary.daily.reduce((sum, row) => sum + row.count, 0)}条；详细数据见下方表格`}
              >
                <line x1="10" y1="151" x2="550" y2="151" stroke="var(--line)" />
                {summary.daily.map((row, index) => {
                  const height =
                    (row.count /
                      Math.max(1, ...summary.daily.map((day) => day.count))) *
                    115;
                  const x = 15 + index * 38;
                  return (
                    <g key={row.date}>
                      <title>
                        {row.date}：{row.count}条
                      </title>
                      <rect
                        x={x}
                        y={150 - height}
                        width="24"
                        height={height}
                        rx="4"
                        fill="var(--forest)"
                      />
                      <text x={x + 12} y={140 - height} textAnchor="middle">
                        {row.count}
                      </text>
                      {[0, 6, 13].includes(index) && (
                        <text x={x + 12} y="177" textAnchor="middle">
                          {row.date.slice(5)}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
              <details className="trend-table">
                <summary>查看每日数量</summary>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">日期</th>
                      <th scope="col">新增工单</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.daily.map((row) => (
                      <tr key={row.date}>
                        <td>{row.date}</td>
                        <td>{row.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </section>
          </div>
          {!summary.totals.total && (
            <Notice>
              当前筛选没有记录。可以调整筛选，或在演示空间手动载入只读样例查看图表。
            </Notice>
          )}
          <p className="field-hint">
            导出仅含分类汇总及每日数量，不含报修原文、照片、身份或会话信息。
          </p>
        </>
      )}
    </>
  );
}

import { useId } from "react";
import type { Location } from "../shared/types";
import { CATEGORY_LABELS, STATUS_LABELS } from "../shared/types";
import {
  DEFAULT_TICKET_FILTERS,
  type TicketFilters as Filters,
} from "../shared/operations";

export default function TicketFilters({
  value,
  onChange,
  locations = [],
  staff = false,
}: {
  value: Filters;
  onChange: (value: Filters) => void;
  locations?: Location[];
  staff?: boolean;
}) {
  const id = useId();
  const change = (key: keyof Filters, next: string) =>
    onChange({ ...value, [key]: next });
  return (
    <section className="filter-panel" aria-label="筛选报修记录">
      <div className="filter-search">
        <label htmlFor={`${id}-query`}>关键词搜索</label>
        <input
          id={`${id}-query`}
          type="search"
          maxLength={150}
          placeholder="工单号、位置或问题说明"
          value={value.query}
          onChange={(e) => change("query", e.target.value)}
        />
      </div>
      <div>
        <label htmlFor={`${id}-status`}>工单状态</label>
        <select
          id={`${id}-status`}
          value={value.status}
          onChange={(e) => change("status", e.target.value)}
        >
          <option value="all">全部状态</option>
          <option value="active">进行中</option>
          <option value="attention">需要居民回应</option>
          <option value="ended">已结束</option>
          {Object.entries(STATUS_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={`${id}-category`}>报修类别</label>
        <select
          id={`${id}-category`}
          value={value.category}
          onChange={(e) => change("category", e.target.value)}
        >
          <option value="all">全部类别</option>
          {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {staff && (
        <>
          <div>
            <label htmlFor={`${id}-location`}>报修地点</label>
            <select
              id={`${id}-location`}
              value={value.locationId}
              onChange={(e) => change("locationId", e.target.value)}
            >
              <option value="">全部地点</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${id}-assignee`}>负责人范围</label>
            <select
              id={`${id}-assignee`}
              value={value.assignee}
              onChange={(e) => change("assignee", e.target.value)}
            >
              <option value="all">全部负责人</option>
              <option value="mine">我负责的</option>
              <option value="unassigned">尚未分配</option>
            </select>
          </div>
          <div>
            <label htmlFor={`${id}-source`}>记录来源</label>
            <select
              id={`${id}-source`}
              value={value.source}
              onChange={(e) => change("source", e.target.value)}
            >
              <option value="all">全部记录（含样例）</option>
              <option value="manual">手动提交</option>
              <option value="example">只读样例</option>
            </select>
          </div>
          <div>
            <label htmlFor={`${id}-period`}>提交时间</label>
            <select
              id={`${id}-period`}
              value={value.period}
              onChange={(e) => change("period", e.target.value)}
            >
              <option value="all">全部时间</option>
              <option value="7">近7天（北京时间）</option>
              <option value="30">近30天（北京时间）</option>
            </select>
          </div>
          <div>
            <label htmlFor={`${id}-sort`}>排列顺序</label>
            <select
              id={`${id}-sort`}
              value={value.sort}
              onChange={(e) => change("sort", e.target.value)}
            >
              <option value="updated">最近更新优先</option>
              <option value="newest">最新提交优先</option>
              <option value="oldest">最早提交优先</option>
            </select>
          </div>
        </>
      )}
      <button
        className="text-button filter-reset"
        onClick={() => onChange({ ...DEFAULT_TICKET_FILTERS })}
      >
        清空筛选
      </button>
    </section>
  );
}

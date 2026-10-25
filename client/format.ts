const calendar = {
  timeZone: "Asia/Shanghai",
  month: "numeric",
  day: "numeric",
} as const;
const dayFormat = new Intl.DateTimeFormat("zh-CN", calendar);
const timeFormat = new Intl.DateTimeFormat("zh-CN", {
  ...calendar,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
export const date = (value: string, time = true) =>
  (time ? timeFormat : dayFormat).format(new Date(value));

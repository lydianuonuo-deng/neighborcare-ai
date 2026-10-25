import type { AccountRole } from "./auth.js";

/** Public defaults for the isolated demo space, never configured private credentials. */
export const DEMO_ACCOUNTS: Array<{
  role: AccountRole;
  username: string;
  password: string;
  description: string;
}> = [
  {
    role: "resident",
    username: "resident",
    password: "LinliResident-2026!",
    description: "提交报修、查看进展、确认处理结果",
  },
  {
    role: "staff",
    username: "demo",
    password: "LinliDemo-2026!",
    description: "认领工单、记录进展、提交处理回执",
  },
  {
    role: "admin",
    username: "admin",
    password: "LinliAdmin-2026!",
    description: "开通工作人员、管理本场地账号",
  },
];

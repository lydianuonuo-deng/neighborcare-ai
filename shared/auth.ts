export type AccountRole = "resident" | "staff" | "admin";
export type AccountStatus = "active" | "disabled";
export interface PublicAccount {
  id: string;
  siteId: string;
  name: string;
  username: string;
  role: AccountRole;
  status: AccountStatus;
  createdAt: string;
  updatedAt: string;
}
export const ROLE_LABELS: Record<AccountRole, string> = {
  resident: "居民",
  staff: "工作人员",
  admin: "管理员",
};
export interface LoginInput {
  siteId: string;
  username: string;
  password: string;
}
export interface RegisterInput extends LoginInput {
  name: string;
}
export interface CreateStaffInput extends RegisterInput {
  role: "staff";
}
export interface AuthResult {
  user: PublicAccount;
}

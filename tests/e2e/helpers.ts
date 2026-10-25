import { expect, type APIRequestContext, type Page } from "@playwright/test";
export const residentPassword = "ResidentTest-2026!";
export async function registerResident(request: APIRequestContext) {
  const username = `r_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const input = {
    siteId: "demo",
    name: "测试居民",
    username,
    password: residentPassword,
  };
  const response = await request.post("/api/auth/register", { data: input });
  expect(response.status()).toBe(201);
  return { ...input, user: (await response.json()).user };
}
export async function loginUI(
  page: Page,
  username: string,
  password: string,
  next = "/staff",
) {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("账号", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".topbar-account")).toBeVisible();
}

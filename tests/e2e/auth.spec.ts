import { test, expect } from "@playwright/test";
import { loginUI, registerResident, residentPassword } from "./helpers";

const noOverflow = async (page: import("@playwright/test").Page) =>
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);

test("独立登录注册、确认密码、受保护回跳和居民权限拦截", async ({
  page,
}, info) => {
  await page.goto("/staff/analytics");
  await expect(page).toHaveURL(/\/login\?next=/);
  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await noOverflow(page);
  await page.screenshot({ path: info.outputPath("login.png"), fullPage: true });
  await page.getByRole("link", { name: "注册居民账号", exact: true }).click();
  await expect(page).toHaveURL(/\/register\?next=/);
  await page.getByLabel("称呼", { exact: true }).fill("陈邻居");
  const username = `ui_${crypto.randomUUID().slice(0, 20)}`;
  await page.getByLabel("账号", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill(residentPassword);
  await page
    .getByLabel("确认密码", { exact: true })
    .fill("DifferentPass-2026!");
  await page.getByRole("button", { name: "注册并进入居民空间" }).click();
  await expect(page.getByRole("alert")).toContainText("两次输入的密码不一致");
  await page.getByLabel("确认密码", { exact: true }).fill(residentPassword);
  await page.getByRole("button", { name: "注册并进入居民空间" }).click();
  await expect(page).toHaveURL(/3031\/$/);
  await page.goto("/staff/users");
  await expect(
    page.getByRole("heading", { name: "当前账号没有访问权限" }),
  ).toBeVisible();
  expect((await page.request.get("/api/admin/users")).status()).toBe(403);
  await page
    .locator(".topbar-account")
    .getByRole("button", { name: "退出登录" })
    .click();
  await loginUI(page, username, residentPassword, "/new");
  await expect(page).toHaveURL(/\/new$/);
  await noOverflow(page);
});

test("账号切换草稿隔离、同账号跨设备访问且其他账号不可读取", async ({
  page,
  browser,
}) => {
  const a = await registerResident(page.request);
  await page.goto("/new");
  const privateText = "仅A居民可见的草稿：花园灯晚上没有亮。";
  await page.getByLabel("具体位置").selectOption("demo-garden");
  await page.getByLabel("现场说明").fill(privateText);
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByText("草稿已保存", { exact: true })).toBeVisible();
  await page
    .locator(".topbar-account")
    .getByRole("button", { name: "退出登录" })
    .click();
  const b = await registerResident(page.request);
  await page.goto("/new");
  await expect(page.getByLabel("现场说明")).toHaveValue("");
  await page
    .locator(".topbar-account")
    .getByRole("button", { name: "退出登录" })
    .click();
  await loginUI(page, a.username, a.password, "/new");
  await expect(page.getByLabel("现场说明")).toHaveValue(privateText);
  await page.getByRole("button", { name: "下一步，核对信息" }).click();
  await page.getByRole("checkbox", { name: /我已核对位置/ }).check();
  await page.getByRole("button", { name: "确认提交报修" }).click();
  await expect(page).toHaveURL(/\/tickets\/[\w-]+\?submitted=1$/);
  const url = page.url();
  const second = await browser.newContext({
    baseURL: "http://127.0.0.1:3031",
    viewport: page.viewportSize()!,
  });
  try {
    const other = await second.newPage();
    await loginUI(other, a.username, a.password, new URL(url).pathname);
    await expect(other.getByText(privateText, { exact: true })).toBeVisible();
    await other
      .locator(".topbar-account")
      .getByRole("button", { name: "退出登录" })
      .click();
    await loginUI(other, b.username, b.password, new URL(url).pathname);
    await expect(
      other.getByRole("heading", { name: "暂时无法查看这份报修" }),
    ).toBeVisible();
    await expect(other.getByText(privateText, { exact: true })).toHaveCount(0);
  } finally {
    await second.close();
  }
});

test("管理员独立开通、停用和恢复工作人员，工作人员不能管理账号", async ({
  page,
  browser,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await loginUI(page, "admin", "LinliAdmin-2026!", "/staff/users");
  await expect(
    page.getByRole("heading", { name: "每个身份，各司其职。" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "开通工作人员", exact: true }).click();
  const username = `s_${crypto.randomUUID().slice(0, 20)}`;
  const name = "新值班师傅";
  await page.getByLabel("工作人员姓名", { exact: true }).fill(name);
  await page.getByLabel("工作人员账号", { exact: true }).fill(username);
  await page.getByLabel("初始密码", { exact: true }).fill(residentPassword);
  await page.getByRole("button", { name: "确认开通", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已开通工作人员");
  await page.getByLabel("搜索账号或称呼").fill(username);
  const row = page.locator(".user-row").filter({ hasText: username });
  await expect(row).toBeVisible();
  await noOverflow(page);
  await page.screenshot({
    path: info.outputPath("accounts.png"),
    fullPage: true,
  });
  const staffContext = await browser.newContext({
    baseURL: "http://127.0.0.1:3031",
    viewport: page.viewportSize()!,
  });
  try {
    const staff = await staffContext.newPage();
    await loginUI(staff, username, residentPassword);
    await staff.goto("/staff/users");
    await expect(
      staff.getByRole("heading", { name: "当前账号没有访问权限" }),
    ).toBeVisible();
    expect((await staff.request.get("/api/admin/users")).status()).toBe(403);
    await row.getByRole("button", { name: "停用账号", exact: true }).click();
    await row.getByRole("button", { name: "确认停用", exact: true }).click();
    await expect(row.getByText("已停用", { exact: true })).toBeVisible();
    await staff.goto("/staff/analytics");
    await expect(staff).toHaveURL(/\/login\?next=/);
    await row.getByRole("button", { name: "恢复账号", exact: true }).click();
    await expect(row.getByText("正常", { exact: true })).toBeVisible();
    await loginUI(staff, username, residentPassword);
    await expect(
      staff.getByRole("heading", { name: "工作台", exact: true }),
    ).toBeVisible();
  } finally {
    await staffContext.close();
  }
  expect(errors).toEqual([]);
});

test("修改密码撤销所有设备登录；同浏览器另一个标签同步退出", async ({
  page,
  browser,
}) => {
  const a = await registerResident(page.request);
  const second = await browser.newContext({
    baseURL: "http://127.0.0.1:3031",
    viewport: page.viewportSize()!,
  });
  try {
    const other = await second.newPage();
    await loginUI(other, a.username, a.password, "/tickets");
    await page.goto("/account");
    await page
      .getByLabel("当前密码", { exact: true })
      .fill("WrongPassword-2026!");
    await page
      .getByLabel("新密码", { exact: true })
      .fill("ChangedPassword-2026!");
    await page
      .getByLabel("确认新密码", { exact: true })
      .fill("ChangedPassword-2026!");
    await page.getByRole("button", { name: "保存新密码并重新登录" }).click();
    await expect(page.getByRole("alert")).toContainText(/密码/);
    await page.getByLabel("当前密码", { exact: true }).fill(a.password);
    await page.getByRole("button", { name: "保存新密码并重新登录" }).click();
    await expect(page).toHaveURL(/\/login\?passwordChanged=1$/);
    await expect(page.getByRole("status")).toContainText("密码已修改");
    await other.reload();
    await expect(other).toHaveURL(/\/login\?next=/);
    await loginUI(
      page,
      a.username.toUpperCase(),
      "ChangedPassword-2026!",
      "/tickets",
    );
    const tab = await page.context().newPage();
    await tab.goto("/tickets");
    await expect(
      tab.getByRole("heading", { name: "我的报修", exact: true }),
    ).toBeVisible();
    await page
      .locator(".topbar-account")
      .getByRole("button", { name: "退出登录" })
      .click();
    await expect(tab).toHaveURL(/\/login\?next=/);
    await tab.close();
  } finally {
    await second.close();
  }
});

test("切换账号时迟到的旧身份响应不能恢复原账号草稿", async ({ page }) => {
  const a = await registerResident(page.request);
  await page.goto("/new");
  await page.getByLabel("现场说明").fill("A账号私密草稿，不能带入B账号。");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByText("草稿已保存", { exact: true })).toBeVisible();
  const oldBootstrap = await (await page.request.get("/api/bootstrap")).json();
  let signalCaptured!: () => void;
  const captured = new Promise<void>((resolve) => {
    signalCaptured = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const staleResponse = page.waitForResponse(
    async (response) =>
      response.url().endsWith("/api/bootstrap") &&
      (await response.json()).user?.id === a.user.id,
  );
  let intercept = true;
  await page.route("**/api/bootstrap", async (route) => {
    if (!intercept) {
      await route.continue();
      return;
    }
    intercept = false;
    signalCaptured();
    await released;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(oldBootstrap),
    });
  });
  const changed = () =>
    page.evaluate(() => {
      const c = new BroadcastChannel("linli-auth");
      c.postMessage("changed");
      c.close();
    });
  try {
    await changed();
    await captured;
    const b = await registerResident(page.request);
    await changed();
    await expect(page.locator(".account-chip")).toContainText(b.name);
    await expect(page.getByLabel("现场说明")).toHaveValue("");
    release();
    await (await staleResponse).finished();
    // Wait until React has rendered after consuming the late response.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect
      .poll(async () =>
        (await page.request.get("/api/bootstrap"))
          .json()
          .then((v) => v.user.id),
      )
      .toBe(b.user.id);
    await expect(page.getByLabel("现场说明")).toHaveValue("");
    expect(await page.locator(".account-chip").innerText()).not.toContain(
      a.username,
    );
  } finally {
    release();
    await page.unroute("**/api/bootstrap");
  }
});

test("登录页内置三类账号支持一键体验，并保持各自权限", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/login");
  await expect(
    page.getByRole("heading", { name: "内置演示账号" }),
  ).toBeVisible();
  await expect(page.locator(".demo-account-card")).toHaveCount(3);
  await expect(
    page.locator(".demo-account-card").filter({ hasText: "居民" }),
  ).toContainText("LinliResident-2026!");
  await noOverflow(page);
  await page.screenshot({
    path: info.outputPath("built-in-accounts.png"),
    fullPage: true,
  });
  for (const [role, label, path] of [
    ["resident", "居民", "/"],
    ["staff", "工作人员", "/staff"],
    ["admin", "管理员", "/staff"],
  ]) {
    await page
      .getByRole("button", { name: `一键体验${label}`, exact: true })
      .click();
    await expect(page.locator(".topbar-account")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(path);
    expect(
      (await (await page.request.get("/api/bootstrap")).json()).user.role,
    ).toBe(role);
    if (role === "resident")
      expect((await page.request.get("/api/staff/tickets")).status()).toBe(403);
    await page
      .locator(".topbar-account")
      .getByRole("button", { name: "退出登录" })
      .click();
    await expect(page).toHaveURL(/\/login$/);
  }
  expect(errors).toEqual([]);
});

import { test, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import { registerResident } from "./helpers";

test.beforeEach(async ({ page }) => {
  await registerResident(page.request);
});

async function submitReport(page: Page, description: string) {
  await page.goto("/new");
  await page.getByLabel("具体位置").selectOption("demo-corridor");
  await page.getByLabel("现场说明").fill(description);
  await page.getByRole("button", { name: "下一步，核对信息" }).click();
  await page.getByRole("checkbox", { name: /我已核对位置/ }).check();
  await page.getByRole("button", { name: "确认提交报修" }).click();
  await expect(page).toHaveURL(/\/tickets\/[\w-]+\?submitted=1$/);
  await expect(page.getByText(description, { exact: true })).toBeVisible();
  return new URL(page.url()).pathname.split("/").pop()!;
}

test("报修、独立工作人员回执、居民确认和按事项重开形成可刷新闭环", async ({
  page,
  browser,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const description = `二号楼一层楼道灯连续两个晚上不亮，白天外观没有明显破损。${info.project.name}`;
  const id = await submitReport(page, description);
  const staffContext = await browser.newContext({
    baseURL: "http://127.0.0.1:3031",
    viewport: page.viewportSize()!,
  });
  const staff = await staffContext.newPage();
  staff.on("pageerror", (error) => errors.push(error.message));
  await staff.goto("/staff");
  await staff.getByLabel("账号", { exact: true }).fill("demo");
  await staff.getByLabel("密码", { exact: true }).fill("LinliDemo-2026!");
  await staff.getByRole("button", { name: "登录" }).click();
  await expect(staff.getByRole("button", { name: "退出登录" })).toBeVisible();
  await staff.goto(`/staff/tickets/${id}`);
  await staff.getByRole("button", { name: "认领并开始处理" }).click();
  await staff
    .getByLabel("需要回应什么", { exact: true })
    .fill("楼道灯夜间不亮的处理情况");
  await staff.getByLabel("引用的原文片段").fill("楼道灯连续两个晚上不亮");
  const receipt = "已更换该楼道灯灯泡，夜间照明效果待工作人员复查。";
  await staff.getByLabel(/本次处理说明/).fill(receipt);
  const image = await sharp({
    create: { width: 64, height: 64, channels: 3, background: "#b7c8aa" },
  })
    .png()
    .toBuffer();
  await staff.locator("input[type=file]").setInputFiles({
    name: "test-receipt.png",
    mimeType: "image/png",
    buffer: image,
  });
  await expect(staff.getByAltText(/待发布处理照片/)).toBeVisible();
  await staff.getByRole("button", { name: "保存回执草稿" }).click();
  await expect(
    staff.getByRole("status").filter({ hasText: "回执草稿已保存" }),
  ).toBeVisible();
  await staff.getByRole("checkbox", { name: /我已人工核对原始说明/ }).check();
  await staff.getByRole("button", { name: "发布回执，交居民确认" }).click();
  await expect(staff.getByText("已发布回执，请核对处理情况")).toBeVisible();
  await page.reload();
  await expect(
    page
      .locator(".published-receipt .original-description")
      .filter({ hasText: receipt }),
  ).toBeVisible();
  await expect(
    page.getByText("本次未使用自动文字核对，请人工对照回执全文。"),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("resident-receipt.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "确认已解决" }).click();
  await expect(page.getByText("你已确认本次问题解决")).toBeVisible();
  await page.getByRole("button", { name: "问题仍在，反馈重开" }).click();
  await page
    .getByRole("checkbox", { name: "楼道灯夜间不亮的处理情况" })
    .check();
  await page.getByRole("button", { name: "提交反馈并重开" }).click();
  await expect(page.getByText("已收到，等待工作人员查看")).toBeVisible();
  await expect(page.getByText("反馈：楼道灯夜间不亮的处理情况")).toBeVisible();
  await page.reload();
  await expect(page.getByText("已收到，等待工作人员查看")).toBeVisible();
  await expect(page.getByText("当前负责人：林师傅")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  await staffContext.close();
});

test("草稿刷新恢复，陌生浏览器不能凭链接读取，原会话可撤回", async ({
  page,
  browser,
}) => {
  const description = "中心花园长椅靠背有松动，需要工作人员查看。";
  await page.goto("/new");
  await page.getByLabel("具体位置").selectOption("demo-garden");
  await page.getByLabel("现场说明").fill(description);
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByText("草稿已保存", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("现场说明")).toHaveValue(description);
  await page.getByRole("button", { name: "下一步，核对信息" }).click();
  await page.getByRole("checkbox", { name: /我已核对位置/ }).check();
  await page.getByRole("button", { name: "确认提交报修" }).click();
  await expect(page).toHaveURL(/\/tickets\/[\w-]+\?submitted=1$/);
  const strangerContext = await browser.newContext();
  const stranger = await strangerContext.newPage();
  await stranger.goto(page.url());
  await expect(
    stranger.getByRole("heading", { name: "欢迎回来" }),
  ).toBeVisible();
  await expect(stranger.getByText(description, { exact: true })).toHaveCount(0);
  await strangerContext.close();
  await page
    .locator("summary")
    .filter({ hasText: "需要撤回这次报修？" })
    .click();
  await page.getByRole("button", { name: "确认撤回报修" }).click();
  await expect(page.getByText("本次报修已撤回", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("浏览器禁用本地存储时仍能保存并提交，页面明确提示刷新风险", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Storage disabled", "SecurityError");
      },
    });
  });
  await page.goto("/new");
  await page.getByLabel("具体位置").selectOption("demo-garden");
  const description = "花园长椅靠背松动，暂时没有看到人员受伤。";
  await page.getByLabel("现场说明").fill(description);
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByText("草稿已保存", { exact: true })).toBeVisible();
  await expect(page.getByText(/无法保存本地副本/)).toBeVisible();
  await page.getByRole("button", { name: "下一步，核对信息" }).click();
  await page.getByRole("checkbox", { name: /我已核对位置/ }).check();
  await page.getByRole("button", { name: "确认提交报修" }).click();
  await expect(page).toHaveURL(/\/tickets\/[\w-]+\?submitted=1$/);
  await expect(page.getByText(description, { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("居民手动刷新列表可看见工作人员的新进展，刷新失败保留原记录", async ({
  page,
  browser,
}) => {
  const description = "社区广场路灯今天晚上没有亮，需工作人员查看。";
  const id = await submitReport(page, description);
  await page.goto("/tickets");
  const row = page.locator(".ticket-row").filter({ hasText: description });
  await expect(row.getByText("待接单", { exact: true })).toBeVisible();
  const staffContext = await browser.newContext({
    baseURL: "http://127.0.0.1:3031",
  });
  try {
    const staff = await staffContext.newPage();
    await staff.goto("/staff");
    await staff.getByLabel("账号", { exact: true }).fill("demo");
    await staff.getByLabel("密码", { exact: true }).fill("LinliDemo-2026!");
    await staff.getByRole("button", { name: "登录" }).click();
    await expect(staff.getByRole("button", { name: "退出登录" })).toBeVisible();
    await staff.goto(`/staff/tickets/${id}`);
    await staff.getByRole("button", { name: "认领并开始处理" }).click();
    await expect(
      staff.getByText("已接单，正在跟进处理", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "刷新报修记录" }).click();
    await expect(row.getByText("处理中", { exact: true })).toBeVisible();
    await page.route("**/api/me/tickets", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "UNAVAILABLE", message: "暂时无法更新，请稍后重试。" },
        }),
      }),
    );
    await page.getByRole("button", { name: "刷新报修记录" }).click();
    await expect(page.getByRole("alert")).toContainText("暂时无法更新");
    await expect(row.getByText("处理中", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  } finally {
    await staffContext.close();
  }
});

test("损坏的本地草稿与待提交缓存不会阻断新报修", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const userId = (await (await page.request.get("/api/bootstrap")).json()).user
    .id;
  await page.addInitScript((userId) => {
    localStorage.setItem(`linli.pending-submit.v2:${userId}`, "{broken JSON");
    localStorage.setItem(
      `linli.report-draft.v2:${userId}`,
      JSON.stringify({
        fields: {
          description: { invalid: true },
          locationId: 123,
          category: "invalid",
        },
      }),
    );
  }, userId);
  await submitReport(page, "一号楼门口垃圾桶盖损坏，需要工作人员查看。");
  expect(errors).toEqual([]);
});

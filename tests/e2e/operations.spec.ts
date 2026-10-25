import { test, expect, type Page } from "@playwright/test";
import { registerResident } from "./helpers";
import { readFile } from "node:fs/promises";

async function login(page: Page) {
  await page.goto("/staff");
  await page.getByLabel("账号", { exact: true }).fill("demo");
  await page.getByLabel("密码", { exact: true }).fill("LinliDemo-2026!");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("button", { name: "退出登录" })).toBeVisible();
}

test("工作台功能入口能切换工单中心、看板、统计与服务说明", async ({ page }) => {
  await login(page);
  const nav = page.getByRole("navigation", { name: "工作台功能" });
  for (const [name, path] of [
    ["工单中心", "/staff/tickets"],
    ["状态看板", "/staff/board"],
    ["数据统计", "/staff/analytics"],
    ["服务说明", "/staff/help"],
  ]) {
    await nav.getByRole("link", { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(
      page.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("只读样例支持组合筛选、看板和统计表下载，并明确区别于手动报修", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  await page.getByRole("button", { name: "载入12条只读样例" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "只读样例已就绪" }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "工作台功能" })
    .getByRole("link", { name: "工单中心", exact: true })
    .click();
  await page.getByLabel("记录来源").selectOption("example");
  await page.getByLabel("工单状态", { exact: true }).selectOption("pending");
  await expect(page.locator(".ticket-list .ticket-row")).toHaveCount(2);
  const number = await page.locator(".ticket-row .eyebrow").first().innerText();
  await page.getByLabel("关键词搜索").fill(`  ${number.toLowerCase()}  `);
  await expect(page.locator(".ticket-list .ticket-row")).toHaveCount(1);
  const original = await page.locator(".ticket-row h3").innerText();
  await page.locator(".ticket-row").click();
  await expect(page.getByText(/这是只读演示样例/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "认领并开始处理" }),
  ).toHaveCount(0);
  await page.goto("/staff/board");
  await expect(page.locator(".board-column")).toHaveCount(6);
  await page.goto("/staff/analytics");
  await page.getByLabel("记录来源").selectOption("example");
  await expect(page.getByTestId("metric-total")).toHaveText("12");
  await expect(page.getByText(/统计包含 12 条只读样例/)).toBeVisible();
  await page.screenshot({
    path: info.outputPath("analytics.png"),
    fullPage: true,
  });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "导出统计表" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.csv$/);
  const csv = await readFile((await download.path())!, "utf8");
  expect(csv).toContain("待接单");
  expect(csv).not.toContain(original);
  expect(csv).not.toContain(number);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("居民只能搜索和筛选自己的报修，可切换进行中与已结束", async ({ page }) => {
  await registerResident(page.request);
  await page.goto("/tickets");
  await expect(
    page.getByRole("heading", { name: "我的报修", exact: true }),
  ).toBeVisible();
  for (const [index, description] of [
    "花园长椅靠背松动，需要工作人员查看。",
    "走廊灯晚上没有亮，暂未发现其他情况。",
  ].entries()) {
    const draft = await (
      await page.request.post("/api/drafts", {
        data: {
          siteId: "demo",
          description,
          category: index ? "lighting" : "facility",
          locationId: "demo-garden",
        },
      })
    ).json();
    const response = await page.request.post("/api/tickets", {
      data: {
        draftId: draft.id,
        version: draft.version,
        description,
        category: draft.category,
        locationId: draft.locationId,
        confirmed: true,
        idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(response.status()).toBe(201);
    if (index === 1) {
      const ticket = (await response.json()).ticket;
      expect(
        (
          await page.request.post(`/api/tickets/${ticket.id}/events`, {
            data: {
              action: "withdraw",
              version: ticket.version,
              idempotencyKey: crypto.randomUUID(),
            },
          })
        ).ok(),
      ).toBe(true);
    }
  }
  await page.getByRole("button", { name: "刷新报修记录" }).click();
  await expect(page.locator(".ticket-row")).toHaveCount(2);
  await page.getByLabel("工单状态", { exact: true }).selectOption("active");
  await expect(page.locator(".ticket-row")).toHaveCount(1);
  await expect(page.locator(".ticket-row")).toContainText("长椅");
  await page.getByLabel("工单状态", { exact: true }).selectOption("ended");
  await expect(page.locator(".ticket-row")).toHaveCount(1);
  await expect(page.locator(".ticket-row")).toContainText("已撤回");
  await page.getByRole("button", { name: "清空筛选" }).click();
  await page.getByLabel("关键词搜索").fill("不存在的报修关键词");
  await expect(
    page.getByRole("heading", { name: "没有符合筛选条件的报修" }),
  ).toBeVisible();
});

test("统计钻取刷新旧列表，可查看另一居民刚提交的新工单", async ({
  page,
  browser,
}, info) => {
  await login(page);
  await page
    .getByRole("navigation", { name: "工作台功能" })
    .getByRole("link", { name: "工单中心", exact: true })
    .click();
  const description = `广场长椅靠背松动，独立新增验证 ${info.project.name}`;
  await page.getByLabel("关键词搜索").fill(description);
  await expect(
    page.getByRole("heading", { name: "没有符合筛选条件的工单" }),
  ).toBeVisible();
  const resident = await browser.newContext({
    baseURL: "http://127.0.0.1:3031",
  });
  try {
    await registerResident(resident.request);
    const draft = await (
      await resident.request.post("/api/drafts", {
        data: {
          siteId: "demo",
          description,
          category: "facility",
          locationId: "demo-square",
        },
      })
    ).json();
    expect(
      (
        await resident.request.post("/api/tickets", {
          data: {
            draftId: draft.id,
            version: draft.version,
            description,
            category: draft.category,
            locationId: draft.locationId,
            confirmed: true,
            idempotencyKey: crypto.randomUUID(),
          },
        })
      ).status(),
    ).toBe(201);
    await page
      .getByRole("navigation", { name: "工作台功能" })
      .getByRole("link", { name: "数据统计", exact: true })
      .click();
    await expect(page.getByTestId("metric-total")).toHaveText("1");
    await page
      .getByRole("button", { name: "查看待接单的1条工单", exact: true })
      .click();
    await expect(
      page.locator(".ticket-row").filter({ hasText: description }),
    ).toBeVisible();
  } finally {
    await resident.close();
  }
});

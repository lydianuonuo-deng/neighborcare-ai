# V0.4 账号与权限实施计划

居民注册后报修；公开注册只创建居民。登录 `/login` 与注册 `/register` 使用独立页面，管理员在 `/staff/users` 开通工作人员并启停账号，个人密码在 `/account` 修改。

1. 固定共享账号类型及接口；在现有 JSON 存储中增量增加账号，保留工单和图片。
2. 后台实现随机盐密码摘要、登录会话、角色与场地校验、限流、会话失效和账号管理。
3. 前端实现独立认证页面、登录后回跳、权限导航、账号管理和修改密码。
4. 草稿按身份分隔；游客原身份注册时沿用原记录归属，登录其他账号不会合并记录。
5. 临时数据库完成越权、会话、旧记录保留测试，再完成桌面和窄屏完整报修回归。

## 固定接口

- `POST /api/auth/register` `{siteId,name,username,password}` → 201 `{user}`，自动登录，角色固定 resident。
- `POST /api/auth/login` `{siteId,username,password}` → 200 `{user}`。
- `DELETE /api/auth/session` → 204，退出当前浏览器双角色会话。
- `PATCH /api/auth/password` `{currentPassword,newPassword}` → 204，撤销全部旧会话，需要重新登录。
- `GET /api/admin/users` → `{users: PublicAccount[]}`，只限本场地 admin。
- `POST /api/admin/users` `{siteId,name,username,password,role:"staff"}` → 201 `{user}`。
- `PATCH /api/admin/users/:id` `{status:"active"|"disabled"}` → `{user}`，禁止停用自己/管理员；停用撤销会话。
- bootstrap 增加 `user:PublicAccount|null`、`guestId:string|null`，staff 增加 `role`。

## 边界

- 登录、注册不接受提权参数；工作人员和管理员不能以居民身份提交或确认报修。
- 角色控制、场地控制、工单归属由后台验证，页面隐藏按钮仅辅助使用。
- 旧匿名 cookie 仅用于注册时保留旧归属，新的草稿与报修要求已登录居民；不以编号或链接找回权限。
- 居民密码 12–128 字符，账号 3–32 位英文字母/数字/下划线/短横线，大小写不区分，姓名 1–40 字符。
- 演示管理员 `admin / LinliAdmin-2026!`；试点必须显式配置管理员凭据。首次写入后不以环境变量覆盖已存在账号。
- 仅使用隔离临时数据库测试，不清空或重置当前演示数据。

## 密码实现依据

Node.js crypto.scrypt 异步派生密码摘要，随机盐至少 16 字节；本项目选择 N=16384、r=8、p=5，maxmem=64MiB，限制并发派生。
来源：[Node.js Crypto](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)、[OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)。本地接口测试验证随机盐、摘要存储、失效及权限行为。

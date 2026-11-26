# SoundFace API（Cloudflare Workers）

登录（邮箱 / 手机号验证码）、credit 余额、兑换码、数字人会话代理。说明见 `../docs/DEVELOPMENT.md` 的“服务端（Cloudflare Workers）”一节。

```bash
npm install
cp .dev.vars.example .dev.vars      # 开发登录、模拟服务商
npm run db:migrate:local
npm run dev                         # http://127.0.0.1:8787
npm test                            # 端到端测试（本地 workerd，不联网、不花钱）
npm run codes -- create --plan starter --count 5   # 本地生成兑换码
```

API 已部署到 https://soundface-api.dot.cc（模拟数字人），生产登录只启用邮箱。D1 已创建并写入 wrangler.jsonc，不要重复创建。实际收信仍待 QQ/163 邮箱确认。

管理后台页面在仓库根目录 `admin/`，本地地址 http://127.0.0.1:8787/admin/ 。在 `.dev.vars` 配置 `ADMIN_EMAILS=admin@example.com`，使用这个邮箱和开发验证码登录。名单为空时所有人均无管理权限，每个管理接口独立校验名单。

管理功能：概览、兑换码批次和作废、用户查询和详情、手动加减分钟、北京时间使用统计及 CSV、只读操作记录。余额仍以各用户的 Durable Object 为准，跨用户统计用 D1 汇总；失败写入保留在 DO 的 outbox 中并由 alarm 重试。原有用户下次访问会补齐汇总，也可在后台用户页手动重新汇总。

后台尚未部署；合并代码不等于上线。取得管理员邮箱和单独部署授权后：

1. `npx wrangler d1 migrations apply DB --remote`（必须先应用 0002_admin.sql，再发布新 Worker）。
2. `npx wrangler secret put ADMIN_EMAILS`，填入管理员邮箱，逗号分隔。
3. 在 `wrangler.jsonc` 的 routes 增加 admin.dot.cc 的 custom_domain 路由。
4. `npx wrangler deploy`，确认 `DEV_LOGIN=0`、`PROVIDER=fake`、`ALLOW_PAID=0`；先用名单外账号验证拒绝访问，再测真实邮箱收信、登录及后台操作。

`npm test` 串行启动独立本地 workerd，覆盖接口权限、兑换码状态、余额调整、统计对账、跨日归属、汇总重试/回填和审计失败回滚；不创建付费云端会话。

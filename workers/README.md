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

部署（需负责人的 Cloudflare 账号，尚未执行）：`wrangler d1 create soundface` → 把 `database_id` 填进 `wrangler.jsonc` → `wrangler d1 migrations apply DB --remote` → 在 Cloudflare 接入发信域名并设置 `MAIL_FROM` → `wrangler deploy`。

# Cloudflare 免费部署

与本地 Node 版本共用 server-core.js、game.js、bot.js 等规则。前端使用 Workers Static Assets；所有房间由一个 SQLite Durable Object（GameHub）协调，适合好友小规模使用。不会使用 Containers、R2 或付费套餐。

```sh
cd cloudflare
npm ci
npm run dev
# 另一个终端在项目根目录运行
node cloudflare/smoke.cjs
# 停止并重启模拟器后
node cloudflare/smoke.cjs http://127.0.0.1:8787 --verify
```

部署：运行 `npx wrangler login`，在自己的 Cloudflare 账号完成授权，再运行 `npm run deploy`。不需要把访问令牌写进仓库。生产部署需要账号和 Workers / Workers Scripts 写入权限；无需 Containers、Pages 或账单写入权限。

wrangler.jsonc 用 new_sqlite_classes 创建免费套餐可用的 SQLite Durable Object，使用 workers.dev HTTPS 地址。已有网站可另行绑定域名，但此配置不会修改 DNS，也不会开通付费订阅。免费额度并非无限，达到限额可能暂停服务，请在 Cloudflare 控制台查看 Workers 和 Durable Objects 用量。

## 持久化与同步

rooms 表按房间保存棋盘、玩家身份、托管信息、强化、奖励及 GM 操作编号；progress 表保存积分、收藏、已结算对局和积分发放去重记录。每次房间状态广播前先写 SQLite，积分更新先写 SQLite 再替换内存。快照不保存计时器对象；唤醒后重建在线状态和房主转交计时器。重启后仍需原 token 才能接回席位。

SSE 和轮询沿用原协议，Durable Object alarm 在活跃期间发送心跳和唤醒机器人；无人在线后停止周期唤醒，新的请求会恢复。所有连接都路由至同一个协调器，避免多实例出现不同棋盘。现有普通房间在全部真人退出后仍会关闭，不能从已关闭的房间恢复。

当前采用单协调器，没有实现大规模分房分片，也没有账号密码系统。更换域名会生成新的浏览器身份，本地主机的积分不会自动迁移到云端。生产 SQLite 数据不包含在源码中。

## 云端 GM 绑定

为避免公网用户填写 ww 就获得管理员权限，云端默认关闭 GM；本地版原昵称白名单保持不变。云端仅允许：昵称为 ww / ww.，且当前浏览器 token 的 SHA-256 指纹在秘密配置 GM_TOKEN_HASHES 中。该值为逗号分隔的小写十六进制哈希。

管理员在自己浏览器的开发者工具中计算当前站点身份指纹：

```js
const token = localStorage.getItem('chroma-token');
const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
console.log(Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2,'0')).join(''));
```

部署者用 `npx wrangler secret put GM_TOKEN_HASHES` 设置指纹（不会上传原 token），或在 Cloudflare 控制台添加同名 Secret；重新进入房间后，Ctrl+F1 可用。不要把原始 token 发到聊天、公开仓库或分享链接里。清除浏览器数据后需重新绑定。

## 发布与回滚

部署前运行项目完整测试、npm run check 和本地 cloudflare/smoke.cjs。部署后手动验证建房、不同浏览器加入、观战、SSE、轮询、托管及重连。需要回滚时使用 Cloudflare Workers 的版本回滚；不要删除 GameHub 的绑定、类、迁移记录或存储。源码有更新不代表需要创建 GitHub Release。

生成的 .cloudflare、.wrangler、node_modules、.dev.vars 以及任何凭据均不进 Git。prepare-assets.cjs 会剔除本地版的第三方嵌入图标；部署使用代码绘制的徽记。

# 项目结构

| 路径 | 职责 |
| --- | --- |
| config.js / server.config.example.json | 主机监听、端口、分享地址与来源校验 |
| server.js | HTTP API、房间列表、身份、观战、SSE、轮询及在线租期 |
| game.js | 地图、行动、计分、轮次和强化选牌规则 |
| anchors.js | 八款锚点目录与完赛奖励配置 |
| gm.js | 精确昵称白名单、受保护界面及发牌规则 |
| profile-store.js | 哈希身份、积分、收藏、原子存档与结算去重 |
| augments.js | 白银、黄金、棱彩各 12 张强化的定义 |
| bot.js | 遵守相同规则的机器人策略 |
| public/index.html | 页面和对话框入口 |
| public/app.js | 页面渲染、教程、卡面 SVG 与 RoomSync 同步客户端 |
| public/style.css | 桌面与移动布局 |
| test/ | 规则与真实 HTTP 集成测试 |

## 数据与身份

房间存在进程内存中。积分与锚点收藏持久化到 data/profiles.json；该文件不对外提供，也不随源码发布。随机浏览器令牌存入 localStorage，磁盘使用其哈希；公开快照剔除令牌和内部计时器，每人只获得自己的余额与收藏。规则在服务端判定，客户端仅给出可行动作提示。

观众与玩家分别登记，观众不能提交玩家动作。断开连接不等于退出；主动退出的席位暂交机器人托管，并保留同一身份接回的能力，直到房间被清理或进入下一局。

## 同步

SSE 首次状态超时 6 秒，后续 15 秒无数据或心跳则切换兼容轮询。正常轮询间隔 1 秒，失败后指数退避，最多 8 秒；兼容模式每 30 秒探测 SSE。每 5 秒发送 SSE 心跳，轮询在线租期 12 秒。

快照版本号递增，过时状态不会覆盖新状态。轮询可传 since 参数；没有变化时返回 204。客户端不自动重发行动，避免重复落色。退出时清理计时器、连接及在途请求。

## 主要接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /api/rooms | 公开房间列表 |
| GET | /api/catalog | 强化牌库 |
| GET | /api/network | 可用局域网地址与配置的分享地址 |
| GET | /api/events | 玩家或观众 SSE |
| GET | /api/state | 兼容轮询，X-Player-Token 请求头验证身份 |
| POST | /api/create、/api/join、/api/test | 建房、加入、测试房间 |
| POST | /api/watch、/api/leave | 观战或退出 |
| GET | /api/gm/console | 仅获授权玩家可获取控制台内容 |
| POST | /api/gm | 服务端逐次验证权限后发积分、战术牌或强化，带操作编号去重 |
| GET | /api/profile | 当前浏览器的积分、收藏与锚点目录，X-Player-Token 身份验证 |
| POST | /api/anchor | 仅大厅解锁或装备，校验积分和持有状态 |
| POST | /api/color | 大厅自选色或恢复默认，服务端验证 36 色及占用冲突 |
| POST | /api/ready、/api/settings、/api/start | 大厅控制 |
| POST | /api/action、/api/draft、/api/skip、/api/reset | 行动、选牌、离线跳过与结算后重置 |

POST 使用 JSON 和 X-Player-Token 请求头。服务端校验同源来源；支持与 Host 匹配的 HTTP / HTTPS 来源，代理改写 Host 时可设置 PUBLIC_URL。代理头不用于自动放宽来源校验。部署说明见 HOSTING.md。

# 当前 HTTP / SSE 接口（0.5.1）

这是从当前代码整理的接口约定，不是已完成的平台 SDK。所有路径相对于游戏根地址。API JSON 字段未做稳定版本承诺，改造后请同步本文件及回归测试。

## 身份与请求

浏览器为自己生成 16 随机字节，编码为 32 位小写十六进制字符串，作为 `X-Player-Token` 请求头。它是游戏身份凭证，不是 GitHub 或平台 API token。同一个 token 用于原席位重连及积分存档；昵称不能当身份 ID。房间内 player.id 由服务端生成，不等于 token。

POST 使用 `Content-Type: application/json`。除建房以外通常需 `{ "room": "123456", ... }`；测试入口 /api/test 自动使用 000001。请求体上限约 8192 字符。成功通常返回完整房间快照，失败 `{ "error": "中文原因" }`；多数业务错误为 400，GM 拒绝为 403，/api/state 身份失效为 401、房间不存在为 404。不能只依赖状态码识别所有业务错误。

## 查询与同步

| 方法与路径 | 参数 / 返回 |
| --- | --- |
| GET /api/rooms | 无需 token；返回 `{rooms:[{code,test,hostName,players,maxPlayers,spectators,phase,round,maxRounds,canJoin}]}` |
| GET /api/catalog | 无需 token；返回 `{cards,tiers}` 强化目录 |
| GET /api/network | 无需 token；返回 `{addresses,publicUrl}`，当前主机地址信息 |
| GET /api/profile | 需要 token 请求头；返回 `{profile,anchors,rewardRules}` |
| GET /api/state?room=123456&since=12 | 需要 token 请求头，必须已在房间；since 可省略。返回完整快照，版本未变返回 204 无正文；同时续在线租期 |
| GET /api/events?room=123456&token=TOKEN | 原生 EventSource 不附加自定义请求头，所以使用查询参数；必须已在房间 |
| GET /api/gm/console?room=123456 | 需要 token 请求头；GM 返回 `{html}`，其他身份 403；不是可直接打开的网页 |

SSE 的普通 `message` 事件 data 为完整 JSON 快照；`ping` 每 5 秒发出，data 是 `{}`；`room-closed` 表示房间关闭，应停止同步。首次会收到 retry:1500。服务端没有 SSE 事件 ID / 历史补发，重连后拿最新完整状态。客户端以 revision 丢弃旧快照。

客户端默认 6 秒未收到首次有效状态或持续 15 秒没收到状态/心跳会退化到 HTTP；通常每秒轮询，故障退避至最多 8 秒，每 30 秒探测 SSE 恢复。轮询在线租期为 12 秒。所有写操作由用户发起，不应因网络错误自动重放；GM 有 requestId 去重，其他行动并没有通用幂等键。

## 写接口

下表字段均为 JSON 字段，room 除特别说明外必传；发起者来自请求头 token。

| POST 路径 | 字段及条件 |
| --- | --- |
| /api/create | `{name}`，不需要 room；返回新房间及房主身份 |
| /api/join | `{room,name}`；大厅入座，或同 token 接回尚存在的原席位；已有席位不会按新 name 改名 |
| /api/test | `{name}`；加入固定测试房间 000001，自带一名机器人 |
| /api/watch | `{room,name}`；进入观战，不占玩家席位；玩家需先退出才能观战 |
| /api/leave | `{room}`；退出玩家或观众；局内玩家改由机器人托管，原 token 可在房间仍存在时接回 |
| /api/ready | `{room}`；大厅准备状态切换，重复请求会再次切换 |
| /api/settings | `{room,rounds?,augmentEvery?}`；仅大厅房主，轮数 6/10/15，选牌间隔 2/3/5 |
| /api/color | `{room,color}`；大厅，色盘中的十六进制色值；null 恢复默认分配；不能与其他玩家重复 |
| /api/anchor | `{room,mode:"unlock",key:锚点ID}` 或 `{room,mode:"equip",key:锚点ID或null}`；仅大厅 |
| /api/start | `{room}`；仅大厅房主，至少两人，其他人在线并准备 |
| /api/action | `{room,mode,index?,second?}`；仅当前行动玩家，mode 为 paint/shield/splash/pierce/leap/end |
| /api/draft | `{room,mode:"pick",key:候选强化ID}` 或 `{room,mode:"reroll"}`；仅强化阶段且自己未选 |
| /api/skip | `{room}`；仅房主，跳过离线满 15 秒的当前玩家，或为离线未选牌玩家代选 |
| /api/reset | `{room}`；仅结算后房主，积分结算完成才可返回大厅 |
| /api/gm | `{room,mode,target,requestId,...}`；仅服务端认定 GM，target 是同房玩家 ID |

棋盘 index 是从 0 起的行优先一维下标：`index = 行 * game.size + 列`。回归基本功的第二格使用 second；end 不需要 index。费用、目标是否合法、手牌与强化效果都由服务端校验。

GM mode=points 传 amount（1–100000 的整数）；mode=card 传 key（splash/pierce/leap）、count（1–8）；mode=augment 传强化 key。requestId 为每次用户操作新生成的 32 位小写十六进制随机串，同一操作重试沿用它。成功快照另含 gmResult。积分去重可跨重启；发牌去重仅保存在当前内存房间中。默认 GM 是昵称白名单，平台应先改为真正管理员认证。

## 快照主要字段

| 字段 | 含义 |
| --- | --- |
| code / revision / phase | 房间号、递增版本、lobby/playing/finished |
| you / host | 自己及房主 player.id；观众没有 you |
| players | 成员、颜色、在线、准备、机器人与锚点等；不下发身份 token |
| spectating / spectatorCount / rejoinAvailable | 观战状态、在线观众数、原席位是否可接回 |
| rounds / augmentEvery | 对局长度与强化间隔 |
| game | 大厅为 null；对局包括 board/size/order/turn/round/active/ink/hands/augments/draft/scores/finished/winner 等 |
| cards / augmentCards / tiers / palette | 战术牌、强化牌、品阶、可用颜色目录 |
| profile / anchors / rewardRules | 本人积分收藏、锚点目录及奖励参数 |
| permissions.gm / gm | GM 权限；gm 仅对授权玩家附加目标余额及操作记录 |

game.active 是当前玩家 ID，game.turn 是 order 中的下标；game.draft 不为 null 时暂停正常行动。game.board 每格有 owner、terrain、shield、home 等属性。普通地块 terrain=plain，染井 well，障碍 rock。手牌、所有候选和选牌历史向玩家及观众公开。最终分数读 game.scores，胜者 ID 数组读 game.winner，并列可能有多个。

平台结果回传还需实现：读取 server.js 的 settleGame，使用 game.matchId 去重，待权威规则完成结算后发送，保留失败重试机制；当前不会主动调用平台接口，也不会发 postMessage。

## 最短调用示例（同源浏览器环境）

```js
const token = Array.from(crypto.getRandomValues(new Uint8Array(16)),
  n => n.toString(16).padStart(2, '0')).join('');
async function command(action, body) {
  const res = await fetch('/api/' + action, {
    method: 'POST',
    headers: {'Content-Type':'application/json', 'X-Player-Token':token},
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw Error(data.error);
  return data;
}
const room = await command('create', {name:'玩家甲'});
const events = new EventSource('/api/events?room=' + room.code + '&token=' + token);
events.onmessage = e => console.log(JSON.parse(e.data));
events.addEventListener('room-closed', () => events.close());
// 退出时：先关闭 events，再 await command('leave', {room:room.code})。
```

示例 token 必须持久保存才可重连，不能每次页面刷新都重新生成；正式原生客户端已自行处理。多个玩家需各自 token，不能把同一 token 分发给所有人。

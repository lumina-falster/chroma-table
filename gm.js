const {CARDS,rulesFor,eligibleAugments}=require('./game');
const {AUGMENTS,TIERS}=require('./augments');
const GM_NAMES=new Set(['ww','ww.']);
function isGm(player){return !!player&&!player.bot&&!player.spectator&&!!player.token&&GM_NAMES.has(player.name);}
function gmTargets(room,store){return room.players.map(p=>{
  const token=p.token||p.rejoinToken;
  return {id:p.id,name:p.name,points:token?store.get(token).points:null,hand:room.game?.hands[p.id]?.length??0,limit:room.game?rulesFor(room.game,p.id).handLimit:4};
});}
function executeGm(room,actor,body,store){
  if(!isGm(actor)||!room.players.includes(actor))throw Error('无 GM 权限');
  const {mode,target:targetId,requestId}=body;
  if(!/^[a-f0-9]{32}$/.test(requestId||''))throw Error('无效操作编号');
  const target=room.players.find(p=>p.id===targetId);if(!target)throw Error('目标玩家不在当前房间');
  const signature=JSON.stringify([mode,targetId,body.key??null,body.amount??null,body.count??null]);
  const receipt=actor.id+':'+requestId;
  const previous=room.gmRequests?.get(receipt);
  if(previous){if(previous.signature!==signature)throw Error('操作编号已使用，请重新提交');return {...previous.result,duplicate:true};}
  let message,actual;
  if(mode==='points'){
    const token=target.token||target.rejoinToken;if(!token)throw Error('机器人没有游戏积分账户');
    const granted=store.grantPoints(actor.token,token,body.amount,requestId);
    message=`已向 ${target.name} 发放 ${body.amount} 游戏积分，当前余额 ${granted.profile.points}`;actual=body.amount;
    if(granted.duplicate)return {message:'此操作已完成，未重复发放。'+message,actual,duplicate:true};
  }else if(mode==='card'||mode==='augment'){
    const g=room.game;if(room.phase!=='playing'||!g||g.finished)throw Error('对局进行中才能发牌');
    if(mode==='card'){
      if(!Object.hasOwn(CARDS,body.key))throw Error('请选择有效战术牌');
      if(!Number.isInteger(body.count)||body.count<1||body.count>8)throw Error('每次只能发放 1–8 张战术牌');
      const limit=rulesFor(g,target.id).handLimit,hand=g.hands[target.id];actual=Math.min(body.count,Math.max(0,limit-hand.length));
      if(!actual)throw Error(`目标手牌已满（上限 ${limit} 张）`);
      const cards=Array(actual).fill(body.key);hand.push(...cards);
      g.drawHistory[target.id].push({round:g.round,turn:g.turn+1,reason:'gm',cards});
      message=`已向 ${target.name} 发放 ${actual} 张「${CARDS[body.key].name}」${actual<body.count?'（已达到手牌上限）':''}`;
    }else{
      if(g.draft)throw Error('请等待全员完成强化选牌，再发放强化');
      if(!Object.hasOwn(AUGMENTS,body.key))throw Error('请选择有效强化卡');
      if(!eligibleAugments(g,target.id).includes(body.key))throw Error('该强化已持有或与现有强化互斥');
      g.augments[target.id].push(body.key);actual=1;message=`已向 ${target.name} 发放强化「${AUGMENTS[body.key].name}」`;
    }
  }else throw Error('无效 GM 操作');
  const result={message,actual,duplicate:false};
  (room.gmRequests??=new Map()).set(receipt,{signature,result});
  const entry={at:Date.now(),actor:actor.name,message};(room.gmAudit??=[]).unshift(entry);room.gmAudit=room.gmAudit.slice(0,30);
  if(room.game){room.game.log.unshift(`GM ${actor.name}：${message}`);room.game.log=room.game.log.slice(0,20);}
  return result;
}
function panelHtml(){
  return `<div class="gm-console-head"><div><span>CHROMA / GAME MASTER</span><h2>GM 控制台</h2></div><button class="gm-close" aria-label="关闭 GM 控制台">关闭 ×</button></div><div class="gm-session"><span data-gm-session></span><kbd>Ctrl + F1</kbd></div><div class="gm-status" role="status" data-gm-status>选择本房间玩家后发放。重复提交同一操作不会重复发放。</div><section class="gm-tools"><form data-gm-form="points"><h3>✦ 发游戏积分</h3><p>积分计入锚点解锁余额，保存到玩家存档。</p><label>目标玩家<select name="target" data-gm-target="points" aria-label="积分目标玩家"></select></label><label>发放数量<input name="amount" type="number" min="1" max="100000" step="1" value="1000" required aria-label="发放积分数量"></label><div class="gm-target-note" data-gm-note="points"></div><button class="button primary" type="submit">发放积分</button></form><form data-gm-form="card"><h3>▤ 发战术牌</h3><p>遵守强化后的手牌上限，多余数量不发放。</p><label>目标玩家<select name="target" data-gm-target="card" aria-label="战术牌目标玩家"></select></label><label>战术牌<select name="key" aria-label="发放战术牌">${Object.entries(CARDS).map(([key,c])=>`<option value="${key}">${c.name} · ${c.cost} 墨</option>`).join('')}</select></label><label>张数<input name="count" type="number" min="1" max="8" step="1" value="1" required aria-label="战术牌发放张数"></label><div class="gm-target-note" data-gm-note="card"></div><button class="button primary" type="submit">发放战术牌</button></form><form data-gm-form="augment"><h3>◈ 发强化卡</h3><p>不能重复或与已有强化互斥，选牌阶段暂不可用。</p><label>目标玩家<select name="target" data-gm-target="augment" aria-label="强化卡目标玩家"></select></label><label>强化卡<select name="key" aria-label="发放强化卡">${Object.entries(TIERS).map(([tier,name])=>`<optgroup label="${name}">${Object.entries(AUGMENTS).filter(([,a])=>a.tier===tier).map(([key,a])=>`<option value="${key}">${a.name}</option>`).join('')}</optgroup>`).join('')}</select></label><div class="gm-target-note" data-gm-note="augment"></div><small>回合开始类效果在下次回合生效。</small><button class="button primary" type="submit">发放强化卡</button></form></section><section class="gm-audit"><h3>最近操作</h3><div data-gm-audit></div></section>`;
}
module.exports={isGm,gmTargets,executeGm,panelHtml};

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {server,streams,rooms,botTimers}=require('../server');
test('局内退出与返回：原身份接回席位、取消托管、转交房主、清理空房',async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const root=`http://127.0.0.1:${server.address().port}`,tokens=['a'.repeat(32),'b'.repeat(32)],controllers=[];
  let code;
  const call=async(action,i=0,data={})=>{
    const r=await fetch(root+'/api/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Player-Token':tokens[i]},body:JSON.stringify({room:code,...data})});
    return {status:r.status,body:await r.json()};
  };
  const waitUntil=async(predicate)=>{const deadline=Date.now()+6000;while(!predicate()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,30));assert.ok(predicate());};
  try{
    code=(await call('create',0,{name:'退出房主'})).body.code;
    await call('join',1,{name:'留下玩家'});
    for(let i=0;i<2;i++){
      const abort=new AbortController();controllers.push(abort);
      const response=await fetch(`${root}/api/events?room=${code}&token=${tokens[i]}`,{signal:abort.signal});await response.body.getReader().read();
    }
    await call('ready',1);await call('start');
    const room=rooms.get(code),departing=room.players[0],remaining=room.players[1];
    const {act,current,draftAction}=require('../game');
    while(current(room.game)!==departing.id)act(room.game,current(room.game),{mode:'end'});
    const left=await call('leave');assert.equal(left.status,200);assert.equal(left.body.rejoinAvailable,true);
    assert.ok(left.body.players.every(p=>!('token' in p)&&!('rejoinToken' in p)&&!('originalName' in p)));
    assert.equal(room.host,remaining.id);assert.equal(departing.bot,true);assert.equal(departing.departed,true);assert.equal(departing.token,null);
    assert.equal(streams.has(tokens[0]),false);assert.ok(room.game.order.includes(departing.id));
    assert.equal((await call('action',0,{mode:'end'})).status,400);
    await waitUntil(()=>current(room.game)===remaining.id);
    assert.ok(room.game.log.some(l=>l.includes('退出房间')));
    // Rejoining keeps the exact game state and cancels an already queued bot action.
    await call('action',1,{mode:'end'});assert.equal(current(room.game),departing.id);assert.equal(botTimers.has(code),true);
    const before=JSON.stringify({board:room.game.board,hands:room.game.hands,augments:room.game.augments,ink:room.game.ink});
    const returned=await call('join',0,{name:'不能覆盖旧昵称'});assert.equal(returned.status,200);assert.equal(returned.body.you,departing.id);
    assert.equal(departing.name,'退出房主');assert.equal(departing.bot,false);assert.equal(departing.departed,undefined);assert.equal(departing.rejoinToken,undefined);
    assert.equal(room.host,remaining.id);assert.equal(botTimers.has(code),false);
    await new Promise(resolve=>setTimeout(resolve,500));
    assert.equal(JSON.stringify({board:room.game.board,hands:room.game.hands,augments:room.game.augments,ink:room.game.ink}),before);
    assert.equal((await call('action',0,{mode:'end'})).status,200);
    const stranger=await fetch(root+'/api/join',{method:'POST',headers:{'Content-Type':'application/json','X-Player-Token':'c'.repeat(32)},body:JSON.stringify({room:code,name:'退出房主'})});assert.equal(stranger.status,400);
    await call('leave',0);
    // A later draft must also be completed automatically for the departed seat.
    clearTimeout(botTimers.get(code));botTimers.delete(code);
    while(!room.game.draft)act(room.game,current(room.game),{mode:'end'});
    const offer=(await call('join',1)).body.game.draft.offers[0];
    const originalOffers=[...room.game.draft.offers[departing.id]];
    const duringDraft=await call('join',0);assert.equal(duringDraft.status,200);assert.deepEqual(duringDraft.body.game.draft.offers,originalOffers);assert.equal(botTimers.has(code),false);
    await call('leave',0);
    assert.equal((await call('draft',1,{mode:'pick',key:offer})).status,200);
    await waitUntil(()=>!room.game.draft);
    assert.equal(room.game.augments[departing.id].length,1);
    // Results keep the departed player's identity until the next lobby.
    clearTimeout(botTimers.get(code));botTimers.delete(code);
    while(!room.game.finished){if(room.game.draft){for(const id of room.game.order)draftAction(room.game,id,{mode:'pick',key:room.game.draft.offers[id][0]});}else act(room.game,current(room.game),{mode:'end'});}
    room.phase='finished';
    const reset=await call('reset',1);assert.equal(reset.status,200);assert.equal(reset.body.players.length,1);
    assert.equal((await call('leave',1)).status,200);assert.equal(rooms.has(code),false);
    // The fixed test room resets to exactly its original robot on an in-game exit.
    code='000001';await call('test');await call('start');assert.equal((await call('leave')).status,200);
    const testRoom=rooms.get(code);assert.equal(testRoom.phase,'lobby');assert.equal(testRoom.game,null);assert.equal(testRoom.host,null);assert.equal(testRoom.players.length,1);assert.equal(testRoom.players[0].departed,undefined);assert.equal(botTimers.has(code),false);
  }finally{
    controllers.forEach(c=>c.abort());for(const timer of botTimers.values())clearTimeout(timer);botTimers.clear();
    for(const set of streams.values())for(const res of set)res.end();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
});
test('真实 HTTP：8 人入房、准备、开局、公开手牌、回合与结算',async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const root=`http://127.0.0.1:${server.address().port}`;
  const tokens=Array.from({length:9},(_,i)=>i.toString(16).padStart(32,'0'));let code;
  async function call(action,i,data={}){const r=await fetch(root+'/api/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Player-Token':tokens[i]},body:JSON.stringify({room:code,...data})});return {status:r.status,body:await r.json()};}
  const controllers=[];
  try{
    const catalog=await (await fetch(root+'/api/catalog')).json();assert.equal(Object.keys(catalog.cards).length,36);
    for(const tier of Object.keys(catalog.tiers))assert.equal(Object.values(catalog.cards).filter(c=>c.tier===tier).length,12);
    const created=await call('create',0,{name:'房主'});assert.equal(created.status,200);code=created.body.code;
    for(let i=1;i<8;i++)assert.equal((await call('join',i,{name:`玩家${i}`})).status,200);
    assert.equal((await call('join',8)).status,400);assert.equal((await call('start',0)).status,400);
    for(let i=0;i<8;i++){
      const abort=new AbortController();controllers.push(abort);const r=await fetch(`${root}/api/events?room=${code}&token=${tokens[i]}`,{signal:abort.signal});assert.equal(r.status,200);
      const reader=r.body.getReader();await reader.read();
    }
    for(let i=1;i<8;i++)await call('ready',i);
    await call('settings',0,{rounds:6});const started=await call('start',0);assert.equal(started.status,200);let v=started.body;assert.equal(v.game.size,15);assert.deepEqual(v.game.hands[v.you],v.game.hand);assert.equal(Object.keys(v.game.hands).length,v.players.length);assert.equal(v.game.hand.length,2);assert.ok(v.players.every(p=>!('token'in p)));
    assert.equal((await call('action',8,{mode:'end'})).status,400);
    const idToIndex=Object.fromEntries(v.players.map((p,i)=>[p.id,i]));
    const wrong=(idToIndex[v.game.active]+1)%8;assert.equal((await call('action',wrong,{mode:'end'})).status,400);
    assert.equal((await call('skip',0)).status,400);
    const room=rooms.get(code), active=room.players.find(p=>p.id===v.game.active);
    const savedStreams=streams.get(active.token);streams.delete(active.token);active.disconnectedAt=Date.now();
    assert.equal((await call('skip',0)).status,400);
    active.disconnectedAt=Date.now()-16000;
    assert.equal((await call('skip',1)).status,400);
    const skipped=await call('skip',0);assert.equal(skipped.status,200);v=skipped.body;
    streams.set(active.token,savedStreams);delete active.disconnectedAt;
    for(let t=0;t<47;t++){
      const r=await call('action',idToIndex[v.game.active],{mode:'end'});assert.equal(r.status,200);v=r.body;
      if(v.game.draft){
        for(let i=0;i<8;i++){
          let offer=await call('join',i);assert.equal(Array.isArray(offer.body.game.draft.offers),true);
          assert.ok(offer.body.game.draft.offers.every(k=>offer.body.augmentCards[k].tier===offer.body.game.draft.tier));assert.equal(offer.body.game.tierBag,undefined);
          const chooser=offer.body.you;
          if(i===0){
            const original=[...offer.body.game.draft.offers];offer=await call('draft',i,{mode:'reroll'});assert.equal(offer.status,200);
            const observed=await call('join',1);
            assert.deepEqual(observed.body.game.draft.allOffers[chooser],offer.body.game.draft.offers);
            assert.equal(observed.body.game.draft.allRerolls[chooser],0);
            assert.deepEqual(observed.body.game.draftHistory.at(-1).offers[chooser],original);
            assert.deepEqual(observed.body.game.draftHistory.at(-1).rerolls[chooser][0],offer.body.game.draft.offers);
            assert.deepEqual(observed.body.game.hands[chooser],offer.body.game.hand);
          }
          const key=offer.body.game.draft.offers[0],pick=await call('draft',i,{mode:'pick',key});assert.equal(pick.status,200);v=pick.body;
          if(i===0){const observed=await call('join',1);assert.equal(observed.body.game.draft.picks[chooser],key);assert.equal(observed.body.game.draftHistory.at(-1).picks[chooser],key);}
        }
      }
    }
    assert.equal(v.phase,'finished');assert.ok(v.game.winner.length>=1);assert.ok(v.game.winner.every(id=>v.game.scores[id]===Math.max(...Object.values(v.game.scores))));assert.equal((await call('reset',1)).status,400);assert.equal((await call('reset',0)).body.phase,'lobby');
    const back=await call('join',0);assert.equal(back.body.you,created.body.you);
    assert.equal((await fetch(root+'/../server.js')).status,404);
  }finally{controllers.forEach(c=>c.abort());for(const set of streams.values())for(const res of set)res.end();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('固定测试房间：单人开局、自动机器人回合、重连和再来一局',async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const root=`http://127.0.0.1:${server.address().port}`,token='f'.repeat(32);
  const call=async(action,data={})=>{
    const r=await fetch(`${root}/api/${action}`,{method:'POST',headers:{'Content-Type':'application/json','X-Player-Token':token},body:JSON.stringify({room:'000001',...data})});
    const body=await r.json();assert.equal(r.status,200,body.error);return body;
  };
  const abort=new AbortController();
  try{
    let v=await call('test',{name:'测试者'});
    assert.equal(v.code,'000001');assert.equal(v.test,true);assert.equal(v.players.length,2);
    const bot=v.players.find(p=>p.bot);assert.ok(bot.ready&&bot.online);assert.equal(v.host,v.you);
    assert.equal((await call('test')).players.filter(p=>p.bot).length,1);
    v=await call('start');
    if(v.game.active===v.you)v=await call('action',{mode:'end'});
    assert.equal(v.game.active,bot.id);assert.equal(botTimers.has('000001'),false);
    const response=await fetch(`${root}/api/events?room=000001&token=${token}`,{signal:abort.signal});
    const reader=response.body.getReader();await reader.read();
    const deadline=Date.now()+6000;
    while(rooms.get('000001').game.order[rooms.get('000001').game.turn]===bot.id&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
    v=await call('join');assert.equal(v.game.active,v.you);assert.ok(v.game.scores[bot.id]>1);assert.ok(v.game.log.some(l=>l.includes('测试机器人 结束了回合')));assert.deepEqual(v.game.hands[v.you],v.game.hand);assert.equal(Object.keys(v.game.hands).length,v.players.length);
    const room=rooms.get('000001');const {act,current,draftAction}=require('../game');
    while(!room.game.draft)act(room.game,current(room.game),{mode:'end'});
    v=await call('join');assert.equal(v.game.draft.offers.length,3);assert.equal(v.game.draft.rerolls,1);assert.equal(Object.keys(v.game.draft.allOffers).length,2);assert.deepEqual(v.game.draft.allOffers[v.you],v.game.draft.offers);assert.equal(v.game.draftHistory.length,1);
    const oldOffer=[...v.game.draft.offers];v=await call('draft',{mode:'reroll'});
    assert.equal(v.game.draft.rerolls,0);assert.deepEqual(v.game.draftHistory[0].rerolls[v.you][0],v.game.draft.offers);assert.deepEqual(v.game.draftHistory[0].offers[v.you],oldOffer);assert.notDeepEqual([...v.game.draft.offers].sort(),oldOffer.sort());
    await call('draft',{mode:'pick',key:v.game.draft.offers[0]});
    const draftDeadline=Date.now()+4000;
    while(room.game.draft&&Date.now()<draftDeadline)await new Promise(r=>setTimeout(r,50));
    assert.equal(room.game.draft,null);assert.equal(room.game.augments[bot.id].length,1);v=await call('join');assert.equal(Object.keys(v.game.draftHistory[0].picks).length,2);assert.deepEqual(v.game.draftHistory[0].picks[bot.id],v.game.augments[bot.id][0]);assert.ok(v.game.drawHistory[bot.id].length>=2);
    while(!room.game.finished){if(room.game.draft){for(const id of room.game.order)draftAction(room.game,id,{mode:'pick',key:room.game.draft.offers[id][0]});}else act(room.game,current(room.game),{mode:'end'});}
    room.phase='finished';v=await call('reset');
    assert.equal(v.players.filter(p=>p.bot).length,1);assert.equal(v.players.find(p=>p.bot).ready,true);
    v=await call('leave');assert.equal(v.players.length,1);assert.equal(v.players[0].bot,true);assert.equal(v.host,null);
    v=await call('test');assert.equal(v.players.filter(p=>p.bot).length,1);assert.equal(v.host,v.you);
  }finally{
    abort.abort();for(const timer of botTimers.values())clearTimeout(timer);botTimers.clear();
    for(const set of streams.values())for(const res of set)res.end();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
});

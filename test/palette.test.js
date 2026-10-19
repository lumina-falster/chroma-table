const {test}=require('node:test');
const assert=require('node:assert/strict');
const {COLORS,PALETTE,act,current,draftAction}=require('../game');
const {server,rooms}=require('../server');

test('36 色盘含清新浅色，按 R 值及完整色号排序，默认 8 色顺序保持不变',()=>{
  assert.equal(PALETTE.length,36);
  assert.equal(new Set(PALETTE.map(c=>c.color)).size,36);
  assert.equal(new Set(PALETTE.map(c=>c.name)).size,36);
  assert.ok(PALETTE.every(c=>/^#[0-9a-f]{6}$/.test(c.color)&&c.name));
  assert.ok(COLORS.every(color=>PALETTE.some(c=>c.color===color)));
  assert.deepEqual(COLORS,['#e87748','#548bdb','#b28ae6','#52bba4','#dfb647','#e67d9c','#7b94a8','#9cae54']);
  for(let i=1;i<PALETTE.length;i++){
    const previous=PALETTE[i-1].color,current=PALETTE[i].color;
    assert.ok(parseInt(previous.slice(1,3),16)<=parseInt(current.slice(1,3),16));
    assert.ok(parseInt(previous.slice(1),16)<parseInt(current.slice(1),16));
  }
  assert.equal(PALETTE.filter(c=>['嫩薄荷','冰蓝','蜜桃','柠檬奶','抹茶','浅薰衣草','雾紫','柔樱','海盐','晴雾','浅青','开心果'].includes(c.name)).length,12);
});

test('多人选色：默认分配、并发互斥、越权拦截、观战同步、重连与再开局保留',async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const root=`http://127.0.0.1:${server.address().port}`;
  const tokens=Array.from({length:9},(_,i)=>(i+1).toString(16).repeat(32));let code;
  const call=async(action,i=0,data={})=>{
    const response=await fetch(root+'/api/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Player-Token':tokens[i]},body:JSON.stringify({room:code,...data})});
    return {status:response.status,body:await response.json()};
  };
  const poll=async i=>{const r=await fetch(root+'/api/state?room='+code,{headers:{'X-Player-Token':tokens[i]}});assert.equal(r.status,200);return r.json();};
  try{
    code=(await call('create',0,{name:'选色房主'})).body.code;
    for(let i=1;i<8;i++)assert.equal((await call('join',i,{name:'选色玩家'+i})).status,200);
    let snapshot=await poll(0);
    assert.deepEqual(snapshot.players.map(p=>p.color),COLORS);assert.ok(snapshot.players.every(p=>p.colorChoice===null));assert.equal(snapshot.palette.length,36);
    const custom=PALETTE.find(c=>c.name==='嫩薄荷').color;
    let changed=await call('color',0,{color:custom,id:snapshot.players[1].id});assert.equal(changed.status,200);assert.equal(changed.body.players[0].color,custom);assert.equal(changed.body.players[1].color,COLORS[1]);
    assert.equal((await call('color',1,{color:COLORS[0]})).status,200);
    changed=await call('color',0,{color:null});assert.equal(changed.body.players[0].color,COLORS[1]);assert.equal(changed.body.players[0].colorChoice,null);
    for(const color of ['#ffffff','red','url(x)',0,{},undefined])assert.equal((await call('color',0,{color})).status,400);
    assert.equal((await call('color',0,{color:COLORS[0]})).status,400);
    const contested=PALETTE.find(c=>c.name==='湖青').color;
    const race=await Promise.all([call('color',0,{color:contested}),call('color',1,{color:contested})]);
    assert.deepEqual(race.map(r=>r.status).sort(),[200,400]);
    snapshot=await poll(0);assert.equal(new Set(snapshot.players.map(p=>p.color)).size,8);
    assert.equal((await call('watch',8)).status,200);assert.equal((await call('color',8,{color:PALETTE[20].color})).status,400);
    const observed=await poll(8);assert.deepEqual(observed.players.map(p=>p.color),snapshot.players.map(p=>p.color));
    assert.equal((await call('color',0,{color:custom})).status,200);
    const rejoined=await call('join',0,{name:'重连'});assert.equal(rejoined.body.players[0].color,custom);assert.equal(rejoined.body.players[0].colorChoice,custom);
    const before=rejoined.body.players.map(p=>p.color);
    await call('settings',0,{rounds:6,augmentEvery:5});for(let i=0;i<8;i++)await poll(i);for(let i=1;i<8;i++)await call('ready',i);
    assert.equal((await call('start')).status,200);assert.equal((await call('color',0,{color:null})).status,400);
    const room=rooms.get(code);assert.deepEqual(room.players.map(p=>p.color),before);
    // Finish with the real rules to verify that returning to the lobby keeps the palette.
    while(!room.game.finished){
      if(room.game.draft){for(const p of room.players)draftAction(room.game,p.id,{mode:'pick',key:room.game.draft.offers[p.id][0]});}
      else act(room.game,current(room.game),{mode:'end'});
    }
    room.phase='finished';assert.equal((await call('color',0,{color:null})).status,400);
    const reset=await call('reset');assert.equal(reset.status,200);assert.deepEqual(reset.body.players.map(p=>p.color),before);assert.equal(reset.body.players[0].colorChoice,custom);
    await call('leave',0);const replacement=await call('join',0,{name:'重新入座'});assert.equal(replacement.status,200);assert.equal(replacement.body.players.at(-1).colorChoice,null);
    assert.equal(new Set(replacement.body.players.map(p=>p.color)).size,8);
  }finally{
    const room=rooms.get(code);if(room){for(const p of [...room.players,...room.spectators||[]]){clearTimeout(p.pollTimer);clearTimeout(p.transferTimer);}rooms.delete(code);}
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
});

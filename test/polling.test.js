const {test}=require('node:test');
const assert=require('node:assert/strict');
const {server,rooms,streams,botTimers}=require('../server');

test('兼容轮询：身份验证、在线准备、对局与观战同步、租期过后离线',async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const root=`http://127.0.0.1:${server.address().port}`,tokens=['1'.repeat(32),'2'.repeat(32),'3'.repeat(32)];let code;
  const call=async(action,i,data={})=>{const r=await fetch(root+'/api/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Player-Token':tokens[i]},body:JSON.stringify({room:code,...data})});return {status:r.status,body:await r.json()};};
  const poll=async i=>{const r=await fetch(`${root}/api/state?room=${code}`,{headers:{'X-Player-Token':tokens[i]}});return {status:r.status,body:await r.json(),cache:r.headers.get('cache-control')};};
  try{
    code=(await call('create',0,{name:'轮询房主'})).body.code;await call('join',1,{name:'轮询玩家'});await call('watch',2);
    assert.equal((await poll(0)).status,200);await poll(1);const observed=await poll(2);assert.equal(observed.body.spectating,true);assert.equal(observed.body.spectatorCount,1);assert.ok(observed.cache.includes('no-store'));
    assert.ok(observed.body.players.every(p=>p.online&&!('pollTimer'in p)&&!('pollUntil'in p)&&!('transferTimer'in p)&&!('token'in p)));
    await call('ready',1);let started=await call('start',0);assert.equal(started.status,200);assert.equal(streams.size,0);
    const idToIndex=Object.fromEntries(started.body.players.map((p,i)=>[p.id,i]));const changed=await call('action',idToIndex[started.body.game.active],{mode:'end'});
    const live=await poll(2);assert.equal(live.body.game.active,changed.body.game.active);assert.ok(live.body.revision>started.body.revision);assert.equal(live.body.revision,changed.body.revision);
    assert.equal((await poll(2)).body.revision,live.body.revision);assert.equal((await call('action',2,{mode:'end'})).status,400);
    const unchanged=await fetch(`${root}/api/state?room=${code}&since=${live.body.revision}`,{headers:{'X-Player-Token':tokens[2]}});assert.equal(unchanged.status,204);assert.equal(await unchanged.text(),'');
    const unauthorized=await fetch(`${root}/api/state?room=${code}&token=${tokens[0]}`);assert.equal(unauthorized.status,401);
    const absent=await fetch(root+'/api/state?room=999999',{headers:{'X-Player-Token':tokens[0]}});assert.equal(absent.status,404);
    const room=rooms.get(code),host=room.players[0],expiry=host.pollUntil;
    const finalExpiry=Math.max(...[...room.players,...room.spectators].map(p=>p.pollUntil||0));
    assert.ok(expiry>Date.now());await new Promise(resolve=>setTimeout(resolve,Math.max(0,finalExpiry-Date.now())+100));
    assert.equal(host.disconnectedAt,expiry);assert.equal(room.spectators[0].disconnectedAt>=expiry,true);
    const restored=await poll(0);assert.equal(restored.body.players[0].online,true);assert.equal(host.disconnectedAt,undefined);assert.equal(host.transferTimer,undefined);
    await call('leave',2);assert.equal((await poll(2)).status,401);
    const left=await call('leave',1);assert.equal(left.status,200);assert.equal(room.players[1].pollUntil,undefined);assert.equal(room.players[1].pollTimer,undefined);
    await call('leave',0);assert.equal((await poll(0)).status,404);
  }finally{
    for(const room of rooms.values())for(const p of [...room.players,...room.spectators||[]]){clearTimeout(p.pollTimer);clearTimeout(p.transferTimer);}
    for(const timer of botTimers.values())clearTimeout(timer);botTimers.clear();for(const set of streams.values())for(const res of set)res.end();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
});

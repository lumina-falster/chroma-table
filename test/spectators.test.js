const {test}=require('node:test');
const assert=require('node:assert/strict');
const {server,rooms,streams,botTimers}=require('../server');
const {act,current,draftAction}=require('../game');

test('房间列表与观战：满员可看、实时同步、禁止越权、选牌不等待观众',async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const root=`http://127.0.0.1:${server.address().port}`,tokens=Array.from({length:10},(_,i)=>(100+i).toString(16).padStart(32,'0')),controllers=[];
  let code;const readerAborts=new WeakMap();
  const call=async(action,i,data={})=>{const r=await fetch(root+'/api/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Player-Token':tokens[i]},body:JSON.stringify({room:code,...data})});return {status:r.status,body:await r.json()};};
  const list=async()=>{const r=await fetch(root+'/api/rooms');assert.equal(r.status,200);return (await r.json()).rooms;};
  const events=async i=>{const abort=new AbortController();controllers.push(abort);const r=await fetch(`${root}/api/events?room=${code}&token=${tokens[i]}`,{signal:abort.signal});assert.equal(r.status,200);const reader=r.body.getReader();readerAborts.set(reader,abort);await reader.read();return reader;};
  try{
    assert.ok((await list()).some(r=>r.code==='000001'&&r.test));
    code=(await call('create',0,{name:'列表房主'})).body.code;
    let row=(await list()).find(r=>r.code===code);assert.equal(row.players,1);assert.equal(row.hostName,'列表房主');assert.equal(row.canJoin,true);
    assert.equal((await call('watch',8,{name:'观众'})).body.spectating,true);
    const reader=await events(8);assert.equal((await list()).find(r=>r.code===code).spectators,1);
    // Observation can become a seat before the game starts, then switch back on exit.
    const joined=await call('join',8);assert.equal(joined.status,200);assert.equal(joined.body.spectating,false);assert.equal(rooms.get(code).spectators.length,0);
    await call('leave',8);await call('watch',8);const spectatorReader=await events(8);
    for(let i=1;i<8;i++)await call('join',i,{name:`玩家${i}`});
    for(let i=0;i<8;i++){await events(i);if(i)await call('ready',i);}
    row=(await list()).find(r=>r.code===code);assert.equal(row.players,8);assert.equal(row.canJoin,false);
    assert.equal((await call('join',9)).status,400);assert.equal((await call('watch',9)).status,200);
    const started=await call('start',0);assert.equal(started.status,200);const room=rooms.get(code);
    assert.equal((await list()).find(r=>r.code===code).phase,'playing');
    const watched=await call('watch',8);assert.equal(watched.body.you,undefined);assert.equal(watched.body.spectating,true);assert.equal(watched.body.players.length,8);assert.equal(watched.body.game.order.length,8);assert.deepEqual(watched.body.game.hand,[]);assert.equal(watched.body.game.rules,null);
    assert.ok(watched.body.players.every(p=>!('token' in p)&&!('rejoinToken' in p)));
    for(const action of ['ready','start','settings','action','draft','skip','reset'])assert.equal((await call(action,8,{mode:'end',rounds:6})).status,400,action);
    // Drain lobby updates until the spectator's live SSE contains the actual match.
    const timeout=setTimeout(()=>readerAborts.get(spectatorReader).abort(),4000);timeout.unref();
    let live=false,buffer='';
    try{while(!live){const part=await spectatorReader.read();assert.equal(part.done,false);buffer+=new TextDecoder().decode(part.value);for(const line of buffer.split('\n'))if(line.startsWith('data: ')){try{if(JSON.parse(line.slice(6)).game?.order?.length===8)live=true;}catch{}}}}finally{clearTimeout(timeout);}
    while(!room.game.draft)act(room.game,current(room.game),{mode:'end'});
    const draft=(await call('watch',8)).body.game.draft;assert.equal(Object.keys(draft.allOffers).length,8);assert.deepEqual(draft.offers,[]);
    for(const id of room.game.order)draftAction(room.game,id,{mode:'pick',key:room.game.draft.offers[id][0]});
    assert.equal(room.game.draft,null);
    assert.equal((await call('leave',8)).status,200);assert.equal(room.players.length,8);assert.equal(room.host,started.body.host);
    await call('watch',8);assert.equal(room.spectators.filter(p=>p.token===tokens[8]).length,1);
    // Removing the final player closes an ordinary room and notifies spectators.
    const firstCode=code;await events(9);
    code=(await call('create',0,{name:'关闭房间验证'})).body.code;
    await call('watch',9);const closeReader=await events(9);
    await call('leave',0);assert.equal(rooms.has(code),false);assert.equal((await list()).some(r=>r.code===code),false);
    let closed=false;for(let i=0;i<4&&!closed;i++){const part=await closeReader.read();if(part.done)break;closed=new TextDecoder().decode(part.value).includes('event: room-closed');}assert.equal(closed,true);
    assert.equal(streams.get(tokens[9]).size,1);assert.equal([...streams.get(tokens[9])][0].roomCode,firstCode);
    assert.equal((await call('watch',9)).status,400);
  }finally{
    controllers.forEach(c=>c.abort());for(const t of botTimers.values())clearTimeout(t);botTimers.clear();
    for(const set of streams.values())for(const res of set)res.end();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
});

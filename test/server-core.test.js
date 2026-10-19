const {test}=require('node:test'),assert=require('node:assert/strict');
const {randomBytes}=require('node:crypto');
const {createGameServer}=require('../server-core');
const {ProfileStore}=require('../profile-store');

test('可复用后端隔离房间与存档，云端 GM 注入判权，状态和删除可持久化',async()=>{
  const snapshots=new Map(),deleted=[],token=randomBytes(16).toString('hex');
  const a=createGameServer({manualHeartbeat:true,profileStore:new ProfileStore(),isGm:()=>false,onChange:r=>snapshots.set(r.code,JSON.stringify(r,(key,v)=>['pollTimer','transferTimer'].includes(key)?undefined:v instanceof Map?[...v]:v)),onDelete:code=>deleted.push(code)});
  const b=createGameServer({manualHeartbeat:true,profileStore:new ProfileStore()});
  await Promise.all([a,b].map(service=>new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve))));
  const root=service=>'http://127.0.0.1:'+service.server.address().port;
  const post=async(service,action,body)=>{const r=await fetch(root(service)+'/api/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Player-Token':token},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  try{
    assert.notEqual(a.rooms,b.rooms);assert.notEqual(a.rooms.get('000001').players[0].id,b.rooms.get('000001').players[0].id);
    const created=await post(a,'create',{name:'ww'}),code=created.body.code;
    assert.equal(created.status,200);assert.equal(created.body.permissions.gm,false);assert.equal(a.rooms.has(code),true);assert.equal(b.rooms.has(code),false);
    assert.equal(JSON.parse(snapshots.get(code)).host,created.body.you);
    assert.equal((await post(b,'join',{room:code,name:'other'})).status,400);
    assert.equal((await fetch(root(a)+'/api/gm/console?room='+code,{headers:{'X-Player-Token':token}})).status,403);
    const saved=snapshots.get(code);assert.equal(saved.includes('pollTimer'),false);
    await post(a,'leave',{room:code});assert.ok(deleted.includes(code));assert.equal(a.rooms.has(code),false);
  }finally{
    for(const service of [a,b]){for(const room of service.rooms.values())for(const p of room.players){clearTimeout(p.pollTimer);clearTimeout(p.transferTimer);}service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}
  }
});

// Standalone package check. Does not connect to or change an existing server.
const assert=require('node:assert/strict');
const {randomBytes}=require('node:crypto');
const path=require('node:path');
const os=require('node:os');
process.env.CHROMA_DATA_DIR=path.join(os.tmpdir(),'chroma-integration-'+randomBytes(8).toString('hex'));
const {server,rooms,streams,botTimers,profileStore}=require('../server');
profileStore.file=null;
async function main(){
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const root='http://127.0.0.1:'+server.address().port;
  const tokens=Array.from({length:3},()=>randomBytes(16).toString('hex'));let code;
  async function post(action,i,data={}){
    const response=await fetch(root+'/api/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Player-Token':tokens[i]},body:JSON.stringify({room:code,...data})});
    const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;
  }
  try{
    assert.equal((await fetch(root+'/')).status,200);
    assert.ok((await (await fetch(root+'/api/rooms')).json()).rooms.some(r=>r.code==='000001'));
    const host=await post('create',0,{name:'接入自检甲'});code=host.code;
    const guest=await post('join',1,{name:'接入自检乙'});
    await post('watch',2,{name:'接入自检观众'});
    for(let i=0;i<3;i++)assert.equal((await fetch(root+'/api/state?room='+code,{headers:{'X-Player-Token':tokens[i]}})).status,200);
    await post('ready',1);let state=await post('start',0);assert.equal(state.phase,'playing');
    const active=state.game.active===host.you?0:1;
    state=await post('action',active,{mode:'end'});assert.notEqual(state.game.active,[host.you,guest.you][active]);
    const observed=await (await fetch(root+'/api/state?room='+code,{headers:{'X-Player-Token':tokens[2]}})).json();
    assert.equal(observed.spectating,true);assert.equal(observed.game.active,state.game.active);
    const denied=await fetch(root+'/api/gm/console?room='+code,{headers:{'X-Player-Token':tokens[0]}});assert.equal(denied.status,403);
    console.log('PASS：首页、房间列表、双人建房入座、观战、准备、开局、回合同步、普通账号 GM 拒绝。临时端口 '+server.address().port);
  }finally{
    for(const set of streams.values())for(const res of set)res.end();
    for(const timer of botTimers.values())clearTimeout(timer);
    for(const room of rooms.values())for(const p of [...room.players,...room.spectators||[]]){clearTimeout(p.pollTimer);clearTimeout(p.transferTimer);}
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});

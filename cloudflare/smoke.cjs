const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {randomBytes}=require('node:crypto');
const root=process.argv[2]||'http://127.0.0.1:8787',verify=process.argv.includes('--verify');
const fixture=path.join(__dirname,'..','.cloudflare','smoke-identities.json');
const read=async(route,token)=>{const r=await fetch(root+route,{headers:token?{'X-Player-Token':token}:{}});assert.equal(r.status,200,await r.clone().text());return r.json();};
const post=async(action,token,data)=>{const r=await fetch(root+'/api/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Player-Token':token,Origin:new URL(root).origin},body:JSON.stringify(data)});const value=await r.json();assert.equal(r.status,200,JSON.stringify(value));return value;};
async function main(){
  if(verify){
    const f=JSON.parse(fs.readFileSync(fixture,'utf8'));
    const state=await read('/api/state?room='+f.code,f.tokens[0]);
    assert.equal(state.phase,'finished');assert.equal(state.game.matchId,f.matchId);
    for(let i=0;i<8;i++){const {profile}=await read('/api/profile',f.tokens[i]);assert.equal(profile.points,f.points[i]);}
    const rejoined=await post('join',f.rejoinToken,{room:f.rejoinCode,name:'原席位'});assert.equal(rejoined.you,f.rejoinId);assert.equal(rejoined.players.find(p=>p.id===f.rejoinId).bot,false);
    assert.ok(rejoined.game);console.log('PASS: 模拟器重启后房间、棋盘、8 人积分及原 token 接回托管席位均保留。');return;
  }
  assert.equal((await fetch(root+'/')).status,200);assert.equal((await read('/api/network')).publicUrl,new URL(root).origin);
  const tokens=Array.from({length:9},()=>randomBytes(16).toString('hex'));let state=await post('create',tokens[0],{name:'云端测试0'});const code=state.code,ids=[state.you];
  for(let i=1;i<8;i++){state=await post('join',tokens[i],{room:code,name:'云端测试'+i});ids.push(state.you);await read('/api/state?room='+code,tokens[i]);await post('ready',tokens[i],{room:code});}
  state=await post('watch',tokens[8],{room:code,name:'观众'});assert.equal(state.spectating,true);
  await post('settings',tokens[0],{room:code,rounds:6,augmentEvery:2});
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),12000);
  const sse=await fetch(root+'/api/events?room='+code+'&token='+tokens[0],{signal:controller.signal});assert.equal(sse.status,200);assert.match(sse.headers.get('content-type'),/event-stream/);
  const reader=sse.body.getReader();let messages='';
  try{
    while(!messages.includes('data: {"code"'))messages+=new TextDecoder().decode((await reader.read()).value);
    assert.ok(messages.includes(code));
    state=await post('start',tokens[0],{room:code});assert.equal(state.players.length,8);
    while(!state.game.finished){
      if(state.game.draft){
        const draft=state.game.draft;
        for(let i=0;i<8;i++)if(!draft.picks[ids[i]])state=await post('draft',tokens[i],{room:code,mode:'pick',key:draft.allOffers[ids[i]][0]});
      }else{const i=ids.indexOf(state.game.active);state=await post('action',tokens[i],{room:code,mode:'end'});}
    }
  }finally{clearTimeout(timeout);controller.abort();await reader.cancel().catch(()=>{});}
  const spectator=await read('/api/state?room='+code,tokens[8]);assert.equal(spectator.game.finished,true);assert.ok(spectator.game.winner.length>0);
  const points=[];for(let i=0;i<8;i++){const first=(await read('/api/profile',tokens[i])).profile.points;assert.ok(first>=20);await read('/api/state?room='+code,tokens[i]);assert.equal((await read('/api/profile',tokens[i])).profile.points,first);points.push(first);}
  const gmToken=randomBytes(16).toString('hex');const gmRoom=await post('create',gmToken,{name:'ww'});assert.equal(gmRoom.permissions.gm,false);
  assert.equal((await fetch(root+'/api/gm/console?room='+gmRoom.code,{headers:{'X-Player-Token':gmToken}})).status,403);await post('leave',gmToken,{room:gmRoom.code});
  const one=randomBytes(16).toString('hex'),two=randomBytes(16).toString('hex');let rejoin=await post('create',one,{name:'接回席位'});const rejoinCode=rejoin.code,rejoinId=rejoin.you;
  await post('join',two,{room:rejoinCode,name:'留守玩家'});await read('/api/state?room='+rejoinCode,two);await post('ready',two,{room:rejoinCode});await post('start',one,{room:rejoinCode});await post('leave',one,{room:rejoinCode});
  fs.mkdirSync(path.dirname(fixture),{recursive:true});fs.writeFileSync(fixture,JSON.stringify({code,tokens,points,matchId:state.game.matchId,rejoinCode,rejoinId,rejoinToken:one}));
  if(process.argv.includes('--cleanup')){
    await post('leave',tokens[8],{room:code});
    for(let i=0;i<8;i++)await post('leave',tokens[i],{room:code});
    await post('join',one,{room:rejoinCode,name:'接回席位'});await post('leave',one,{room:rejoinCode});await post('leave',two,{room:rejoinCode});
  }
  console.log('PASS: Workers 8 人完整 6 轮、两次同阶强化、SSE、观战、结算积分幂等、云端 GM 拒绝冒名；已准备重启恢复校验。');
}
main().catch(e=>{console.error(e);process.exitCode=1;});

const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {ANCHORS}=require('../anchors');
const {ProfileStore}=require('../profile-store');

test('锚点目录：8 款、四阶、唯一标识及递增价格',()=>{
  assert.equal(ANCHORS.length,8);assert.equal(new Set(ANCHORS.map(a=>a.id)).size,8);
  assert.equal(new Set(ANCHORS.map(a=>a.tier)).size,4);
  assert.ok(ANCHORS.every((a,i)=>a.cost>0&&a.desc&&(!i||a.cost>ANCHORS[i-1].cost)));
});

test('积分存档：默认不佩戴、幂等结算、扣分解锁、免费换装及重启恢复',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chroma-profile-')),file=path.join(dir,'profiles.json'),token=randomBytes(16).toString('hex'),match=randomBytes(16).toString('hex');
  try{
    let store=new ProfileStore({file});assert.deepEqual(store.get(token),{points:0,earned:0,unlocked:[],equipped:null});
    assert.throws(()=>store.unlock(token,'dew'),/不足/);assert.throws(()=>store.equip(token,'cosmos'),/解锁/);
    assert.throws(()=>store.unlock(token,'toString'),/不存在/);assert.throws(()=>store.get('wrong'),/身份/);
    assert.ok(store.settle(match,[{token,points:1500}]));assert.equal(store.settle(match,[{token,points:1500}]),false);
    assert.equal(store.unlock(token,'dew').points,1440);assert.equal(store.unlock(token,'dew').points,1440);
    assert.equal(store.unlock(token,'cosmos').points,40);assert.equal(store.get(token).equipped,'cosmos');
    assert.equal(store.equip(token,null).equipped,null);assert.equal(store.equip(token,'dew').points,40);
    const copy=store.get(token);copy.points=99999;copy.unlocked.push('stellar');assert.equal(store.get(token).points,40);assert.equal(store.get(token).unlocked.length,2);
    store=new ProfileStore({file});assert.deepEqual(store.get(token),{points:40,earned:1500,unlocked:['dew','cosmos'],equipped:'dew'});
    assert.equal(store.settle(match,[{token,points:1500}]),false);assert.ok(!fs.readFileSync(file,'utf8').includes(token));
    assert.throws(()=>store.settle(randomBytes(16).toString('hex'),[{token,points:-1}]),/无效/);
    assert.throws(()=>store.settle(randomBytes(16).toString('hex'),[{token,points:NaN}]),/无效/);
    assert.throws(()=>store.settle(randomBytes(16).toString('hex'),[{token,points:1},{token,points:1}]),/重复/);
  }finally{for(const name of ['profiles.json','profiles.json.tmp'])if(fs.existsSync(path.join(dir,name)))fs.unlinkSync(path.join(dir,name));fs.rmdirSync(dir);}
});

test('存档失败不会在内存中扣钱或发放道具；损坏存档不会静默重置',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chroma-profile-error-')),file=path.join(dir,'profiles.json'),block=path.join(dir,'block'),token=randomBytes(16).toString('hex');
  try{
    const store=new ProfileStore();store.settle(randomBytes(16).toString('hex'),[{token,points:100}]);
    fs.writeFileSync(block,'not a directory');store.file=path.join(block,'profiles.json');
    assert.throws(()=>store.unlock(token,'dew'));assert.deepEqual(store.get(token),{points:100,earned:100,unlocked:[],equipped:null});
    fs.writeFileSync(file,'bad json');assert.throws(()=>new ProfileStore({file}));
    fs.writeFileSync(file,JSON.stringify({version:1,profiles:{x:{points:-2,earned:0,unlocked:[],equipped:null}},settled:{}}));assert.throws(()=>new ProfileStore({file}),/异常/);
  }finally{for(const name of ['profiles.json','block'])if(fs.existsSync(path.join(dir,name)))fs.unlinkSync(path.join(dir,name));fs.rmdirSync(dir);}
});

test('联机完整结算发积分且不重复：玩家解锁装备、观众只看、未解锁或局内换装被拒绝',async()=>{
  const {server,rooms,streams,profileStore}=require('../server');
  assert.equal(profileStore.file,null,'自动测试必须使用内存存档，不能写入主机的真实积分');
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const root=`http://127.0.0.1:${server.address().port}`,tokens=Array.from({length:3},()=>randomBytes(16).toString('hex'));let code;
  const call=async(action,i=0,data={})=>{const r=await fetch(root+'/api/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Player-Token':tokens[i]},body:JSON.stringify({room:code,...data})});return {status:r.status,body:await r.json()};};
  const poll=async i=>{const r=await fetch(root+'/api/state?room='+code,{headers:{'X-Player-Token':tokens[i]}});assert.equal(r.status,200);return r.json();};
  try{
    const absent=await fetch(root+'/api/profile');assert.equal(absent.status,400);
    const initial=await(await fetch(root+'/api/profile',{headers:{'X-Player-Token':tokens[0]}})).json();assert.equal(initial.profile.equipped,null);assert.equal(initial.profile.points,0);
    code=(await call('create')).body.code;await call('join',1);await call('watch',2);await call('settings',0,{rounds:6,augmentEvery:5});
    assert.ok((await poll(0)).players.every(p=>p.anchor===null));
    assert.equal((await call('anchor',0,{mode:'unlock',key:'dew',points:99999,unlocked:['dew']})).status,400);
    assert.equal((await call('anchor',2,{mode:'equip',key:null})).status,400);
    const play=async()=>{
      await poll(0);await poll(1);await call('ready',1);const started=await call('start');assert.equal(started.status,200);
      assert.equal((await call('anchor',0,{mode:'equip',key:null})).status,400);
      const room=rooms.get(code),g=room.game;
      while(!g.finished){
        if(g.draft){for(let i=0;i<2;i++){const id=room.players[i].id;assert.equal((await call('draft',i,{mode:'pick',key:g.draft.offers[id][0]})).status,200);}}
        else{const index=room.players.findIndex(p=>p.id===g.order[g.turn]);assert.equal((await call('action',index,{mode:'end'})).status,200);}
      }
      return poll(0);
    };
    let ended=await play();const expected=ended.game.scores[ended.you]+20+(ended.game.winner.includes(ended.you)?30:0);
    assert.equal(ended.game.rewardStatus,'paid');assert.equal(ended.game.rewards[ended.you],expected);assert.equal(ended.profile.points,expected);
    assert.equal((await poll(0)).profile.points,expected);assert.equal((await poll(0)).profile.points,expected);
    assert.equal((await poll(2)).profile.points,0);assert.ok(!Object.hasOwn(ended.players[1],'profile'));
    await call('reset');let earned=ended;
    for(let i=0;earned.profile.points<60&&i<2;i++){earned=await play();await call('reset');}
    assert.ok(earned.profile.points>=60);
    const before=earned.profile.points,unlocked=await call('anchor',0,{mode:'unlock',key:'dew'});assert.equal(unlocked.status,200);assert.equal(unlocked.body.profile.points,before-60);assert.equal(unlocked.body.players[0].anchor,'dew');
    assert.equal((await call('anchor',0,{mode:'unlock',key:'dew'})).body.profile.points,before-60);
    assert.equal((await call('anchor',1,{mode:'equip',key:'dew'})).status,400);assert.equal((await call('anchor',0,{mode:'equip',key:'cosmos'})).status,400);
    assert.equal((await poll(2)).players[0].anchor,'dew');assert.equal((await call('join',0)).body.players[0].anchor,'dew');
    assert.equal((await call('anchor',0,{mode:'equip',key:null})).body.players[0].anchor,null);
    assert.equal((await call('anchor',0,{mode:'equip',key:'dew'})).body.profile.points,before-60);
    await call('leave',0);const joined=await call('join',0);assert.equal(joined.body.players.at(-1).anchor,'dew');assert.equal(joined.body.profile.points,before-60);
    const disk=await fetch(root+'/data/profiles.json');assert.equal(disk.status,404);
    assert.equal((await call('anchor',0,{mode:'give-points',key:'cosmos',points:99999})).status,400);
  }finally{
    const room=rooms.get(code);if(room){for(const p of [...room.players,...room.spectators||[]]){clearTimeout(p.pollTimer);clearTimeout(p.transferTimer);}rooms.delete(code);}
    for(const set of streams.values())for(const res of set)res.end();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
});

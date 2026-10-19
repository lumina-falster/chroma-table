const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {randomBytes}=require('node:crypto');
const {isGm}=require('../gm');
const {ProfileStore}=require('../profile-store');
const nonce=()=>randomBytes(16).toString('hex');

test('GM 精确昵称白名单，无机器人、观众或其他隐藏管理员',()=>{
  for(const name of ['ww','ww.'])assert.equal(isGm({name,token:nonce()}),true);
  for(const name of ['WW','ww..','ww ','ww。','ｗｗ','admin','GM','Codex','锚点预览','普通玩家',''])assert.equal(isGm({name,token:nonce()}),false);
  assert.equal(isGm({name:'ww',token:nonce(),bot:true}),false);assert.equal(isGm({name:'ww.',token:nonce(),spectator:true}),false);assert.equal(isGm({name:'ww',token:null}),false);assert.equal(isGm(null),false);
});

test('GM 积分原子存档、兼容旧存档、重复操作与重启重放不重复发分',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chroma-gm-')),file=path.join(dir,'profiles.json');
  const actor=nonce(),target=nonce(),id=nonce();
  try{
    fs.writeFileSync(file,JSON.stringify({version:1,profiles:{},settled:{}}));let store=new ProfileStore({file});
    assert.equal(store.grantPoints(actor,target,1000,id).profile.points,1000);assert.equal(store.get(target).earned,0);
    assert.equal(store.grantPoints(actor,target,1000,id).duplicate,true);assert.equal(store.get(target).points,1000);
    store=new ProfileStore({file});assert.equal(store.grantPoints(actor,target,1000,id).duplicate,true);assert.equal(store.get(target).points,1000);
    assert.throws(()=>store.grantPoints(actor,target,1001,id),/已使用/);assert.throws(()=>store.grantPoints(actor,nonce(),1000,id),/已使用/);
    for(const amount of [-1,0,1.2,100001,'1000',NaN])assert.throws(()=>store.grantPoints(actor,target,amount,nonce()));
    assert.throws(()=>store.grantPoints(actor,target,1,'invalid'));
    const saved=fs.readFileSync(file,'utf8');assert.ok(!saved.includes(actor)&&!saved.includes(target));
    fs.writeFileSync(path.join(dir,'block'),'x');store.file=path.join(dir,'block','fail.json');assert.throws(()=>store.grantPoints(actor,target,20,nonce()));assert.equal(store.get(target).points,1000);
  }finally{for(const name of ['profiles.json','profiles.json.tmp','block'])if(fs.existsSync(path.join(dir,name)))fs.unlinkSync(path.join(dir,name));fs.rmdirSync(dir);}
});

test('普通玩家连快捷键都不拦截，伪造前端权限仍拿不到控制台 HTML',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
  const block=source.split('// BEGIN GM ACCESS')[1].split('// END GM ACCESS')[0];
  let requests=0,created=0,prevented=0;
  const context={state:{code:'123456',you:'me',players:[{id:'me',name:'normal'}],permissions:{gm:false}},token:nonce(),AbortController,setTimeout,clearTimeout,encodeURIComponent,document:{createElement(){created++;throw Error('不能创建 GM DOM');}},toast(){},fetch:async()=>{requests++;return {ok:false,json:async()=>({error:'无 GM 权限'})};}};
  vm.createContext(context);vm.runInContext(block,context);
  const event={ctrlKey:true,code:'F1',key:'F1',preventDefault(){prevented++;},stopPropagation(){}};
  context.handleGmShortcut(event);await context.toggleGmConsole();assert.equal(requests,0);assert.equal(prevented,0);assert.equal(created,0);
  context.state.permissions.gm=true;context.handleGmShortcut(event);assert.equal(prevented,0);assert.equal(requests,0);
  context.state.players[0].name='ww';await context.toggleGmConsole();assert.equal(requests,1);assert.equal(created,0);
  context.state.spectating=true;assert.equal(context.canUseGm(),false);
});

test('Ctrl+F1 唤醒与收起，旧快捷键和其他修饰键无效，权限未同步有提示',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
  const block=source.split('// BEGIN GM ACCESS')[1].split('// END GM ACCESS')[0];
  let toggles=0,prevented=0;const messages=[];
  const context={state:{code:'123456',you:'me',players:[{id:'me',name:'ww'}],permissions:{gm:true}},toast:m=>messages.push(m)};
  vm.createContext(context);vm.runInContext(block,context);context.toggleGmConsole=()=>{toggles++;};
  const press=overrides=>context.handleGmShortcut({ctrlKey:true,code:'F1',key:'F1',preventDefault(){prevented++;},stopPropagation(){},...overrides});
  press({code:'Digit1',key:'1'});press({ctrlKey:false});press({altKey:true});press({metaKey:true});press({shiftKey:true});assert.equal(toggles,0);assert.equal(prevented,0);
  press({});press({code:'',key:'F1'});assert.equal(toggles,2);assert.equal(prevented,2);
  press({repeat:true});assert.equal(toggles,2);
  context.state.permissions.gm=false;press({});assert.equal(toggles,2);assert.match(messages[0],/权限尚未同步/);
  context.state.players[0].name='ordinary';press({});assert.equal(messages.length,1);assert.equal(toggles,2);
});

test('真实 GM 接口：普通房主、观众、伪造昵称与跨房间调用全被拒绝，ww/ww. 可发积分和卡',async()=>{
  const {server,rooms,profileStore}=require('../server');assert.equal(profileStore.file,null);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const root=`http://127.0.0.1:${server.address().port}`,tokens=Array.from({length:4},nonce);let code,otherCode;
  const call=async(action,i=0,data={})=>{const r=await fetch(root+'/api/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Player-Token':tokens[i]},body:JSON.stringify({room:code,...data})});return {status:r.status,body:await r.json()};};
  const poll=async i=>{const r=await fetch(root+'/api/state?room='+code,{headers:{'X-Player-Token':tokens[i]}});return r.json();};
  const panel=async(i,room=code)=>{const r=await fetch(root+'/api/gm/console?room='+room,{headers:i===null?{}:{'X-Player-Token':tokens[i]}});return {status:r.status,body:await r.json()};};
  const gm=(i,mode,target,data={})=>call('gm',i,{mode,target,requestId:nonce(),...data});
  try{
    code=(await call('create',0,{name:'ordinary host'})).body.code;await call('join',1,{name:'ww'});await call('join',2,{name:'ww.'});await call('watch',3,{name:'ww'});
    const normal=await poll(0),admin=await poll(1),admin2=await poll(2),observer=await poll(3),target=normal.you;
    assert.equal(normal.permissions.gm,false);assert.equal(Object.hasOwn(normal,'gm'),false);assert.equal(admin.permissions.gm,true);assert.equal(admin2.permissions.gm,true);assert.equal(observer.permissions.gm,false);
    for(const i of [null,0,3]){const denied=await panel(i);assert.equal(denied.status,403);assert.equal(Object.hasOwn(denied.body,'html'),false);}
    assert.equal((await panel(1)).status,200);assert.ok((await panel(2)).body.html.includes('data-gm-form="points"'));
    for(const mode of ['points','card','augment']){
      for(const i of [0,3])assert.equal((await gm(i,mode,target,{name:'ww',actor:admin.you,permissions:{gm:true},amount:1000,key:'splash',count:1})).status,403);
    }
    await call('join',0,{name:'ww'});assert.equal((await poll(0)).players.find(p=>p.id===target).name,'ordinary hos');assert.equal((await panel(0)).status,403);
    const id=nonce(),grant=await gm(1,'points',target,{amount:1000,requestId:id});assert.equal(grant.status,200);assert.equal((await poll(0)).profile.points,1000);
    assert.equal((await gm(1,'points',target,{amount:1000,requestId:id})).body.gmResult.duplicate,true);assert.equal((await poll(0)).profile.points,1000);
    assert.equal((await gm(2,'points',target,{amount:25})).status,200);assert.equal((await poll(0)).profile.points,1025);
    assert.equal((await gm(1,'points',target,{amount:-1})).status,400);assert.equal((await gm(1,'points',target,{amount:1.1})).status,400);
    assert.equal((await gm(1,'card',target,{key:'splash',count:1})).status,400);
    otherCode=(await call('create',0,{name:'other'})).body.code;assert.equal((await panel(1,otherCode)).status,403);assert.equal((await call('gm',1,{room:otherCode,mode:'points',target,amount:10,requestId:nonce()})).status,403);
    for(let i=0;i<3;i++)await poll(i);await call('ready',1);await call('ready',2);await call('settings',0,{augmentEvery:2});assert.equal((await call('start')).status,200);
    const room=rooms.get(code),g=room.game,hand=g.hands[target],before=hand.length,cardId=nonce();
    const cards=await gm(1,'card',target,{key:'splash',count:8,requestId:cardId});assert.equal(cards.status,200);assert.equal(cards.body.gmResult.actual,4-before);assert.equal(hand.length,4);
    assert.equal(g.drawHistory[target].at(-1).reason,'gm');assert.equal((await gm(1,'card',target,{key:'splash',count:8,requestId:cardId})).body.gmResult.duplicate,true);assert.equal(hand.length,4);
    assert.equal((await gm(1,'card',target,{key:'splash',count:1})).status,400);
    assert.equal((await gm(1,'augment',target,{key:'long_leap'})).status,200);assert.equal((await gm(1,'augment',target,{key:'long_leap'})).status,400);assert.equal((await gm(1,'augment',target,{key:'basics'})).status,400);
    assert.equal((await gm(1,'augment',target,{key:'toString'})).status,400);assert.equal((await gm(1,'card',target,{key:'__proto__',count:1})).status,400);
    assert.equal((await poll(3)).game.augments[target].includes('long_leap'),true);assert.equal(Object.hasOwn(await poll(3),'gm'),false);
    while(!g.draft){const i=room.players.findIndex(p=>p.id===g.order[g.turn]);assert.equal((await call('action',i,{mode:'end'})).status,200);}
    assert.equal((await gm(1,'augment',target,{key:'ocean'})).status,400);
    assert.ok((await poll(1)).gm.audit.length>0);assert.equal((await poll(0)).profile.points,1025);
    for(const route of ['/gm.js','/gm-console','/gm.html','/gm-console.js'])assert.equal((await fetch(root+route)).status,404);
  }finally{
    for(const roomCode of [code,otherCode]){const room=rooms.get(roomCode);if(room){for(const p of [...room.players,...room.spectators||[]]){clearTimeout(p.pollTimer);clearTimeout(p.transferTimer);}rooms.delete(roomCode);}}
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
});

test('大量 GM 强化消耗候选后，正常轮次仍可继续而不崩溃',()=>{
  const {startGame,act,current}=require('../game'),{AUGMENTS}=require('../augments');
  const g=startGame([{id:'a'},{id:'b'}],6,2);g.augments.a=Object.keys(AUGMENTS);
  for(let i=0;i<4;i++)act(g,current(g),{mode:'end'});
  assert.equal(g.round,3);assert.equal(g.draft,null);assert.ok(g.ink>0);assert.ok(g.log.some(s=>s.includes('候选不足')));
});

const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {randomBytes,randomInt}=require('node:crypto');
const {COLORS,PALETTE,CARDS,startGame,current,scores,act,next,draftAction,rulesFor,cost,canSkill}=require('./game');
const {AUGMENTS,TIERS}=require('./augments');
const {chooseAction,chooseAugment}=require('./bot');
const {ANCHORS,REWARD_RULES}=require('./anchors');
const {ProfileStore}=require('./profile-store');
const {isGm,gmTargets,executeGm,panelHtml}=require('./gm');
// Tests use memory; normal hosts keep progress independently of room lifetime.
const profileFile=process.execArgv.includes('--test')?null:path.join(process.env.CHROMA_DATA_DIR||path.join(__dirname,'data'),'profiles.json');
const profileStore=new ProfileStore({file:profileFile});
const rooms=new Map(),streams=new Map();
const botTimers=new Map();
const TEST_ROOM_CODE='000001';
const {loadConfig,allowedOrigin}=require('./config');
const config=loadConfig();
const PORT=config.port;
const POLL_LEASE_MS=12000;
function fail(message){throw Error(message);}
function player(room,token){return room.players.find(p=>p.token===token)||fail('身份已失效，请重新加入');}
function member(room,token){return room.players.find(p=>p.token===token)||room.spectators?.find(p=>p.token===token)||fail('身份已失效，请重新加入');}
function spectatorCount(room){return (room.spectators||[]).filter(online).length;}
function deleteRoom(room){
  rooms.delete(room.code);clearTimeout(botTimers.get(room.code));botTimers.delete(room.code);
  for(const p of [...room.players,...room.spectators||[]])clearPresence(p);
  for(const p of room.spectators||[]){for(const stream of streams.get(p.token)||[])if(stream.roomCode===room.code)stream.write('event: room-closed\ndata: {}\n\n');disconnect(room,p.token);}
  room.spectators=[];
}
function online(p){return !!p.bot||(p.pollUntil||0)>Date.now()||[...streams.get(p.token)||[]].some(res=>res.roomCode===p.roomCode);}
function clearPresence(p){clearTimeout(p.pollTimer);clearTimeout(p.transferTimer);delete p.pollTimer;delete p.transferTimer;delete p.pollUntil;}
function scheduleTransfer(room,p){
  if(p.spectator)return;clearTimeout(p.transferTimer);const disconnectedAt=p.disconnectedAt;
  p.transferTimer=setTimeout(()=>{
    delete p.transferTimer;
    if(rooms.get(room.code)!==room||room.host!==p.id||online(p)||p.disconnectedAt!==disconnectedAt)return;
    const successor=room.players.find(q=>q.id!==p.id&&!q.bot&&online(q));
    if(successor){room.host=successor.id;broadcast(room);}
  },15500);p.transferTimer.unref();
}
function touchPoll(room,p){
  const wasOnline=online(p);p.roomCode=room.code;p.pollUntil=Date.now()+POLL_LEASE_MS;
  clearTimeout(p.pollTimer);clearTimeout(p.transferTimer);delete p.transferTimer;delete p.disconnectedAt;
  p.pollTimer=setTimeout(()=>{
    delete p.pollTimer;
    if(rooms.get(room.code)!==room||(!room.players.includes(p)&&!room.spectators?.includes(p))||online(p))return;
    p.disconnectedAt=p.pollUntil;scheduleTransfer(room,p);broadcast(room);
  },POLL_LEASE_MS+5);p.pollTimer.unref();
  room.updated=Date.now();if(!wasOnline)broadcast(room);else scheduleBot(room);
}
function disconnect(room,token){const set=streams.get(token);for(const res of set||[])if(res.roomCode===room.code){set.delete(res);res.end();}if(!set?.size)streams.delete(token);}
function settleGame(room){
  const g=room.game;if(!g?.finished||g.rewardStatus==='paid')return;
  g.matchId||=randomBytes(16).toString('hex');
  const totals=scores(g),rewards={},awards=[];
  for(const p of room.players){
    const token=p.token||p.rejoinToken;if(!token)continue;
    const points=Math.max(0,Math.floor(totals[p.id]||0))+REWARD_RULES.completion+(g.winner.includes(p.id)?REWARD_RULES.win:0);
    awards.push({token,points});rewards[p.id]=points;
  }
  try{profileStore.settle(g.matchId,awards);g.rewards=rewards;g.rewardStatus='paid';room.revision=(room.revision||0)+1;}
  catch(error){if(g.rewardStatus!=='pending')console.error('积分存档暂未完成：'+error.message);g.rewardStatus='pending';}
}
function view(room,token){
  const me=room.players.find(p=>p.token===token),g=room.game;
  return {
    code:room.code,host:room.host,test:!!room.test,phase:room.phase,revision:room.revision||0,
    rejoinAvailable:rooms.get(room.code)===room&&room.players.some(p=>p.departed&&p.rejoinToken===token),
    rounds:room.rounds,augmentEvery:room.augmentEvery??3,you:me?.id,
    spectating:!me&&!!room.spectators?.some(p=>p.token===token),spectatorCount:spectatorCount(room),
    players:room.players.map(({token,rejoinToken,originalName,roomCode,pollTimer,transferTimer,pollUntil,...p})=>({...p,online:online({...p,token,roomCode,pollUntil})})),
    game:g?{
      ...g,tierBag:undefined,rules:me?rulesFor(g,me.id):null,
      hand:me?g.hands[me.id]:[],
      handCounts:Object.fromEntries(Object.entries(g.hands).map(([k,v])=>[k,v.length])),
      skillInfo:Object.fromEntries(g.order.map(id=>[id,Object.fromEntries(Object.keys(CARDS).map(key=>[key,{cost:cost(g,key,0,id),enabled:canSkill(g,id,key)}]))])),
      draft:g.draft?{
        stage:g.draft.stage,tier:g.draft.tier,
        offers:g.draft.offers[me?.id]||[],rerolls:g.draft.rerolls[me?.id]||0,
        allOffers:g.draft.offers,allRerolls:g.draft.rerolls,picks:g.draft.picks
      }:null,
      scores:scores(g),active:current(g)
    }:null,
    cards:CARDS,augmentCards:AUGMENTS,tiers:TIERS,palette:PALETTE,
    anchors:ANCHORS,rewardRules:REWARD_RULES,profile:profileStore.get(token),permissions:{gm:isGm(me)},
    gm:isGm(me)?{targets:gmTargets(room,profileStore),audit:room.gmAudit||[]}:undefined
  };
}
function broadcast(room){if(rooms.get(room.code)!==room)return;settleGame(room);room.updated=Date.now();room.revision=(room.revision||0)+1;for(const p of [...room.players,...room.spectators||[]])for(const res of streams.get(p.token)||[])if(res.roomCode===room.code)res.write(`data: ${JSON.stringify(view(room,p.token))}\n\n`);scheduleBot(room);}
function scheduleBot(room){
  if(botTimers.has(room.code)||room.phase!=='playing'||!room.players.some(p=>!p.bot&&online(p)))return;
  const bot=room.players.find(p=>p.bot&&(room.game.draft?!room.game.draft.picks[p.id]:p.id===current(room.game)));if(!bot)return;
  const game=room.game;
  const timer=setTimeout(()=>{
    botTimers.delete(room.code);
    if(rooms.get(room.code)!==room||room.game!==game||room.phase!=='playing'||!bot.bot||!room.players.some(p=>!p.bot&&online(p)))return;
    if(game.draft?game.draft.picks[bot.id]:current(game)!==bot.id)return;
    const message=game.draft?draftAction(game,bot.id,{mode:'pick',key:chooseAugment(game,bot.id)}):act(game,bot.id,chooseAction(game,bot.id)||{mode:'end'});
    game.log.unshift(`${bot.name} ${message}`);game.log=game.log.slice(0,20);
    if(game.finished)room.phase='finished';
    broadcast(room);
  },450);timer.unref();botTimers.set(room.code,timer);
}
function newPlayer(name,token,index){return {id:randomBytes(6).toString('hex'),token,name:String(name||'玩家').trim().slice(0,12)||'玩家',color:COLORS[index],colorChoice:null,anchor:token?profileStore.get(token).equipped:null,ready:false,joined:Date.now()};}
function resetTestRoom(room){
  clearTimeout(botTimers.get(room.code));botTimers.delete(room.code);
  room.players.filter(p=>!p.bot||p.departed).forEach(clearPresence);
  room.players=room.players.filter(p=>p.bot&&!p.departed);room.host=null;room.phase='lobby';room.game=null;
  room.players.forEach(p=>p.ready=true);
}
const testBot={...newPlayer('测试机器人',null,1),bot:true,ready:true};
rooms.set(TEST_ROOM_CODE,{code:TEST_ROOM_CODE,test:true,host:null,players:[testBot],phase:'lobby',rounds:10,game:null,updated:Date.now()});
async function body(req){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>8192)throw Error('请求过大');}try{return JSON.parse(raw||'{}');}catch{throw Error('请求格式错误');}}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  try{
    if(req.method==='GET'&&url.pathname==='/api/gm/console'){
      const room=rooms.get(url.searchParams.get('room')),token=req.headers['x-player-token'];
      const actor=room?.players.find(p=>p.token===token);
      if(!isGm(actor)){res.writeHead(403,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:'无 GM 权限'}));return;}
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({html:panelHtml()}));return;
    }
    if(req.method==='GET'&&url.pathname==='/api/profile'){
      const token=req.headers['x-player-token'];
      const profile=profileStore.get(token);
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({profile,anchors:ANCHORS,rewardRules:REWARD_RULES}));return;
    }
    if(req.method==='GET'&&url.pathname==='/api/state'){
      const room=rooms.get(url.searchParams.get('room'));
      if(!room){res.writeHead(404,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:'房间已关闭或不存在'}));return;}
      const token=req.headers['x-player-token'];
      const p=/^[a-f0-9]{32}$/.test(token||'')&&(room.players.find(q=>q.token===token)||room.spectators?.find(q=>q.token===token));
      if(!p){res.writeHead(401,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:'身份已失效，请重新加入'}));return;}
      settleGame(room);touchPoll(room,p);
      const since=url.searchParams.get('since');
      if(since!==null&&/^\d+$/.test(since)&&Number(since)===(room.revision||0)){res.writeHead(204,{'Cache-Control':'no-store, no-transform'});res.end();return;}
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store, no-transform'});res.end(JSON.stringify(view(room,token)));return;
    }
    if(req.method==='GET'&&url.pathname==='/api/events'){
      const room=rooms.get(url.searchParams.get('room'));if(!room)fail('房间不存在');
      const token=url.searchParams.get('token');if(!/^[a-f0-9]{32}$/.test(token||''))fail('无效身份');const p=member(room,token);
      res.roomCode=room.code;p.roomCode=room.code;
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
      if(!streams.has(token))streams.set(token,new Set());streams.get(token).add(res);delete p.disconnectedAt;clearTimeout(p.transferTimer);delete p.transferTimer;
      res.write('retry: 1500\n\n');broadcast(room);
      req.on('close',()=>{
        const set=streams.get(token);set?.delete(res);
        if(!set?.size)streams.delete(token);
        if(!online(p)){
          p.disconnectedAt=Date.now();
          scheduleTransfer(room,p);
        }
        broadcast(room);
      });return;
    }
    if(req.method==='POST'&&url.pathname.startsWith('/api/')){
      if(!allowedOrigin(req.headers.origin,req.headers.host,config.publicUrl))fail('请求来源不匹配');
      const b=await body(req);const token=req.headers['x-player-token'];if(!/^[a-f0-9]{32}$/.test(token||''))fail('无效身份');
      let room,gmResult;
      if(url.pathname==='/api/gm'){
        room=rooms.get(String(b.room||''));const actor=room?.players.find(p=>p.token===token);
        if(!isGm(actor)){res.writeHead(403,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:'无 GM 权限'}));return;}
        gmResult=executeGm(room,actor,b,profileStore);
      }else if(url.pathname==='/api/create'){
        if(rooms.size>=150)fail('房间数量已满');let code;do{code=String(randomInt(100000,1000000));}while(rooms.has(code));
        const p=newPlayer(b.name,token,0);room={code,host:p.id,players:[p],phase:'lobby',rounds:10,game:null,updated:Date.now()};rooms.set(code,room);
      }else{
        room=rooms.get(url.pathname==='/api/test'?TEST_ROOM_CODE:String(b.room||''));if(!room)fail('房间不存在，请检查房间号');
        if(url.pathname==='/api/watch'){
          if(room.players.some(p=>p.token===token))fail('你已是此房间的玩家，无需重复观战');
          room.spectators=(room.spectators||[]).filter(p=>online(p)||Date.now()-(p.disconnectedAt||p.joined)<60000);
          if(!room.spectators.some(p=>p.token===token)){
            if(room.spectators.length>=64)fail('观战人数已满');
            room.spectators.push({id:randomBytes(6).toString('hex'),token,name:String(b.name||'观众').trim().slice(0,12)||'观众',spectator:true,joined:Date.now()});
          }
        }else if(url.pathname==='/api/leave'&&room.spectators?.some(p=>p.token===token)&&!room.players.some(p=>p.token===token)){
          clearPresence(room.spectators.find(p=>p.token===token));
          room.spectators=room.spectators.filter(p=>p.token!==token);
          disconnect(room,token);
        }else if(url.pathname==='/api/join'||url.pathname==='/api/test'){
          const returning=room.players.find(p=>p.departed&&p.rejoinToken===token);
          if(returning){
            clearTimeout(botTimers.get(room.code));botTimers.delete(room.code);
            returning.token=token;returning.name=returning.originalName;returning.bot=false;
            delete returning.departed;delete returning.rejoinToken;delete returning.originalName;delete returning.disconnectedAt;
            room.game?.log.unshift(`${returning.name} 返回房间，接回原来的席位`);
            if(room.game)room.game.log=room.game.log.slice(0,20);
          }
          // An abandoned test match can be reused without restarting the server.
          if(room.test&&!room.players.some(p=>!p.bot&&online(p))&&!room.players.some(p=>p.token===token)&&room.players.filter(p=>!p.bot).every(p=>Date.now()-(p.disconnectedAt||p.joined)>=15000))resetTestRoom(room);
          if(!room.players.some(p=>p.token===token)){
            if(room.phase!=='lobby')fail('游戏已经开始');if(room.players.length>=8)fail('房间已满');
            const used=new Set(room.players.map(p=>p.color));const idx=COLORS.findIndex(c=>!used.has(c));room.players.push(newPlayer(b.name,token,idx));
          }
          if(!room.host)room.host=player(room,token).id;
          room.spectators=room.spectators?.filter(p=>p.token!==token)||[];
        }else{
          const p=player(room,token);
          switch(url.pathname){
            case '/api/anchor':{
              if(room.phase!=='lobby')fail('只能在大厅解锁或更换锚点');
              let profile;
              if(b.mode==='unlock')profile=profileStore.unlock(token,b.key);
              else if(b.mode==='equip')profile=profileStore.equip(token,b.key);
              else fail('无效锚点操作');
              p.anchor=profile.equipped;break;
            }
            case '/api/color':{
              if(room.phase!=='lobby')fail('只能在大厅选择颜色');
              if(b.color!==null&&!PALETTE.some(c=>c.color===b.color))fail('请选择色盘中的有效颜色');
              const used=new Set(room.players.filter(q=>q.id!==p.id).map(q=>q.color));
              const chosen=b.color===null?COLORS.find(c=>!used.has(c)):b.color;
              if(!chosen||used.has(chosen))fail('这个颜色已被其他玩家使用，请换一个');
              p.color=chosen;p.colorChoice=b.color;break;
            }
            case '/api/ready':if(room.phase!=='lobby')fail('游戏已经开始');p.ready=!p.ready;break;
            case '/api/settings':
              if(p.id!==room.host||room.phase!=='lobby')fail('仅房主可设置');
              if(b.rounds!==undefined){if(![6,10,15].includes(b.rounds))fail('无效轮数');room.rounds=b.rounds;}
              if(b.augmentEvery!==undefined){if(![2,3,5].includes(b.augmentEvery))fail('强化间隔仅支持 2、3、5 轮');room.augmentEvery=b.augmentEvery;}break;
            case '/api/start':
              if(p.id!==room.host||room.phase!=='lobby')fail('仅房主可开局');if(room.players.length<2)fail('至少需要 2 位玩家');
              if(room.players.some(q=>q.id!==room.host&&(!q.ready||!online(q))))fail('请等待其他玩家上线并准备');
              room.game=startGame(room.players,room.rounds,room.augmentEvery??3);room.game.matchId=randomBytes(16).toString('hex');room.phase='playing';break;
            case '/api/draft':{
              if(room.phase!=='playing')fail('当前不在游戏中');
              const message=draftAction(room.game,p.id,b);room.game.log.unshift(`${p.name} ${message}`);room.game.log=room.game.log.slice(0,20);break;}
            case '/api/action':{
              if(room.phase!=='playing')fail('当前不在游戏中');const message=act(room.game,p.id,b);room.game.log.unshift(`${p.name} ${message}`);room.game.log=room.game.log.slice(0,20);if(room.game.finished)room.phase='finished';break;}
            case '/api/skip':{
              if(p.id!==room.host||room.phase!=='playing')fail('仅房主可跳过离线回合');
              if(room.game.draft){
                const q=room.players.find(q=>!q.bot&&!room.game.draft.picks[q.id]&&!online(q)&&q.disconnectedAt&&Date.now()-q.disconnectedAt>=15000);
                if(!q)fail('暂无离线满 15 秒且未选牌的玩家');
                draftAction(room.game,q.id,{mode:'pick',key:room.game.draft.offers[q.id][0]});room.game.log.unshift(`${q.name} 离线，由房主自动代选强化`);break;
              }
              const q=room.players.find(q=>q.id===current(room.game));
              if(online(q)||!q.disconnectedAt||Date.now()-q.disconnectedAt<15000)fail('玩家离线满 15 秒后可跳过');next(room.game);room.game.log.unshift(`${q.name} 离线，房主跳过了回合`);if(room.game.finished)room.phase='finished';break;}
            case '/api/reset':
              if(p.id!==room.host||room.phase!=='finished')fail('仅房主可在结算后返回大厅');
              settleGame(room);if(room.game.rewardStatus!=='paid')fail('积分存档暂不可用，请稍后再试');
              room.phase='lobby';room.game=null;room.players=room.players.filter(q=>!q.departed);room.players.forEach(q=>{q.ready=!!q.bot;q.anchor=q.token?profileStore.get(q.token).equipped:null;});break;
            case '/api/leave':{
              clearPresence(p);
              // Keep game IDs intact for territory, turn order, drafts and results.
              if(room.game){
                room.game.log.unshift(`${p.name} 退出房间，由机器人接管`);room.game.log=room.game.log.slice(0,20);
                p.rejoinToken=token;p.originalName=p.name;
                p.bot=true;p.departed=true;p.ready=true;p.name+='（托管）';p.token=null;
              }else room.players=room.players.filter(q=>q.id!==p.id);
              if(room.host===p.id)room.host=(room.players.find(q=>!q.bot&&online(q))||room.players.find(q=>!q.bot))?.id||null;
              if(!room.players.some(q=>!q.bot)){
                clearTimeout(botTimers.get(room.code));botTimers.delete(room.code);
                if(room.test)resetTestRoom(room);else deleteRoom(room);
              }
              disconnect(room,token);
              break;
            }
            default:fail('接口不存在');
          }
        }
      }
      broadcast(room);res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({...view(room,token),...(gmResult?{gmResult}:{})}));return;
    }
    if(req.method==='GET'&&url.pathname==='/api/rooms'){
      const list=[...rooms.values()].map(room=>({code:room.code,test:!!room.test,hostName:room.players.find(p=>p.id===room.host)?.name||'等待房主',players:room.players.length,maxPlayers:8,spectators:spectatorCount(room),phase:room.phase,round:room.game?.round||0,maxRounds:room.game?.maxRounds||room.rounds,canJoin:room.phase==='lobby'&&room.players.length<8}));
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({rooms:list}));return;
    }
    if(req.method==='GET'&&url.pathname==='/api/catalog'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({cards:AUGMENTS,tiers:TIERS}));return;}
    if(req.method==='GET'&&url.pathname==='/api/network'){
      const port=server.address()?.port||PORT;
      const addresses=config.host==='127.0.0.1'||config.host==='::1'?[]:Object.values(os.networkInterfaces()).flat().filter(n=>n.family==='IPv4'&&!n.internal&&(config.host==='0.0.0.0'||config.host==='::'||config.host===n.address)).map(n=>`http://${n.address}:${port}`);
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({addresses,publicUrl:config.publicUrl}));return;
    }
    const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};const file=files[url.pathname];
    if(req.method!=='GET'||!file){res.writeHead(404);res.end('Not found');return;}
    res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});fs.createReadStream(path.join(__dirname,'public',file)).pipe(res);
  }catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}
});
const heartbeat=setInterval(()=>{for(const set of streams.values())for(const res of set)res.write('event: ping\ndata: {}\n\n');for(const r of rooms.values())if(!r.players.some(online)&&Date.now()-r.updated>12*60*60*1000)deleteRoom(r);},5000);heartbeat.unref();
if(require.main===module){
  server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`端口 ${PORT} 已被占用，请关闭旧服务或修改配置中的 port。`:`服务器启动失败：${error.message}`);process.exitCode=1;});
  server.listen(PORT,config.host,()=>{
    console.log(`\n染域已启动，监听 ${config.host}:${PORT}`);
    console.log(`本机访问：http://${['0.0.0.0','::'].includes(config.host)?'localhost':config.host.includes(':')?'['+config.host+']':config.host}:${PORT}`);
    for(const list of Object.values(os.networkInterfaces()))for(const n of list||[])if(n.family==='IPv4'&&!n.internal&&(config.host==='0.0.0.0'||config.host==='::'||config.host===n.address))console.log(`局域网地址：http://${n.address}:${PORT}`);
    if(config.publicUrl)console.log(`配置的分享地址：${config.publicUrl}（需另行配置穿透或代理）`);
    console.log('朋友打开同一个服务器地址，再加入同一个房间。关闭此窗口将停止服务。\n');
  });
}
module.exports={server,rooms,streams,botTimers,profileStore};

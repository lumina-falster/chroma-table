const {test}=require('node:test');
const assert=require('node:assert/strict');
const {AUGMENTS}=require('../augments');
const {startGame,act,cost,scores,current,draftAction,rulesFor}=require('../game');
function board(keys=[]){
  const g=startGame([{id:'a'},{id:'b'}],15,2);g.order=['a','b'];g.turn=0;
  g.board.forEach(c=>{c.owner=null;c.home=false;c.shield=false;c.terrain='plain';});
  g.board[60].owner='a';g.board[61].owner='b';g.augments.a=keys;
  g.hands.a=['splash','splash','leap','leap','pierce'];return g;
}
function startTurn(g){g.order=['b','a'];g.turn=0;act(g,'b',{mode:'end'});}
test('三阶各 12 张、名称唯一，随机同阶首轮不是固定白银',()=>{
  for(const tier of ['silver','gold','prismatic'])assert.equal(Object.values(AUGMENTS).filter(c=>c.tier===tier).length,12);
  assert.equal(new Set(Object.values(AUGMENTS).map(c=>c.name)).size,36);
  // Seed the private bag to exercise every possible first tier without probabilistic assertions.
  for(const tier of ['silver','gold','prismatic']){
    const g=board();g.tierBag=[tier];for(let i=0;i<4;i++)act(g,current(g),{mode:'end'});
    assert.equal(g.draft.tier,tier);for(const id of g.order){assert.equal(g.draft.offers[id].length,3);assert.ok(g.draft.offers[id].every(k=>AUGMENTS[k].tier===tier));draftAction(g,id,{mode:'reroll'});assert.ok(g.draft.offers[id].every(k=>AUGMENTS[k].tier===tier));}
  }
});
test('8 人长局每次选牌及重抽均同阶，排除重复及互斥牌',()=>{
  const g=startGame(Array.from({length:8},(_,i)=>({id:'p'+i})),15,2);let stages=0;
  while(!g.finished){
    if(!g.draft){act(g,current(g),{mode:'end'});continue;}
    const tier=g.draft.tier;
    for(const id of g.order){
      assert.equal(g.draft.offers[id].length,3);assert.ok(g.draft.offers[id].every(k=>AUGMENTS[k].tier===tier));
      draftAction(g,id,{mode:'reroll'});assert.ok(g.draft.offers[id].every(k=>AUGMENTS[k].tier===tier));
      draftAction(g,id,{mode:'pick',key:g.draft.offers[id][0]});
    }
    stages++;
  }
  assert.equal(stages,7);
});
test('家园卫士与瞄准镜拓展普通染色，技能范围不被误加长',()=>{
  const g=board(['homeguard']);g.board[60].home=true;act(g,'a',{mode:'paint',index:38});assert.equal(g.board[38].owner,'a');
  const h=board(['scoped']);act(h,'a',{mode:'paint',index:38});assert.throws(()=>act(h,'a',{mode:'pierce',index:61+2}),/相邻/);
  assert.equal(rulesFor(h,'a').paintReach[16],true);
});
test('灵巧及急救用具允许 0 墨行动且每回合仅触发一次',()=>{
  const g=board(['deft','first_aid']);g.ink=0;g.board[49].terrain='well';act(g,'a',{mode:'paint',index:49});assert.equal(g.ink,0);assert.equal(cost(g,'paint',38),1);
  act(g,'a',{mode:'shield',index:49});assert.equal(g.ink,0);assert.equal(cost(g,'shield',49),1);
});
test('山脉龙魂额外护盾、侵蚀削盾但不伤害出生点',()=>{
  const g=board(['mountain']);g.board[49].owner='a';g.board[49].terrain='well';act(g,'a',{mode:'shield',index:60});assert.equal(g.board[49].shield,true);
  const h=board(['erosion']);h.board[61].shield=true;h.board[50].owner='b';h.board[50].home=true;h.board[50].shield=true;act(h,'a',{mode:'paint',index:49});assert.equal(h.board[50].shield,true);
  h.board[50].home=false;h.ink=3;act(h,'a',{mode:'paint',index:50});assert.equal(h.board[61].shield,false);
});
test('海洋龙魂、由心及物与歌利亚的资源和积分效果',()=>{
  const g=board(['ocean']);g.board[49].terrain='well';act(g,'a',{mode:'paint',index:49});assert.equal(g.ink,3);g.board[38].terrain='well';act(g,'a',{mode:'paint',index:38});assert.equal(g.ink,2);
  const h=board(['mind','goliath']);h.ink=3;act(h,'a',{mode:'end'});assert.equal(h.progress.a.bonusScore,2);assert.equal(scores(h).a,4);
});
test('面包系列各自保留首次手牌，第二次消耗；魔法飞弹追加染色',()=>{
  const g=board(['bread_butter']);g.ink=10;act(g,'a',{mode:'splash',index:49});assert.equal(g.hands.a.length,5);act(g,'a',{mode:'splash',index:27});assert.equal(g.hands.a.length,4);
  const h=board(['bread_cheese','missiles']);h.ink=10;act(h,'a',{mode:'leap',index:27});assert.equal(h.hands.a.length,5);assert.equal(h.board.filter(c=>c.owner==='a').length,3);act(h,'a',{mode:'leap',index:5});assert.equal(h.hands.a.length,4);
});
test('大脑、尤里卡、超凡邪恶提升手牌和回合墨水，成长有上限',()=>{
  const g=board(['big_brain','eureka','evil']);g.progress.a.skills=99;startTurn(g);assert.equal(g.hands.a.length,6);assert.equal(g.ink,9);assert.equal(rulesFor(g,'a').handLimit,8);
  const h=board(['evil']);act(h,'a',{mode:'pierce',index:61});assert.equal(h.progress.a.skills,1);
});
test('刽子手、玻璃大炮与暴击律动改变抢色和持续作战',()=>{
  const g=board(['executioner']);g.board[61].shield=true;act(g,'a',{mode:'paint',index:61});assert.equal(g.ink,2);
  const h=board(['glass']);h.board[61].shield=true;assert.equal(cost(h,'paint',61),2);assert.throws(()=>act(h,'a',{mode:'shield',index:60}),/禁止/);
  const r=board(['rhythm']);act(r,'a',{mode:'paint',index:49});act(r,'a',{mode:'paint',index:38});act(r,'a',{mode:'paint',index:27});assert.equal(r.ink,1);
});
test('双刀流追加空地、量子计算在回合结束扩散、全能龙魂组合效果',()=>{
  const g=board(['dual']);startTurn(g);assert.equal(g.ink,2);act(g,'a',{mode:'paint',index:49});assert.equal(g.board.filter(c=>c.owner==='a').length,3);
  const h=board(['quantum','omni']);h.board[60].terrain='well';act(h,'a',{mode:'end'});assert.equal(h.board.filter(c=>c.owner==='a').length,4);assert.equal(scores(h).a,8);
  const k=board(['omni']);k.board[49].terrain='well';startTurn(k);assert.equal(k.ink,4);act(k,'a',{mode:'paint',index:49});assert.equal(k.board[49].shield,true);
});
test('炼狱导管每回合仅一次，终极刷新补牌和返墨，珠光暴击遵守目标限制',()=>{
  const g=board(['infernal']);g.ink=10;g.board[50].owner='b';g.board[39].owner='b';act(g,'a',{mode:'leap',index:49});assert.equal(g.board[50].owner,'a');act(g,'a',{mode:'leap',index:38});assert.equal(g.board[39].owner,'b');
  const h=board(['revolution']);h.hands.a=[];startTurn(h);assert.equal(h.hands.a[0],'splash');act(h,'a',{mode:'splash',index:49});assert.equal(h.ink,1);
  const j=board(['jeweled']);j.board[16].owner='b';j.board[16].home=true;j.board[26].terrain='rock';act(j,'a',{mode:'leap',index:27});assert.equal(j.board[16].owner,'b');assert.equal(j.board[26].owner,null);assert.ok([2,4].includes(j.board.filter(c=>c.owner==='a').length));
});

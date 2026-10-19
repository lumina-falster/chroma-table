const {test}=require('node:test');
const assert=require('node:assert/strict');
const {AUGMENTS}=require('../augments');
const {startGame,current,act,scores,cost,draftAction,eligibleAugments}=require('../game');
function fresh(rounds=10,every=3){return startGame([{id:'a'},{id:'b'}],rounds,every);}
function finishRound(g){for(let i=0;i<g.order.length;i++)act(g,current(g),{mode:'end'});}
function pickAll(g){for(const id of g.order)draftAction(g,id,{mode:'pick',key:g.draft.offers[id][0]});}
function board(){const g=fresh();g.order=['a','b'];g.turn=0;g.board.forEach(c=>{c.owner=null;c.terrain='plain';c.shield=false;c.home=false;});g.board[60].owner='a';g.board[61].owner='b';g.hands.a=['splash','pierce','leap'];return g;}
test('完整 X 轮后才进入选牌、全员选完才继续，最后一轮直接结算',()=>{
  const g=fresh(6,3);finishRound(g);finishRound(g);assert.equal(g.draft,null);finishRound(g);
  assert.equal(g.round,4);assert.ok(['silver','gold','prismatic'].includes(g.draft.tier));assert.equal(g.ink,0);
  assert.throws(()=>act(g,current(g),{mode:'end'}),/选牌/);
  const a=g.order[0],b=g.order[1];draftAction(g,a,{mode:'pick',key:g.draft.offers[a][0]});
  assert.ok(g.draft);assert.throws(()=>draftAction(g,a,{mode:'pick',key:g.draft.offers[a][1]}),/已经/);
  draftAction(g,b,{mode:'pick',key:g.draft.offers[b][0]});assert.equal(g.draft,null);assert.ok(g.ink>=1);
  finishRound(g);finishRound(g);finishRound(g);assert.equal(g.finished,true);assert.equal(g.draft,null);
});
test('重抽次数、伪造选牌防护与随机同阶刷新',()=>{
  const g=fresh(10,2);finishRound(g);finishRound(g);
  const tiers=[g.draft.tier];const first=[...g.draft.offers.a];assert.equal(first.length,3);assert.equal(new Set(first).size,3);
  assert.throws(()=>draftAction(g,'a',{mode:'pick',key:'not-a-card'}),/提供/);
  draftAction(g,'a',{mode:'reroll'});assert.notDeepEqual([...g.draft.offers.a].sort(),first.sort());
  assert.throws(()=>draftAction(g,'a',{mode:'reroll'}),/用完/);pickAll(g);
  finishRound(g);finishRound(g);tiers.push(g.draft.tier);pickAll(g);
  finishRound(g);finishRound(g);tiers.push(g.draft.tier);
  assert.equal(new Set(tiers).size,3);
  for(const key of g.draft.offers.a)assert.equal(AUGMENTS[key].tier,g.draft.tier);
});
test('长局不会抽到重复或冲突强化，始终保持全场同阶且不混阶',()=>{
  const g=fresh(15,2);let count=0;
  while(!g.finished){if(g.draft){for(const id of g.order){const eligible=eligibleAugments(g,id);assert.equal(g.draft.offers[id].length,3);assert.ok(g.draft.offers[id].every(k=>AUGMENTS[k].tier===g.draft.tier));assert.ok(g.draft.offers[id].every(k=>eligible.includes(k)));}pickAll(g);count++;}else act(g,current(g),{mode:'end'});}
  assert.equal(count,7);for(const id of g.order)assert.equal(new Set(g.augments[id]).size,7);
});
test('回归基本功 1 墨染两格，第二格校验原子化，禁用技能但保护出生点',()=>{
  const g=board();g.augments.a=['basics'];g.board[62].shield=true;g.board[62].owner='b';
  act(g,'a',{mode:'paint',index:61,second:62});assert.equal(g.ink,2);assert.equal(g.board[62].owner,'a');
  assert.throws(()=>act(g,'a',{mode:'leap',index:49}),/禁止/);
  const before=structuredClone(g);assert.throws(()=>act(g,'a',{mode:'paint',index:49,second:0}),/第二格/);assert.deepEqual(g,before);
  g.board[49].home=true;assert.throws(()=>act(g,'a',{mode:'paint',index:49}),/出生/);
});
test('亮出你的剑：普通抢色 1 墨无视敌方双重加固，禁用飞染但保留泼墨',()=>{
  const g=board();g.augments.a=['sword'];g.augments.b=['fortress'];g.board[61].shield=true;
  assert.equal(cost(g,'paint',61),1);act(g,'a',{mode:'paint',index:61});assert.equal(g.ink,2);
  assert.throws(()=>act(g,'a',{mode:'leap',index:49}),/禁止/);g.ink=3;act(g,'a',{mode:'splash',index:49});assert.equal(g.ink,0);
});
test('墨水、抽牌、费用、领地和加固强化正确叠加',()=>{
  const g=board();g.augments.a=['ink_reserve','endless_ink','scholar','empire','plated','siphon','well_master','spellcraft'];
  g.order=['b','a'];g.turn=0;g.board.slice(0,16).forEach(c=>c.owner='a');act(g,'b',{mode:'end'});
  assert.equal(g.ink,8);assert.equal(g.hands.a.length,5);assert.equal(cost(g,'splash',49),2);
  act(g,'a',{mode:'paint',index:61});assert.equal(g.ink,7);assert.equal(g.board[61].shield,true);
  g.board[62].owner='b';act(g,'a',{mode:'paint',index:62});assert.equal(g.ink,5);
  g.board[61].terrain='well';assert.equal(scores(g).a,24);
});
test('防御强化仍可被破色克制，互斥牌不会进入候选',()=>{
  const g=board();g.augments.b=['fortress'];g.board[61].shield=true;assert.equal(cost(g,'paint',61),4);act(g,'a',{mode:'pierce',index:61});assert.equal(g.ink,2);
  g.augments.a=['basics'];assert.ok(!eligibleAugments(g,'a').includes('spellcraft'));assert.ok(!eligibleAugments(g,'a').includes('long_leap'));
  g.augments.a=['long_leap'];assert.ok(!eligibleAugments(g,'a').includes('sword'));assert.ok(!eligibleAugments(g,'a').includes('basics'));
});

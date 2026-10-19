const {test}=require('node:test');
const assert=require('node:assert/strict');
const {startGame,act,current,draftAction}=require('../game');
function game(){const g=startGame([{id:'a'},{id:'b'}],10,2);g.order=['a','b'];g.turn=0;return g;}
test('技能刷新记录与当前手牌独立保存，使用卡牌不会抹掉历史',()=>{
  const g=game(),initial=structuredClone(g.drawHistory.a[0]);
  g.board.forEach(c=>{c.owner=null;c.home=false;c.shield=false;c.terrain='plain';});g.board[60].owner='a';g.board[61].owner='b';
  const mode=g.hands.a[0];act(g,'a',{mode,index:mode==='pierce'?61:49});
  assert.equal(g.hands.a.length,1);assert.deepEqual(g.drawHistory.a[0],initial);
  act(g,'a',{mode:'end'});act(g,'b',{mode:'end'});
  assert.equal(g.drawHistory.a.length,2);assert.equal(g.drawHistory.b.length,2);
  assert.equal(g.drawHistory.a[1].round,2);assert.equal(g.drawHistory.a[1].turn,1);assert.equal(g.drawHistory.a[1].cards.length,1);
  assert.deepEqual(g.drawHistory.a[0],initial);
});
test('强化历史完整保留首次候选、重抽与两名玩家最终选择',()=>{
  const g=game();for(let i=0;i<4;i++)act(g,current(g),{mode:'end'});
  const initial=structuredClone(g.draft.offers);const history=g.draftHistory[0];
  draftAction(g,'a',{mode:'reroll'});const second=[...g.draft.offers.a];
  assert.deepEqual(history.offers,initial);assert.deepEqual(history.rerolls.a,[second]);assert.notDeepEqual(second.sort(),[...initial.a].sort());
  const chosen=g.draft.offers.a[0];draftAction(g,'a',{mode:'pick',key:chosen});assert.equal(history.picks.a,chosen);
  const botChoice=g.draft.offers.b[0];draftAction(g,'b',{mode:'pick',key:botChoice});
  assert.equal(g.draft,null);assert.deepEqual(history.picks,{a:chosen,b:botChoice});assert.equal(history.afterRound,2);
  assert.deepEqual(history.offers,initial);assert.equal(history.rerolls.a[0].includes(chosen),true);
});

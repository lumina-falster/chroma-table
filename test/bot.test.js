const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chooseAction } = require('../bot');
const { startGame, current, act, scores, draftAction } = require('../game');

test('机器人沿用规则、不会修改评估前的棋盘，且能完成整局', () => {
  const game = startGame([{ id: 'human' }, { id: 'bot' }], 6);
  let steps = 0;
  while (!game.finished && steps++ < 100) {
    if(game.draft){for(const id of game.order)draftAction(game,id,{mode:'pick',key:game.draft.offers[id][0]});continue;}
    const id = current(game);
    const before = structuredClone(game);
    const action = id === 'bot' ? chooseAction(game, id) : { mode: 'end' };
    assert.deepEqual(game, before);
    act(game, id, action);
    assert.ok(game.ink >= 0);
  }
  assert.ok(game.finished);
  assert.ok(scores(game).bot > 1);
  assert.equal(chooseAction(game, 'bot'), null);
});

test('机器人无合法行动时主动结束回合，能使用破色争夺染井', () => {
  const g = startGame([{ id: 'bot' }, { id: 'human' }]);
  g.order = ['bot', 'human']; g.turn = 0;
  g.board.forEach(c => { c.owner = null; c.home = false; c.shield = false; c.terrain = 'rock'; });
  g.board[60] = { owner: 'bot', home: true, shield: true, terrain: 'plain' };
  assert.deepEqual(chooseAction(g, 'bot'), { mode: 'end' });
  g.board[61] = { owner: 'human', home: false, shield: true, terrain: 'well' };
  g.hands.bot = ['pierce'];
  const move = chooseAction(g, 'bot');
  assert.deepEqual(move, { mode: 'pierce', index: 61 });
  act(g, 'bot', move); assert.equal(g.board[61].owner, 'bot');
});

test('机器人 0 墨仍可使用灵巧赠送的免费染色，然后结束回合',()=>{
  const g=startGame([{id:'bot'},{id:'human'}]);g.order=['bot','human'];g.turn=0;g.ink=0;g.augments.bot=['deft'];
  const move=chooseAction(g,'bot');assert.equal(move.mode,'paint');act(g,'bot',move);assert.equal(g.ink,0);assert.equal(chooseAction(g,'bot').mode,'end');
});

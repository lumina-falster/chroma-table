const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {startGame,act}=require('../game');
// Exercise the same pure lesson model shipped inside the dependency-free client.
const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
const model=source.split('// BEGIN TUTORIAL MODEL')[1].split('// END TUTORIAL MODEL')[0];
const {createTutorial,tutorialMove,tutorialScore,TUTORIAL_STEPS}=vm.runInNewContext(model+';({createTutorial,tutorialMove,tutorialScore,TUTORIAL_STEPS})');
const plain=value=>JSON.parse(JSON.stringify(value));

test('教程全流程符合真实规则：扩张、染井、抢色、加固及三种技能',()=>{
  const t=createTutorial(),g=startGame([{id:'you'},{id:'opponent'}],6,0);
  g.size=5;g.board=plain(t.board);g.order=['you','opponent'];g.turn=0;g.hands.you=['leap','pierce','splash'];g.hands.opponent=[];
  for(const step of TUTORIAL_STEPS){
    if(step.mode==='augment')break;
    act(g,'you',{mode:step.mode,index:step.target});
    if(step.mode==='end'){
      act(g,'opponent',{mode:'end'});
      g.event={id:'calm',name:'晴空',desc:''};g.ink=3;
    }
    tutorialMove(t,step.mode,step.target);
    assert.deepEqual(plain(t.board),g.board,step.title);
    assert.equal(t.ink,g.ink,step.title);
  }
  assert.equal(t.hand.leap,0);assert.equal(t.hand.pierce,0);assert.equal(t.hand.splash,0);
  assert.equal(t.board[2].terrain,'rock');assert.equal(t.board[2].owner,null);
  assert.equal(t.board[24].owner,'opponent');assert.equal(t.board[12].shield,true);
  assert.equal(tutorialScore(t,'you'),11);assert.equal(tutorialScore(t,'opponent'),1);
});

test('教学操作校验不跳步，错误目标、技能、费用和强化不会修改进度',()=>{
  const t=createTutorial(),before=JSON.stringify(t);
  assert.throws(()=>tutorialMove(t,'paint',24));assert.throws(()=>tutorialMove(t,'leap',17));assert.throws(()=>tutorialMove(t,'end'));
  assert.equal(JSON.stringify(t),before);
  t.ink=0;assert.throws(()=>tutorialMove(t,'paint',17));assert.equal(t.step,0);assert.equal(t.board[17].owner,null);
  t.ink=3;
  while(TUTORIAL_STEPS[t.step].mode!=='augment'){const s=TUTORIAL_STEPS[t.step];tutorialMove(t,s.mode,s.target);}
  const draft=JSON.stringify(t);assert.throws(()=>tutorialMove(t,'augment','not-a-card'));assert.equal(JSON.stringify(t),draft);
});

test('三张教学强化均可通关，染井加分与正式牌库一致，重开互不影响',()=>{
  const cards=require('../augments').AUGMENTS;
  for(const key of ['basics','well_master','scholar']){
    const t=createTutorial();
    assert.deepEqual(plain(t.cards[key]),{name:cards[key].name,tier:cards[key].tier,desc:cards[key].desc});
    while(TUTORIAL_STEPS[t.step].mode!=='augment'){const s=TUTORIAL_STEPS[t.step];tutorialMove(t,s.mode,s.target);}
    tutorialMove(t,'augment',key);assert.equal(t.step,TUTORIAL_STEPS.length);
    assert.equal(tutorialScore(t,'you'),key==='well_master'?13:11);
    assert.throws(()=>tutorialMove(t,'end'));
  }
  const fresh=createTutorial();assert.equal(fresh.step,0);assert.equal(fresh.ink,3);assert.equal(tutorialScore(fresh,'you'),1);
});

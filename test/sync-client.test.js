const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const client=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
const code=client.split('// BEGIN ROOM SYNC')[1].split('// END ROOM SYNC')[0];
const RoomSync=vm.runInNewContext(code+';RoomSync',{AbortController,setTimeout,clearTimeout});
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const snapshot=(revision=1,code='123456')=>({code,revision,players:[],game:null});
const response=(value=snapshot(),status=200)=>({ok:status===200,status,json:async()=>value});
function setup(options={}){
  let now=0,nextId=1;const jobs=new Map(),events=[],states=[],statuses=[],closed=[],calls=[];
  class FakeSSE{
    constructor(url){this.url=url;this.listeners={};events.push(this);}
    addEventListener(key,fn){this.listeners[key]=fn;}
    close(){this.closed=true;}
    message(value){this.onmessage?.({data:JSON.stringify(value)});}
    emit(name){this.listeners[name]?.({});}
  }
  const clock={set:(fn,ms)=>{const id=nextId++;jobs.set(id,{fn,time:now+ms});return id;},clear:id=>jobs.delete(id),advance:async ms=>{const end=now+ms;while(true){const entry=[...jobs].filter(([,j])=>j.time<=end).sort((a,b)=>a[1].time-b[1].time)[0];if(!entry)break;now=entry[1].time;jobs.delete(entry[0]);entry[1].fn();await flush();}now=end;await flush();}};
  const fetchImpl=async(url,request)=>{calls.push({url,request});return options.fetchImpl?options.fetchImpl(url,request):response(snapshot(3));};
  const sync=new RoomSync({onState:v=>states.push(v),onStatus:v=>statuses.push(v),onClosed:v=>closed.push(v),EventSourceImpl:FakeSSE,setTimer:clock.set,clearTimer:clock.clear,pollInterval:5,connectTimeout:10,idleTimeout:20,probeInterval:30,requestTimeout:40,...options,fetchImpl});
  return {sync,clock,events,states,statuses,closed,calls,jobs};
}

test('SSE 正常时使用推送，心跳续期，断流切换轮询并可恢复 SSE',async()=>{
  const h=setup();h.sync.start('123456','a'.repeat(32));h.events[0].message(snapshot(2));
  await h.clock.advance(15);h.events[0].emit('ping');await h.clock.advance(15);assert.equal(h.calls.length,0);
  h.events[0].onerror();await flush();assert.equal(h.events[0].closed,true);assert.equal(h.calls.length,1);assert.ok(h.statuses.at(-1).includes('兼容模式'));
  await h.clock.advance(30);assert.equal(h.events.length,2);const count=h.calls.length;
  h.events[1].message(snapshot(4));await h.clock.advance(10);assert.equal(h.calls.length,count);assert.ok(h.statuses.at(-1).includes('实时同步'));
  h.sync.stop();assert.equal(h.jobs.size,0);
});

test('SSE 被缓冲或完全不可用时自动降级，强制兼容模式不创建 SSE',async()=>{
  const h=setup();h.sync.start('123456','a'.repeat(32));await h.clock.advance(10);assert.equal(h.calls.length,1);assert.ok(h.statuses.at(-1).includes('兼容模式'));h.sync.stop();
  const p=setup();p.sync.start('123456','a'.repeat(32),'poll');await flush();assert.equal(p.events.length,0);await p.clock.advance(35);assert.equal(p.events.length,0);p.sync.stop();
  const n=setup({EventSourceImpl:undefined});n.sync.start('123456','a'.repeat(32));await flush();assert.equal(n.calls.length,1);n.sync.stop();
});

test('旧版本和旧房间数据不覆盖当前状态，停止后忽略迟到的请求',async()=>{
  const h=setup();h.sync.start('123456','a'.repeat(32));h.events[0].message(snapshot(5));h.events[0].message(snapshot(4));h.events[0].message(snapshot(5));assert.equal(h.states.length,1);
  const old=h.events[0];h.sync.start('654321','b'.repeat(32));old.message(snapshot(100));assert.equal(h.states.length,1);h.events[1].message(snapshot(1,'654321'));assert.equal(h.states.at(-1).code,'654321');h.sync.stop();
  let finish;const p=setup({fetchImpl:()=>new Promise(resolve=>finish=resolve)});p.sync.start('123456','a'.repeat(32),'poll');p.sync.stop();finish(response());await flush();assert.equal(p.states.length,0);assert.equal(p.jobs.size,0);
  const context={state:snapshot(8),render:()=>{},mode:'paint'};vm.createContext(context);
  const setState=client.slice(client.indexOf('function setState('),client.indexOf('// BEGIN ROOM SYNC'));
  vm.runInContext(setState,context);context.setState(snapshot(7));assert.equal(context.state.revision,8);
});

test('轮询不会并发重叠；短暂故障重试，身份失效与房间关闭停止同步',async()=>{
  let finish;const h=setup({fetchImpl:()=>new Promise(resolve=>finish=resolve)});h.sync.start('123456','a'.repeat(32),'poll');await h.clock.advance(30);assert.equal(h.calls.length,1);finish(response());await flush();h.sync.stop();
  let attempts=0;const r=setup({fetchImpl:async()=>{if(!attempts++)throw Error('offline');return response();}});r.sync.start('123456','a'.repeat(32),'poll');await flush();assert.ok(r.statuses.at(-1).includes('重连'));await r.clock.advance(10);assert.equal(r.states.length,1);r.sync.stop();
  for(const status of [401,404,410]){const c=setup({fetchImpl:async()=>response({},status)});c.sync.start('123456','a'.repeat(32),'poll');await flush();assert.equal(c.closed.length,1);assert.equal(c.sync.active,false);assert.equal(c.jobs.size,0);}
});

test('轮询超时会取消请求，且不会自动重试玩家行动',async()=>{
  const h=setup({fetchImpl:(url,request)=>new Promise((resolve,reject)=>request.signal.addEventListener('abort',()=>reject(Error('aborted'))))});
  h.sync.start('123456','a'.repeat(32),'poll');await h.clock.advance(40);assert.ok(h.statuses.at(-1).includes('重连'));assert.equal(h.calls[0].request.signal.aborted,true);assert.ok(h.calls.every(c=>c.url.startsWith('/api/state?')&&!c.url.includes('token=')));h.sync.stop();
});

test('相同版本只续在线心跳，204 空响应不触发画面重绘',async()=>{
  let count=0;const h=setup({fetchImpl:async()=>++count===1?response(snapshot(6)):response(null,204)});
  h.sync.start('123456','a'.repeat(32),'poll');await flush();await h.clock.advance(15);
  assert.equal(h.states.length,1);assert.ok(h.calls[1].url.includes('since=6'));assert.ok(h.statuses.at(-1).includes('兼容模式'));h.sync.stop();
});

test('默认浏览器 fetch 和计时器保持原生调用对象',async()=>{
  const h=vm.runInNewContext(`
    const updates=[];
    globalThis.fetch=function(){if(this!==globalThis)throw Error('Illegal invocation');return Promise.resolve({ok:true,status:200,json:async()=>({code:'123456',revision:1,players:[]})});};
    globalThis.setTimeout=function(){if(this!==globalThis)throw Error('Illegal invocation');return 1;};
    globalThis.clearTimeout=function(){if(this!==globalThis)throw Error('Illegal invocation');};
    ${code}
    const sync=new RoomSync({onState:v=>updates.push(v),onStatus:()=>{},onClosed:()=>{}});
    sync.start('123456','a'.repeat(32),'poll');({sync,updates});
  `,{AbortController});
  await flush();assert.equal(h.updates.length,1);h.sync.stop();
});

test('后端尚未更新时保留旧版 SSE，旧路由 404 不误判为房间关闭',async()=>{
  const h=setup();h.sync.start('123456','a'.repeat(32));h.events[0].message({code:'123456',players:[]});await h.clock.advance(100);assert.equal(h.calls.length,0);assert.equal(h.events[0].closed,undefined);h.sync.stop();
  const p=setup({fetchImpl:async()=>({...response({},404),headers:{get:()=>null}})});p.sync.start('123456','a'.repeat(32),'poll');await flush();assert.equal(p.closed.length,0);assert.equal(p.sync.active,true);assert.ok(p.statuses.at(-1).includes('重连'));p.sync.stop();
});

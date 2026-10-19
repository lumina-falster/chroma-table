const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {loadConfig,allowedOrigin}=require('../config');

test('服务器配置可迁移，环境变量优先且错误配置不能静默回退',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chroma-config-'));
  const file=path.join(dir,'server.config.json');
  try{
    assert.deepEqual(loadConfig({file,env:{}}),{host:'0.0.0.0',port:3000,publicUrl:''});
    fs.writeFileSync(file,JSON.stringify({host:'127.0.0.1',port:3001,publicUrl:'https://game.example/'}));
    assert.deepEqual(loadConfig({file,env:{}}),{host:'127.0.0.1',port:3001,publicUrl:'https://game.example'});
    assert.deepEqual(loadConfig({file,env:{HOST:'0.0.0.0',PORT:'4000',PUBLIC_URL:''}}),{host:'0.0.0.0',port:4000,publicUrl:''});
    for(const PORT of ['0','-1','65536','1.2','abc',''])assert.throws(()=>loadConfig({file,env:{PORT}}));
    for(const PUBLIC_URL of ['ftp://game.example','https://u:p@game.example','https://game.example/path','https://game.example/?secret=1','https://game.example/#a'])assert.throws(()=>loadConfig({file,env:{PUBLIC_URL}}));
    fs.writeFileSync(file,'bad json');assert.throws(()=>loadConfig({file,env:{}}));
  }finally{fs.unlinkSync(file);fs.rmdirSync(dir);}
});

test('HTTP / HTTPS 同源与显式外部来源可用，跨站和伪造来源被拒绝',()=>{
  assert.ok(allowedOrigin(undefined,'localhost:3000'));
  for(const origin of ['http://game.example','https://game.example'])assert.ok(allowedOrigin(origin,'game.example'));
  assert.ok(allowedOrigin('https://game.example','127.0.0.1:3000','https://game.example'));
  assert.ok(allowedOrigin('http://[::1]:3000','[::1]:3000'));
  for(const origin of ['null','https://evil.example','https://game.example.evil','https://u:p@game.example','https://game.example/path','https://game.example:444'])assert.equal(allowedOrigin(origin,'game.example'),false);
});

test('邀请沿用浏览器外网 / 局域网地址，本机访问才使用配置或网卡地址',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
  const code=source.split('// BEGIN SHARE ADDRESS')[1].split('// END SHARE ADDRESS')[0];
  const addresses=vm.runInNewContext(code+';shareAddresses',{URL});
  const info={publicUrl:'https://game.example',addresses:['http://192.168.1.9:3000']};
  const first=origin=>addresses(info,origin)[0];
  assert.equal(first('https://temporary.example'),'https://temporary.example');
  assert.equal(first('http://192.168.1.8:3000'),'http://192.168.1.8:3000');
  for(const origin of ['http://localhost:3000','http://127.0.0.1:3000','http://[::1]:3000'])assert.equal(first(origin),'https://game.example');
  assert.equal(addresses({addresses:info.addresses},'http://localhost:3000')[0],info.addresses[0]);
  assert.equal(addresses({},'http://localhost:3000')[0],'http://localhost:3000');
  const link=new URL('/',first('https://game.example'));link.searchParams.set('room','000001');assert.equal(link.href,'https://game.example/?room=000001');
});

test('真实 HTTP 服务接受代理 HTTPS 来源，拒绝跨站与伪造代理头，地址使用实际端口',async()=>{
  const {server,rooms}=require('../server');
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const root=`http://127.0.0.1:${server.address().port}`;let code;
  const post=origin=>new Promise((resolve,reject)=>{
    const request=require('node:http').request(root+'/api/create',{method:'POST',headers:{Origin:origin,Host:'game.example','X-Forwarded-Host':'evil.example','X-Forwarded-Proto':'https','X-Player-Token':'a'.repeat(32),'Content-Type':'application/json'}},response=>{
      let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>resolve({status:response.statusCode,json:async()=>JSON.parse(body)}));
    });request.on('error',reject);request.end(JSON.stringify({name:'代理玩家'}));
  });
  try{
    const r=await post('https://game.example');assert.equal(r.status,200);code=(await r.json()).code;
    const bad=await post('https://evil.example');assert.equal(bad.status,400);assert.match((await bad.json()).error,/来源/);
    const network=await fetch(root+'/api/network');assert.match(network.headers.get('cache-control'),/no-store/);
    for(const address of (await network.json()).addresses)assert.equal(new URL(address).port,String(server.address().port));
  }finally{if(code)rooms.delete(code);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

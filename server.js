const os=require('node:os');
const {loadConfig}=require('./config');
const {createGameServer}=require('./server-core');
const config=loadConfig(),PORT=config.port;
const instance=createGameServer({config});
const {server}=instance;
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
module.exports=instance;

const fs=require('node:fs');
const path=require('node:path');

function loadConfig({env=process.env,file=path.join(__dirname,'server.config.json')}={}){
  const saved=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
  const host=env.HOST??saved.host??'0.0.0.0';
  const port=Number(env.PORT??saved.port??3000);
  if(typeof host!=='string'||!host.trim())throw Error('HOST 必须是有效的监听地址');
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('PORT 必须是 1–65535 的整数');
  const value=env.PUBLIC_URL??saved.publicUrl??'';
  let publicUrl='';
  if(value){
    const url=new URL(value);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('PUBLIC_URL 必须是 http/https 根地址，不含路径、参数或密码');
    publicUrl=url.origin;
  }
  return {host,port,publicUrl};
}

// Forwarded headers are intentionally not trusted. A rewriting proxy can use PUBLIC_URL.
function allowedOrigin(origin,host,publicUrl=''){
  if(!origin)return true;
  try{
    const url=new URL(origin);
    if(!['http:','https:'].includes(url.protocol)||url.origin!==origin)return false;
    return origin===publicUrl||origin===new URL(`http://${host}`).origin||origin===new URL(`https://${host}`).origin;
  }catch{return false;}
}
module.exports={loadConfig,allowedOrigin};

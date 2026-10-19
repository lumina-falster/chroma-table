import {DurableObject} from 'cloudflare:workers';
import {httpServerHandler} from 'cloudflare:node';
import {createHash} from 'node:crypto';
import core from '../server-core.js';
import profiles from '../profile-store.js';
import gm from '../gm.js';

// One private SQLite-backed coordinator preserves the existing shared lobby.
// Browser identities and room snapshots never leave this Durable Object storage.
export class GameHub extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);this.env=env;this.ctx=ctx;
    ctx.blockConcurrencyWhile(async()=>{
      const sql=ctx.storage.sql;
      sql.exec('CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, snapshot TEXT NOT NULL)');
      sql.exec('CREATE TABLE IF NOT EXISTS progress (id INTEGER PRIMARY KEY, snapshot TEXT NOT NULL)');
      const store=new profiles.ProfileStore({file:null});
      const saved=sql.exec('SELECT snapshot FROM progress WHERE id=1').toArray()[0];
      if(saved)store.data=JSON.parse(saved.snapshot);
      store.commit=next=>{sql.exec('INSERT INTO progress(id,snapshot) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot',JSON.stringify(next));store.data=next;};
      const allowed=new Set(String(env.GM_TOKEN_HASHES||'').split(',').map(s=>s.trim()).filter(Boolean));
      this.game=core.createGameServer({profileStore:store,manualHeartbeat:true,config:{host:'127.0.0.1',port:3000,publicUrl:''},
        isGm:p=>gm.isGm(p)&&allowed.has(createHash('sha256').update(p.token).digest('hex')),
        onChange:room=>{this.saveRoom(room);this.ensureAlarm();},
        onDelete:code=>sql.exec('DELETE FROM rooms WHERE code=?',code)
      });
      for(const row of sql.exec('SELECT code,snapshot FROM rooms')){
        const room=JSON.parse(row.snapshot);room.gmRequests=new Map(room.gmRequests||[]);
        for(const p of [...room.players,...room.spectators||[]]){p.pollUntil=0;if(!p.bot){p.disconnectedAt=Date.now();p.roomCode=room.code;}}
        this.game.rooms.set(row.code,room);
        for(const p of room.players)if(!p.bot)this.game.scheduleTransfer(room,p);
      }
      this.handler=httpServerHandler(this.game.server);
    });
  }
  saveRoom(room){
    const snapshot=JSON.stringify(room,(key,value)=>['pollTimer','transferTimer'].includes(key)?undefined:value instanceof Map?[...value]:value);
    this.ctx.storage.sql.exec('INSERT INTO rooms(code,snapshot) VALUES(?,?) ON CONFLICT(code) DO UPDATE SET snapshot=excluded.snapshot',room.code,snapshot);
  }
  ensureAlarm(){
    if(this.alarmPending)return;
    this.alarmPending=true;
    this.ctx.waitUntil((async()=>{
      try{if(await this.ctx.storage.getAlarm()===null)await this.ctx.storage.setAlarm(Date.now()+5000);}
      finally{this.alarmPending=false;}
    })());
  }
  async fetch(request){
    const response=await this.handler.fetch(request,this.env,this.ctx);
    this.ensureAlarm();return response;
  }
  async alarm(){
    this.game.tick();
    // Only active connections/leases keep the alarm alive; empty lobbies sleep.
    const active=this.game.streams.size>0||[...this.game.rooms.values()].some(r=>r.players.some(p=>!p.bot&&(p.pollUntil||0)>Date.now()));
    if(active)await this.ctx.storage.setAlarm(Date.now()+5000);
  }
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==='/api/network')return Response.json({addresses:[],publicUrl:url.origin},{headers:{'Cache-Control':'no-store'}});
    if(url.pathname.startsWith('/api/'))return env.GAME_HUB.get(env.GAME_HUB.idFromName('chroma-hub-v1')).fetch(request);
    return env.ASSETS.fetch(request);
  }
};

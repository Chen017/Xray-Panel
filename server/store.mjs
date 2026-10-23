import { DatabaseSync } from 'node:sqlite';
import { randomBytes,createCipheriv,createDecipheriv,createHash,scryptSync,timingSafeEqual } from 'node:crypto';
import { mkdirSync,chmodSync } from 'node:fs';
import path from 'node:path';
export const token = () => randomBytes(32).toString('base64url');
export const digest = s => createHash('sha256').update(s).digest('hex');
export function passwordHash(p,salt=randomBytes(16).toString('hex')) {return `${salt}:${scryptSync(p,salt,64).toString('hex')}`;}
export function passwordVerify(p,hash) {const [salt,expected]=hash.split(':');const result=scryptSync(p,salt,64);return timingSafeEqual(result,Buffer.from(expected,'hex'));}
export class Store {
  constructor(filename,key) {
    if(!/^[a-f\d]{64}$/i.test(key??''))throw Error('PANEL_MASTER_KEY 必须是 64 位十六进制随机密钥');
    this.key=Buffer.from(key,'hex');mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(filename);chmodSync(filename,0o600);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,detail TEXT NOT NULL);');
    // Fail closed when a wrong master key is used with an existing database.
    const check=this.get('system','keycheck');if(!check)this.put('system','keycheck',{ok:true});
  }
  seal(obj){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key,iv),out=Buffer.concat([c.update(JSON.stringify(obj),'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),out]).toString('base64');}
  open(value){const b=Buffer.from(value,'base64'),d=createDecipheriv('aes-256-gcm',this.key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString());}
  get(kind,id){const row=this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind,id);return row?this.open(row.data):null;}
  list(kind){return this.db.prepare('SELECT data FROM records WHERE kind=?').all(kind).map(r=>this.open(r.data));}
  put(kind,id,value){this.db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind,id,this.seal(value));return value;}
  remove(kind,id){this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind,id);}
  tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  audit(action,target,detail=''){this.db.prepare('INSERT INTO audit(at,action,target,detail) VALUES(?,?,?,?)').run(new Date().toISOString(),action,target,detail.slice(0,1000));this.db.exec('DELETE FROM audit WHERE id < (SELECT COALESCE(MAX(id),0)-10000 FROM audit)');}
  audits(){return this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 250').all();}
  close(){this.db.close();}
}

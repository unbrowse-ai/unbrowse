import { getInProcessApp } from "../src/runtime/in-process-app.ts";
const app = await getInProcessApp();
async function P(u:string,b:any){const r=await app.inject({method:"POST",url:u,headers:{"content-type":"application/json","x-unbrowse-client-id":"diag"},payload:JSON.stringify(b)});let j:any={};try{j=JSON.parse(r.body)}catch{j={raw:r.body?.slice(0,150)}}return{st:r.statusCode,j}}
const g=await P("/v1/browse/go",{url:"https://example.com/",session_id:"diag-seq-1"});
console.log("GO explicit-sid:",JSON.stringify({st:g.st,session_id:g.j?.session_id,tab_id:g.j?.tab_id,url:g.j?.url,err:g.j?.error}));
await new Promise(r=>setTimeout(r,1500));
const s=await P("/v1/browse/snap",{session_id:"diag-seq-1",detail_level:"minimal"});
console.log("SNAP:",JSON.stringify({st:s.st,current_url:s.j?.current_url,title:s.j?.page_title,root:String(s.j?.root_aria||"").slice(0,60),warn:s.j?.warning,err:s.j?.error}));
// also: no-session-id control (old path)
const g2=await P("/v1/browse/go",{url:"https://example.com/"});
const s2=await P("/v1/browse/snap",{session_id:g2.j?.session_id,detail_level:"minimal"});
console.log("CONTROL no-sid GO+SNAP:",JSON.stringify({go_sid:g2.j?.session_id,snap_url:s2.j?.current_url,snap_err:s2.j?.error||s2.j?.warning}));
await P("/v1/browse/close",{session_id:"diag-seq-1"}); await P("/v1/browse/close",{session_id:g2.j?.session_id});
process.exit(0);

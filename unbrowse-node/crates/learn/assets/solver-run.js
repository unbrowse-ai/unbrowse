/*
 * Run the challenge's orchestrate against solver-env.js without a browser.
 * Usage: node solver-run.js <challenge.html> <orchestrate.js>
 *
 * The orchestrate is evaluated with the page's own _cf_chl_opt, so the two
 * must come from the same challenge response. The runner locates the shared
 * type cast in whatever build it is handed (the minifier renames it every
 * time) and records the value it refuses, so a failure names itself.
 */
process.on('uncaughtException', (e) => {
  console.log('UNCAUGHT:', String(e && e.stack || e).split(String.fromCharCode(10)).slice(0, 2).join(' || ').slice(0, 200));
  finish();
});
require('./solver-env.js');
const html = require('fs').readFileSync(process.argv[2], 'utf8');
const m = html.match(/_cf_chl_opt\s*=\s*(\{[\s\S]*?\})\s*;/);
globalThis._cf_chl_opt = (0, eval)('(' + m[1] + ')');
{ const widget = document.querySelector('#cf-chl-widget');
  Object.defineProperty(globalThis._cf_chl_opt, 'glEe8', { get: () => widget, set: () => {}, configurable: true }); }
let src = require('fs').readFileSync(process.argv[3], 'utf8');
// Find the shared type cast: function X(a,b,c){if(b={a:N},c=dec,typeof a!==c(b.a))throw new TypeError
const RE = /function (\w+)\((\w+),(\w+),(\w+)\)\{if\(\w+=\{a:\d+\},\w+=\w+,typeof \w+!==\w+\(\w+\.a\)\)throw new TypeError/;
const hit = src.match(RE);
console.log('cast found:', hit ? hit[1] : 'none');
if (hit) {
  const fname = hit[1], arg = hit[2];
  const HOOK = 'function ' + fname + '(' + hit[2] + ',' + hit[3] + ',' + hit[4] + '){' +
    'if(typeof ' + arg + '!=="function"){globalThis.__bad=[typeof ' + arg + ',String(' + arg + ').slice(0,40)];try{var f=' + fname + '.caller,out=[];' +
    'for(var d=0;f&&d<5;d++,f=f.caller){' +
    'try{var a=f.arguments;if(!a)break;' +
    'for(var i=0;i<a.length;i++){var v=a[i];' +
    'if(typeof v==="string"&&v.length<40){out.push(d+":"+i+":"+v);}' +
    'if(v&&typeof v.length==="number"&&typeof v!=="string"){' +
    'for(var j=0;j<v.length&&j<40;j++){if(typeof v[j]==="string"&&v[j].length<40){out.push(d+":"+i+"["+j+"]:"+v[j]);}}' +
    '}' +
    '}' +
    '}catch(e){break;}' +
    '}' +
    'globalThis.__reg=out.join(",");' +
    '}catch(e){globalThis.__reg="err:"+String(e.message);}' +
    '}';
  src = src.replace('function ' + fname + '(' + hit[2] + ',' + hit[3] + ',' + hit[4] + '){', HOOK);
}
(0, eval)(src);
console.log('evaluated');
function finish() {
  console.log('bad:', JSON.stringify(globalThis.__bad||null));
  console.log('reg:', String(globalThis.__reg || '<none>').slice(0, 600));
  console.log('sends:', (globalThis.__sent || []).length);
  process.exit(0);
}
setTimeout(finish, 3000);

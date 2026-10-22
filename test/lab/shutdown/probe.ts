import { QuickCHR } from '../../../src/lib/quickchr.ts';
import { isMachineRunning } from '../../../src/lib/state.ts';
const arch = (process.argv[2] ?? 'x86') as 'x86'|'arm64';
const name = `shutdown143-${arch}-${Date.now()}`;
const events: unknown[] = [];
function record(x: object) { events.push(x); console.log(JSON.stringify(x)); }
let chr: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;
try {
 chr = await QuickCHR.start({name, arch, version:'7.24.5', background:true, secureLogin:false});
 record({phase:'ready',arch,version:chr.state.version,resource:await chr.exec(':put [/system/resource/get version]',{via:'rest'})});
 const marker = `shutdown143-${Date.now()}`;
 await chr.exec(`/system/identity/set name=${marker}`,{via:'rest'});
 record({phase:'marker-before',result:await chr.exec(':put [/system/identity/get name]',{via:'rest'})});
 const t = performance.now();
 const request = chr.exec('/system/shutdown',{via:'rest',timeout:10000}).then(result=>record({phase:'request',ms:performance.now()-t,result}),error=>record({phase:'request',ms:performance.now()-t,error:String(error)}));
 while(isMachineRunning(chr.state) && performance.now()-t<15000) await Bun.sleep(50);
 const exited = !isMachineRunning(chr.state);
 record({phase:'exit',ms:performance.now()-t,exited});
 await request;
 if(exited) {
  await chr.stop();
  chr = await QuickCHR.start({name,background:true});
  const result = await chr.exec(':put [/system/identity/get name]',{via:'rest'});
  record({phase:'marker-after',result,persisted:result.output===marker});
 }
} finally {
 if(chr) await chr.remove();
 else { const leftover=QuickCHR.get(name); if(leftover) await leftover.remove(); }
 record({phase:'cleanup',removed:QuickCHR.get(name)===null});
 // Print evidence; CI/local callers may redirect stdout outside the source tree.
 console.log(JSON.stringify({events}));
}

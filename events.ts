// A lightweight invalidation stream shared by document and conversation updates.
export function changeEvents(request: Request, subscribe: (changed:()=>void, failed:()=>void)=>()=>void) {
 let stop=()=>{};
 const stream=new ReadableStream<Uint8Array>({
  start(controller){
   let closed=false,unsubscribe=()=>{};
   let pending:ReturnType<typeof setTimeout>|undefined,heartbeat:ReturnType<typeof setInterval>|undefined;
   const encoder=new TextEncoder();
   stop=()=>{if(closed)return;closed=true;clearTimeout(pending);clearInterval(heartbeat);unsubscribe();request.signal.removeEventListener('abort',stop);try{controller.close()}catch{}};
   const emit=(text:string)=>{if(closed)return;try{controller.enqueue(encoder.encode(text))}catch{stop()}};
   const changed=()=>{if(closed||pending!==undefined)return;pending=setTimeout(()=>{pending=undefined;emit('event: change\ndata: {}\n\n')},80)};
   if(request.signal.aborted){stop();return}
   try{unsubscribe=subscribe(changed,stop)}catch(error){stop();throw error}
   request.signal.addEventListener('abort',stop,{once:true});
   // Bun's default HTTP idle timeout is 10s; send before it expires.
   heartbeat=setInterval(()=>emit(': keepalive\n\n'),5000);
   // Every new/reconnected subscription re-fetches a snapshot, including changes while disconnected.
   emit('retry: 1000\nevent: change\ndata: {}\n\n');
  },
  cancel(){stop()},
 });
 return new Response(stream,{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','X-Content-Type-Options':'nosniff'}});
}

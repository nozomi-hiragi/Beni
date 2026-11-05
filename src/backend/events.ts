import type { ServerWebSocket } from 'bun';
import { object, validId, validScope, validTerminalAction, type Scope, type TopicEvent, type ServerMessage, type ErrorCode, type TerminalAction } from '../shared/communication';

export type Subscription = {stop:()=>void;start?:()=>void;message?:(action:TerminalAction)=>void};
export type SocketData = {ready:boolean;used:Set<string>;subscriptions:Map<string,Subscription>;timer?:ReturnType<typeof setTimeout>};
export type TopicRegistration = {validate:(scope:Scope)=>boolean;subscribe:(scope:Scope,event:(event:TopicEvent)=>void,failed:()=>void)=>(()=>void)|Subscription};
export function communicationSocket(topics:Record<string,TopicRegistration>) {
 const release=(ws:ServerWebSocket<SocketData>)=>{clearTimeout(ws.data.timer);for(const subscription of ws.data.subscriptions.values())subscription.stop();ws.data.subscriptions.clear()};
 const send=(ws:ServerWebSocket<SocketData>,message:ServerMessage)=>{const data=JSON.stringify(message);if(ws.readyState!==1)return false;if(new TextEncoder().encode(data).byteLength>65536){release(ws);ws.close(1009,'Frame too large');return false;}if(ws.getBufferedAmount()+new TextEncoder().encode(data).byteLength>1024*1024){release(ws);ws.close(1013,'Slow receiver');return false}if(ws.send(data)===-1&&ws.getBufferedAmount()>1024*1024){release(ws);ws.close(1013,'Slow receiver');return false}return true};
 const error=(ws:ServerWebSocket<SocketData>,code:ErrorCode,message:string,subscriptionId?:string)=>send(ws,{type:'error',code,message,...(subscriptionId?{subscriptionId}:{})});
 return {
  maxPayloadLength:65536,backpressureLimit:1024*1024,closeOnBackpressureLimit:true,idleTimeout:30,sendPings:true,
  open(ws:ServerWebSocket<SocketData>){ws.data.timer=setTimeout(()=>{error(ws,'NOT_READY','接続の確認がタイムアウトしました');ws.close(1008,'Hello timeout')},5000)},
  message(ws:ServerWebSocket<SocketData>,raw:string|Buffer){
   if(typeof raw!=='string'){error(ws,'INVALID_MESSAGE','テキストの JSON を送信してください');ws.close(1003,'Text messages required');return}
   let m:unknown;try{m=JSON.parse(raw)}catch{error(ws,'INVALID_MESSAGE','メッセージを確認してください');return}
   if(!object(m)){error(ws,'INVALID_MESSAGE','メッセージを確認してください');return}
   if(m.type==='hello'){if(ws.data.ready){error(ws,'INVALID_MESSAGE','接続は確認済みです');return}if(m.version!==1){error(ws,'UNSUPPORTED_VERSION','対応していない通信バージョンです');ws.close(1002,'Unsupported version');return}clearTimeout(ws.data.timer);ws.data.ready=true;send(ws,{type:'ready',version:1});return}
   if(!ws.data.ready){error(ws,'NOT_READY','接続を確認してください');return}
   if(!validId(m.subscriptionId)){error(ws,'INVALID_MESSAGE','購読 ID を確認してください');return}
   const id=m.subscriptionId;
   if(m.type==='unsubscribe'){ws.data.subscriptions.get(id)?.stop();ws.data.subscriptions.delete(id);send(ws,{type:'unsubscribed',subscriptionId:id});return}
   if(typeof m.type==='string'&&m.type.startsWith('terminal.')){const subscription=ws.data.subscriptions.get(id);if(!validTerminalAction(m)){error(ws,'INVALID_MESSAGE','ターミナル操作を確認してください',id);return}if(!subscription?.message){error(ws,'NOT_FOUND','ターミナルの購読を確認してください',id);return}try{subscription.message(m)}catch(e){const status=(e as {status?:number}).status;error(ws,status===403?'FORBIDDEN':status===429?'LIMIT_EXCEEDED':'INVALID_MESSAGE','ターミナル操作を受け付けませんでした',id)}return}
   if(m.type!=='subscribe'){error(ws,'INVALID_MESSAGE','不明な操作です',id);return}
   if(typeof m.topic!=='string'||!Object.hasOwn(topics,m.topic)){error(ws,'UNKNOWN_TOPIC','不明な購読対象です',id);return}
   if(!validScope(m.scope)||(m.topic==='chat'?(m.scope.taskId===null?m.scope.phase!=null:!m.scope.phase):m.scope.phase!==undefined)){error(ws,'INVALID_MESSAGE','購読対象を確認してください',id);return}
   if(ws.data.used.has(id)){error(ws,'SUBSCRIPTION_CONFLICT','使用済みの購読 ID です',id);return}
   // Bound both active subscriptions and used identifiers for the life of a socket.
   if(ws.data.used.size>=4096){release(ws);ws.close(1013,'Recycle subscriptions');return}if(ws.data.subscriptions.size>=32){error(ws,'LIMIT_EXCEEDED','購読数の上限です',id);return}
   ws.data.used.add(id);
   const topic=topics[m.topic];if(!topic.validate(m.scope)){error(ws,'NOT_FOUND','対象が見つかりません',id);return}
   let enabled=false,stopped=false,stop=()=>{};
   const fail=()=>{if(stopped)return;stopped=true;stop();ws.data.subscriptions.delete(id);error(ws,'INTERNAL_ERROR','更新を監視できませんでした',id)};
   try{const registered=topic.subscribe(m.scope,event=>{if(enabled&&!stopped)send(ws,{type:'event',subscriptionId:id,...event})},fail);const registration=typeof registered==='function'?{stop:registered}:registered;stop=registration.stop;if(stopped){stop();return}ws.data.subscriptions.set(id,{stop:()=>{stopped=true;stop()},message:registration.message});if(send(ws,{type:'subscribed',subscriptionId:id})){enabled=true;registration.start?.()}else fail()}catch{fail()}
  },
  close(ws:ServerWebSocket<SocketData>){release(ws)},
 };
}

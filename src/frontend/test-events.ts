export class FakeEventSource extends EventTarget {
 static instances:FakeEventSource[]=[];
 closed=false;
 onerror:(()=>void)|null=null;
 constructor(public url:string){super();FakeEventSource.instances.push(this)}
 close(){this.closed=true}
 change(){this.dispatchEvent(new Event('change'))}
}

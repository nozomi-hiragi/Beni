import type { Agent, AgentCommand, AgentHost, AgentOutcome, AgentRequest, AgentStatus } from '../agents/agent';

type Scenario = (request: AgentRequest, host: AgentHost, accept: () => Promise<void>) => Promise<AgentOutcome>;
type Options = {
 id?: string;
 name?: string;
 commands?: readonly AgentCommand[];
 supportsEmbeddedTools?: boolean;
 status?: () => Partial<AgentStatus>;
 getUsage?: NonNullable<Agent['getUsage']>;
 scenario?: Scenario;
};

export class DummyAgent implements Agent {
 readonly id: string;
 readonly name: string;
 readonly accessModes = ['read-only', 'workspace-write'] as const;
 readonly commands: readonly AgentCommand[];
 readonly supportsEmbeddedTools: boolean;
 readonly getUsage?: NonNullable<Agent['getUsage']>;
 readonly requests: AgentRequest[] = [];
 private readonly sessions = new Set<string>();
 private nextSession = 1;

 constructor(private readonly options: Options = {}) {
  this.id = options.id ?? 'dummy';
  this.name = options.name ?? 'Dummy';
  this.commands = options.commands ?? [];
  this.supportsEmbeddedTools = options.supportsEmbeddedTools ?? false;
  this.getUsage = options.getUsage;
 }

 async getStatus(): Promise<AgentStatus> {
  return {
   availability: 'ready', auth: 'not-required', models: [{id:'dummy-model',name:'Dummy Model'}],
   checkedAt: '2026-01-01T00:00:00.000Z', ...this.options.status?.(),
  };
 }

 async run(request: AgentRequest, host: AgentHost): Promise<AgentOutcome> {
  this.requests.push(structuredClone(request));
  if (host.signal.aborted) return {status:'interrupted'};
  const target = request.target;
  if (target.mode === 'resume' && (target.session.agentId !== this.id || !this.sessions.has(target.session.id))) {
   return {status:'failed',code:'session-missing'};
  }
  const session = target.mode === 'ephemeral' ? null :
   target.mode === 'resume' ? target.session : {agentId:this.id,id:`session-${this.nextSession++}`};
  let accepted = false;
  const accept = async () => {
   if (accepted) throw Error('DummyAgent accepted twice');
   accepted = true;
   if (session) this.sessions.add(session.id);
   await host.emit({type:'accepted',session});
  };
  if (this.options.scenario) return this.options.scenario(request,host,accept);
  await accept();
  await host.emit({type:'text.completed',itemId:'reply',text:'Dummy reply'});
  return {status:'completed'};
 }
}

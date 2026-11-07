import type { Agent } from './agent';
import { ClaudeAgent } from './claude';
import { CodexAgent } from './codex';

export function createAgents(codexExecutable?:()=>string|null,claudeExecutable?:()=>string|null):Agent[] {
 return [new CodexAgent(codexExecutable),new ClaudeAgent(claudeExecutable)];
}

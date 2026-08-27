import { applyHistoricalStar } from './star-policy.js';
import { evaluateSurge, type CommonFollowObservation, type SurgePolicyOptions } from './surge-policy.js';

export type ProjectStatus = 'screening' | 'active' | 'trench' | 'dormant' | 'pending_review' | 'excluded';
export interface WorkflowProject { id: string; xUserId: string; handle: string; displayName?: string; status: ProjectStatus; highestStar: number; highestCommonFollowCount: number; surgeUntil?: Date; }
export interface WorkflowSignal { id: string; type: 'common_follow' | 'new_tweet' | 'ca' | 'profile_change'; occurredAt: Date; xUserId?: string; handle?: string; displayName?: string; commonFollowCount?: number; dedupeKey: string; }
export type WorkflowCommand =
  | { type: 'create_screening_job'; projectId: string }
  | { type: 'publish_project'; projectId: string }
  | { type: 'create_research_job'; projectId: string }
  | { type: 'sync_alpha_monitor'; projectId: string; desiredState: 'enabled' | 'disabled' }
  | { type: 'notify_surge'; projectId: string };
export interface WorkflowResult { accepted: boolean; reason?: 'missing_x_user_id' | 'duplicate_signal'; project?: WorkflowProject; commands: readonly WorkflowCommand[]; surge?: ReturnType<typeof evaluateSurge>; }

export class InMemoryProjectWorkflow {
  private readonly projects = new Map<string, WorkflowProject>();
  private readonly observations = new Map<string, CommonFollowObservation[]>();
  private readonly seenSignals = new Set<string>();
  private readonly screeningPassed = new Set<string>();
  constructor(private readonly options: { surge?: SurgePolicyOptions } = {}) {}

  acceptSignal(signal: WorkflowSignal): WorkflowResult {
    if (this.seenSignals.has(signal.dedupeKey)) return { accepted: false, reason: 'duplicate_signal', commands: [] };
    this.seenSignals.add(signal.dedupeKey);
    if (!signal.xUserId) return { accepted: false, reason: 'missing_x_user_id', commands: [] };
    let project = this.projects.get(signal.xUserId);
    const commands: WorkflowCommand[] = [];
    if (!project) {
      project = { id: `project:${signal.xUserId}`, xUserId: signal.xUserId, handle: signal.handle ?? '', displayName: signal.displayName, status: 'screening', highestStar: 0, highestCommonFollowCount: 0 };
      this.projects.set(signal.xUserId, project);
      commands.push({ type: 'create_screening_job', projectId: project.id });
    } else if (signal.handle) { project.handle = signal.handle; project.displayName = signal.displayName ?? project.displayName; }
    let surge: ReturnType<typeof evaluateSurge> | undefined;
    if (signal.type === 'common_follow' && signal.commonFollowCount !== undefined) {
      project.highestCommonFollowCount = Math.max(project.highestCommonFollowCount, signal.commonFollowCount);
      const history = this.observations.get(signal.xUserId) ?? [];
      history.push({ occurredAt: signal.occurredAt, count: signal.commonFollowCount, dedupeKey: signal.dedupeKey });
      this.observations.set(signal.xUserId, history);
      const decision = evaluateSurge(history, signal.occurredAt, this.options.surge);
      if (decision.triggered && (!project.surgeUntil || project.surgeUntil.getTime() < signal.occurredAt.getTime())) { project.surgeUntil = decision.expiresAt; surge = decision; commands.push({ type: 'notify_surge', projectId: project.id }); }
      else surge = { ...decision, triggered: false };
      project.highestStar = applyHistoricalStar(project.highestStar, signal.commonFollowCount).highestStar;
    }
    return { accepted: true, project: { ...project }, commands, surge };
  }

  applyScreening(projectId: string, allowed: boolean): WorkflowResult {
    const project = [...this.projects.values()].find((item) => item.id === projectId); if (!project) return { accepted: false, commands: [] };
    const commands: WorkflowCommand[] = [];
    if (allowed) { this.screeningPassed.add(projectId); project.status = project.highestStar >= 3 ? 'trench' : 'active'; commands.push({ type: 'publish_project', projectId }, { type: 'create_research_job', projectId }); if (project.status === 'trench') commands.push({ type: 'sync_alpha_monitor', projectId, desiredState: 'enabled' }); }
    else project.status = 'pending_review';
    return { accepted: true, project: { ...project }, commands };
  }
  exclude(projectId: string, _reason: string): WorkflowResult { const project = [...this.projects.values()].find((item) => item.id === projectId); if (!project) return { accepted: false, commands: [] }; project.status = 'excluded'; return { accepted: true, project: { ...project }, commands: [{ type: 'sync_alpha_monitor', projectId, desiredState: 'disabled' }] }; }
  restore(projectId: string): WorkflowResult { const project = [...this.projects.values()].find((item) => item.id === projectId); if (!project || project.status !== 'excluded') return { accepted: false, commands: [] }; project.status = this.screeningPassed.has(projectId) ? (project.highestStar >= 3 ? 'trench' : 'active') : 'screening'; return { accepted: true, project: { ...project }, commands: [] }; }
}

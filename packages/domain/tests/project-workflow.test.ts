import { describe, expect, it } from 'vitest';
import { InMemoryProjectWorkflow } from '../src/project-workflow.js';

describe('InMemoryProjectWorkflow', () => {
  it('uses X numeric user id as identity and schedules screening once', () => {
    const workflow = new InMemoryProjectWorkflow();
    const first = workflow.acceptSignal({ id: '1', dedupeKey: 'a', type: 'common_follow', xUserId: '42', handle: 'old', occurredAt: new Date('2026-08-26T00:00:00Z'), commonFollowCount: 5 });
    const second = workflow.acceptSignal({ id: '2', dedupeKey: 'b', type: 'common_follow', xUserId: '42', handle: 'new', occurredAt: new Date('2026-08-26T00:01:00Z'), commonFollowCount: 8 });
    expect(first.commands).toEqual([{ type: 'create_screening_job', projectId: 'project:42' }]);
    expect(second.project).toMatchObject({ id: 'project:42', handle: 'new', highestStar: 2 });
    expect(workflow.acceptSignal({ id: '2', dedupeKey: 'b', type: 'common_follow', xUserId: '42', occurredAt: new Date(), commonFollowCount: 8 }).reason).toBe('duplicate_signal');
  });

  it('never lowers stars and enters trench after screening at three stars', () => {
    const workflow = new InMemoryProjectWorkflow();
    const signal = workflow.acceptSignal({ id: '1', dedupeKey: 'a', type: 'common_follow', xUserId: '42', occurredAt: new Date(), commonFollowCount: 12 });
    const result = workflow.applyScreening(signal.project!.id, true);
    expect(result.project?.status).toBe('trench');
    expect(result.commands).toContainEqual({ type: 'sync_alpha_monitor', projectId: 'project:42', desiredState: 'enabled' });
    const later = workflow.acceptSignal({ id: '2', dedupeKey: 'b', type: 'common_follow', xUserId: '42', occurredAt: new Date(), commonFollowCount: 5 });
    expect(later.project?.highestStar).toBe(3);
  });
});

import { JobStore, OutboxStore, type JobDatabase, type JobRecord } from '@alpha-research/db';
import { evaluateSurge, starForCommonFollowCount } from '@alpha-research/domain';
import type { DecodedAlphaEvent } from '@alpha-research/alpha';
import { ensureTrenchMonitoring } from '../trench.js';

interface DecodeAlphaEventPayload { rawEventId: string; event: DecodedAlphaEvent; }

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function displayName(event: DecodedAlphaEvent): string {
  const payload = event.payload as Record<string, unknown>;
  const followUser = payload.follow_user && typeof payload.follow_user === 'object' ? payload.follow_user as Record<string, unknown> : undefined;
  return text(followUser?.name) ?? text(followUser?.display_name) ?? text(payload.display_name) ?? text(payload.displayName) ?? text(payload.name) ?? event.handle ?? '';
}

function targetProfile(event: DecodedAlphaEvent): Record<string, unknown> {
  const payload = event.payload as Record<string, unknown>;
  for (const key of ['follow_user', 'followUser', 'target_user', 'targetUser']) {
    const value = payload[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return {};
}

function screeningBio(event: DecodedAlphaEvent, profile: Record<string, unknown>): string | undefined {
  const direct = text(profile.description) ?? text(profile.bio);
  if (direct) return direct;
  const content = event.content ?? '';
  const match = content.match(/用户简介\s*:\s*([\s\S]*?)(?:\n你关注的|$)/i);
  return match?.[1]?.trim() || undefined;
}

/** Materializes a decoded Alpha signal into the project and signal tables. */
export function createDecodeAlphaEventHandler(database: JobDatabase) {
  return async (job: JobRecord): Promise<void> => {
    const payload = (typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload) as DecodeAlphaEventPayload;
    if (!payload?.rawEventId || !payload.event) throw new Error('Invalid decode_alpha_event payload');
    const occurredAt = payload.event.occurredAt instanceof Date ? payload.event.occurredAt : new Date(String(payload.event.occurredAt));
    if (Number.isNaN(occurredAt.getTime())) throw new Error('Invalid Alpha event occurredAt');
    // Jobs are persisted as JSON, so Date values arrive here as ISO strings.
    // Normalize once before star/surge calculations and outbox serialization.
    const event = { ...payload.event, occurredAt };

    if (!event.xUserId || event.type === 'heartbeat' || event.type === 'unknown') {
      await database.query('update raw_events set decode_status = $2 where id = $1', [payload.rawEventId, event.type === 'unknown' ? 'unsupported' : 'decoded']);
      return;
    }

    const handle = event.handle ?? '';
    const name = displayName(event);
    const profile = targetProfile(event);
    const followerValue = profile.followers_count ?? profile.followersCount ?? profile.followers;
    const followerCount = Number(followerValue);
    const star = event.commonFollowCount === undefined ? 0 : starForCommonFollowCount(event.commonFollowCount);
    // An AI-excluded project is terminal for the project pool. Keep receiving
    // the raw Alpha event for audit/replay, but do not touch the project,
    // create another signal, or re-enter the excluded pool on later pushes.
    const existing = await database.query<{ id: string; status: string }>(
      'select id, status from projects where x_user_id = $1',
      [event.xUserId]
    );
    if (existing.rows[0]?.status === 'excluded') {
      await database.query('update raw_events set decode_status = $2 where id = $1', [payload.rawEventId, 'decoded']);
      return;
    }
    const project = await database.query<{ id: string }>(
      `insert into projects (x_user_id, current_handle, display_name, avatar_url, highest_star, highest_common_follow_count, current_common_follow_count, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, now())
       on conflict (x_user_id) do update set
         current_handle = case when excluded.current_handle <> '' then excluded.current_handle else projects.current_handle end,
         display_name = case when excluded.display_name <> '' then excluded.display_name else projects.display_name end,
         avatar_url = case when excluded.avatar_url is not null and excluded.avatar_url <> '' then excluded.avatar_url else projects.avatar_url end,
         highest_star = greatest(projects.highest_star, excluded.highest_star),
         highest_common_follow_count = greatest(projects.highest_common_follow_count, excluded.highest_common_follow_count),
         current_common_follow_count = case when $8::boolean then excluded.current_common_follow_count else projects.current_common_follow_count end,
         updated_at = now()
       returning id`,
      [event.xUserId, handle, name, event.avatarUrl ?? null, star, event.commonFollowCount ?? 0, event.commonFollowCount ?? 0, event.commonFollowCount !== undefined]
    );
    const projectId = project.rows[0]?.id;
    if (!projectId) throw new Error(`Project upsert returned no id for ${event.xUserId}`);

    if (handle) {
      await database.query(
        `insert into project_aliases (project_id, handle, display_name, observed_at)
         values ($1, $2, $3, $4) on conflict do nothing`,
        [projectId, handle, name || null, event.occurredAt]
      );
    }
    const signalResult = await database.query<{ id: string }>(
      `insert into signals (raw_event_id, project_id, x_user_id, type, occurred_at, common_follow_count, x_post_url, content, data)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       on conflict (raw_event_id, type) do nothing returning id`,
      [payload.rawEventId, projectId, event.xUserId, event.type, event.occurredAt, event.commonFollowCount ?? null, event.xPostUrl ?? null, event.content ?? null, JSON.stringify(event.payload)]
    );
    const signalId = signalResult.rows[0]?.id ?? (await database.query<{ id: string }>(
      'select id from signals where raw_event_id = $1 and type = $2 limit 1',
      [payload.rawEventId, event.type]
    )).rows[0]?.id;
    if (!signalId) throw new Error(`Signal insert returned no id for ${payload.rawEventId}`);
    if (event.type === 'common_follow' && event.commonFollowCount !== undefined) {
      const observations = await database.query<{ occurred_at: string; common_follow_count: number; id: string }>(
        `select occurred_at, common_follow_count, id
         from signals
         where project_id = $1 and type = 'common_follow' and common_follow_count is not null
           and occurred_at >= $2 and occurred_at <= $3
         order by occurred_at asc`,
        [projectId, new Date(event.occurredAt.getTime() - 30 * 60 * 1000), event.occurredAt]
      );
      const surge = evaluateSurge(observations.rows.map((item) => ({ occurredAt: new Date(item.occurred_at), count: item.common_follow_count, dedupeKey: item.id })), event.occurredAt);
      if (surge.triggered && surge.expiresAt) {
        await database.query(`update projects set surge_until = greatest(coalesce(surge_until, $2), $2), updated_at = now() where id = $1`, [projectId, surge.expiresAt]);
        await database.query(
          `insert into surges (project_id, window_started_at, baseline_count, peak_count, triggered_at, expires_at)
           values ($1, $2, $3, $4, $5, $6) on conflict (project_id, triggered_at) do nothing`,
          [projectId, new Date(event.occurredAt.getTime() - 30 * 60 * 1000), surge.baselineCount, surge.peakCount, surge.triggeredAt, surge.expiresAt]
        );
      }
    }
    await new OutboxStore(database).append({
      type: 'signal.created',
      aggregateType: 'project',
      aggregateId: projectId,
      version: 1,
      payload: { projectId, signalId, signalType: event.type, occurredAt: event.occurredAt.toISOString() },
      idempotencyKey: `signal:${signalId}:website`
    });

    const screening = await database.query<{ id: string; decision: string }>(
      `select id, decision from screening_decisions where project_id = $1 order by created_at desc limit 1`,
      [projectId]
    );
    if (!screening.rows[0]) {
      await new JobStore(database).enqueue({
        type: 'screen_account',
        idempotencyKey: `screen:${projectId}`,
        payload: {
          projectId,
          input: {
            xUserId: event.xUserId,
            handle,
            displayName: name,
            bio: screeningBio(event, profile),
            sourceText: event.content ?? '',
            ...(Number.isFinite(followerCount) && followerCount >= 0 ? { followerCount } : {}),
            ...(typeof profile.verified === 'boolean' ? { verified: profile.verified } : {}),
            ...(handle ? { profileUrl: `https://x.com/${handle.replace(/^@/, '')}` } : {})
          }
        },
        priority: 10
      });
    } else if (screening.rows[0].decision === 'allowed' || screening.rows[0].decision === 'manual_allowed') {
      const current = await database.query<{ highest_star: number; x_user_id: string }>('select highest_star, x_user_id from projects where id = $1', [projectId]);
      const row = current.rows[0];
      if (row && row.highest_star >= 3) {
        await database.query(`update projects set status = 'trench', updated_at = now() where id = $1 and status not in ('excluded', 'dormant')`, [projectId]);
        await ensureTrenchMonitoring(database, projectId, row.x_user_id);
        // A project may have been screened while it was low-star and never
        // received a research job (for example after a worker restart). The
        // first high-star event is a safe idempotent opportunity to schedule
        // the V2 report; JobStore prevents duplicate jobs on later events.
        await new JobStore(database).enqueue({
          type: 'research_project',
          idempotencyKey: `research:${projectId}`,
          payload: { projectId },
          priority: 30
        });
      }
    }
    await database.query('update raw_events set decode_status = $2 where id = $1', [payload.rawEventId, 'decoded']);
  };
}

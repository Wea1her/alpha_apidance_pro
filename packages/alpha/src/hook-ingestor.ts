import { buildAlphaPayloadDedupeKey } from './dedupe-key.js';
import { buildAlphaDedupeKey, decodeAlphaWebhook, type DecodedAlphaEvent } from './event-decoder.js';

export interface AlphaHookDatabase {
  exec(sql: string): Promise<unknown>;
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  transaction?<T>(callback: (database: AlphaHookDatabase) => Promise<T>): Promise<T>;
}

export interface AlphaHookOptions {
  now?: () => Date;
  jobType?: string;
  jobPriority?: number;
}

export interface AlphaHookIngestResult {
  accepted: true;
  duplicate: boolean;
  dedupeKey: string;
  rawEventId?: string;
  decodeStatus: 'decoded' | 'unsupported' | 'invalid';
  decoded?: DecodedAlphaEvent;
}

interface RawEventRow {
  id: string;
}

/**
 * Persists an Alpha Hook payload and schedules decoding without waiting for AI.
 * The raw event and its decode job are committed together, so a successful 2xx
 * response always means the payload is durable.
 */
export class AlphaHookIngestor {
  constructor(
    private readonly database: AlphaHookDatabase,
    private readonly options: AlphaHookOptions = {}
  ) {}

  async ingest(payload: unknown): Promise<AlphaHookIngestResult> {
    const now = this.options.now?.() ?? new Date();
    let decoded: DecodedAlphaEvent | undefined;
    let decodeStatus: AlphaHookIngestResult['decodeStatus'] = 'decoded';
    let decodeError: string | null = null;
    let dedupeKey: string;

    try {
      decoded = decodeAlphaWebhook(payload);
      dedupeKey = buildAlphaDedupeKey(decoded);
      if (decoded.type === 'unknown') decodeStatus = 'unsupported';
    } catch (error) {
      decodeStatus = 'invalid';
      decodeError = error instanceof Error ? error.message : String(error);
      dedupeKey = buildAlphaPayloadDedupeKey(payload);
    }

    const persist = async (database: AlphaHookDatabase): Promise<AlphaHookIngestResult> => {
      const inserted = await database.query<RawEventRow>(
        `insert into raw_events (source, received_at, dedupe_key, payload, decode_status, decode_error)
         values ('alpha_hook', $1, $2, $3::jsonb, $4, $5)
         on conflict (dedupe_key) do nothing
         returning id`,
        [now, dedupeKey, JSON.stringify(payload), decodeStatus === 'decoded' ? 'pending' : decodeStatus, decodeError]
      );

      if (!inserted.rows[0]) {
        return { accepted: true, duplicate: true, dedupeKey, decodeStatus };
      }

      const rawEventId = inserted.rows[0].id;
      if (decodeStatus === 'decoded' && decoded) {
        await database.query(
          `insert into jobs (type, priority, idempotency_key, payload, run_after)
           values ($1, $2, $3, $4::jsonb, $5)
           on conflict (idempotency_key) do nothing`,
          [
            this.options.jobType ?? 'decode_alpha_event',
            this.options.jobPriority ?? 20,
            `decode:${dedupeKey}`,
            JSON.stringify({ rawEventId, event: decoded }),
            now
          ]
        );
      }

      return { accepted: true, duplicate: false, dedupeKey, rawEventId, decodeStatus, decoded };
    };

    if (this.database.transaction) return this.database.transaction(persist);
    return persist(this.database);
  }
}

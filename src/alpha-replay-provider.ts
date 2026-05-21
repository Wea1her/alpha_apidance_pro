export interface AlphaReplayEvent {
  raw: string;
  receivedAt?: Date;
}

export interface AlphaReplayProvider {
  available: boolean;
  reason?: string;
  replaySince(since: Date): Promise<AlphaReplayEvent[]>;
}

export function createUnavailableAlphaReplayProvider(reason: string): AlphaReplayProvider {
  return {
    available: false,
    reason,
    async replaySince() {
      return [];
    }
  };
}

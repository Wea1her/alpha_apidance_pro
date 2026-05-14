export interface StoredAnalysis {
  discussionChatId: string;
  analysisMessageId: number;
}

export class AnalysisTracker {
  private readonly items = new Map<string, StoredAnalysis>();

  get(projectKey: string): StoredAnalysis | null {
    return this.items.get(projectKey) ?? null;
  }

  set(projectKey: string, value: StoredAnalysis): void {
    this.items.set(projectKey, value);
  }
}

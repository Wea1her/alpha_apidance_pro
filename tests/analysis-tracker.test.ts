import { describe, expect, it } from 'vitest';
import { AnalysisTracker } from '../src/analysis-tracker.js';

describe('AnalysisTracker', () => {
  it('stores the first analysis comment and reuses it for future reminders', () => {
    const tracker = new AnalysisTracker();

    expect(tracker.get('project-a')).toBeNull();

    tracker.set('project-a', {
      discussionChatId: '-1003769834276',
      analysisMessageId: 777
    });

    expect(tracker.get('project-a')).toEqual({
      discussionChatId: '-1003769834276',
      analysisMessageId: 777
    });
  });
});

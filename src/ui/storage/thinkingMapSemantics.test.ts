import { describe, expect, it } from 'vitest';
import { mapThinkingMapSemanticSnapshot } from './thinkingMapSemantics';

describe('mapThinkingMapSemanticSnapshot', () => {
  it('maps session ids, filters invalid endpoints, and reports browser coverage', () => {
    const result = mapThinkingMapSemanticSnapshot(
      {
        phase: 'ready',
        edges: [
          { sourceSessionId: 's2', targetSessionId: 's1', weight: 1.4 },
          { sourceSessionId: 'missing', targetSessionId: 's1', weight: 0.8 },
          { sourceSessionId: 's1', targetSessionId: 's1', weight: 0.9 },
        ],
        indexedSessionIds: ['s1'],
        activeIndexVersion: 'active',
      },
      new Map([[10, 's1'], [20, 's2']]),
      4,
    );

    expect(result).toEqual({
      phase: 'ready',
      edges: [{ source: 10, target: 20, weight: 1 }],
      coverage: {
        indexed: 1,
        supported: 2,
        total: 4,
        unsupportedBrowser: 2,
      },
      activeIndexVersion: 'active',
    });
  });

  it('returns an unavailable snapshot without losing supported-node counts', () => {
    expect(mapThinkingMapSemanticSnapshot(null, new Map([[10, 's1']]), 3)).toEqual({
      phase: 'unavailable',
      edges: [],
      coverage: {
        indexed: 0,
        supported: 1,
        total: 3,
        unsupportedBrowser: 2,
      },
      activeIndexVersion: null,
    });
  });
});

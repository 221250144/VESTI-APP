import type { ThinkingMapSemanticSnapshot } from '@vesti/ui';
import type { ThinkingMapSemanticIpcSnapshot } from '../../shared/contracts';

/** Internal adapter seam: raw desktop session ids become renderer ids here. */
export function mapThinkingMapSemanticSnapshot(
  result: ThinkingMapSemanticIpcSnapshot | null,
  sessionIdByConversationId: ReadonlyMap<number, string>,
  total: number,
): ThinkingMapSemanticSnapshot {
  const supported = sessionIdByConversationId.size;
  const unavailable = (): ThinkingMapSemanticSnapshot => ({
    phase: 'unavailable',
    edges: [],
    coverage: {
      indexed: 0,
      supported,
      total,
      unsupportedBrowser: Math.max(0, total - supported),
    },
    activeIndexVersion: null,
  });
  if (!result) return unavailable();

  const conversationIdBySessionId = new Map<string, number>();
  [...sessionIdByConversationId.entries()]
    .sort(([left], [right]) => left - right)
    .forEach(([conversationId, sessionId]) => {
      if (!conversationIdBySessionId.has(sessionId)) {
        conversationIdBySessionId.set(sessionId, conversationId);
      }
    });
  const indexed = new Set(result.indexedSessionIds);
  const edges = result.edges.flatMap((edge) => {
    const source = conversationIdBySessionId.get(edge.sourceSessionId);
    const target = conversationIdBySessionId.get(edge.targetSessionId);
    if (
      source === undefined
      || target === undefined
      || source === target
      || !Number.isFinite(edge.weight)
    ) {
      return [];
    }
    return [{
      source: Math.min(source, target),
      target: Math.max(source, target),
      weight: Math.max(0, Math.min(1, edge.weight)),
    }];
  });

  return {
    phase: result.phase,
    edges,
    coverage: {
      indexed: [...sessionIdByConversationId.values()]
        .filter((sessionId) => indexed.has(sessionId)).length,
      supported,
      total,
      unsupportedBrowser: Math.max(0, total - supported),
    },
    activeIndexVersion: result.activeIndexVersion,
  };
}

import type { SearchReadiness } from "../types";

const SINGLE_CJK_QUERY_PATTERN =
  /^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]$/u;

export function normalizeSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function getSearchReadiness(query: string): SearchReadiness {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) {
    return "empty";
  }

  if (normalizedQuery.length === 1) {
    return SINGLE_CJK_QUERY_PATTERN.test(normalizedQuery)
      ? "fulltext"
      : "title_snippet_only";
  }

  return "fulltext";
}

export function shouldRunFullTextSearch(query: string): boolean {
  return getSearchReadiness(query) === "fulltext";
}

export function shouldHighlightSearchQuery(query: string): boolean {
  return getSearchReadiness(query) !== "empty";
}

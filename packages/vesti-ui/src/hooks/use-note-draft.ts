import { useEffect, useMemo, useRef, useState } from "react";
import type { Note } from "../types";
import { extractFrontmatterTitle, hasLeadingFrontmatter, resolveDisplayedNoteTitle, updateFrontmatterTitle } from "../lib/note-markdown";

export type NoteSaveStatus = "saved" | "saving" | "unsaved";

type PersistNoteDraft = (
  noteId: number,
  changes: { title?: string; content?: string },
) => Promise<Note>;

type UseNoteDraftOptions = {
  note: Note | null;
  persistNote?: PersistNoteDraft;
  debounceMs?: number;
};

type DraftContentUpdater = string | ((current: string) => string);

function sameDraft(note: Note, title: string, content: string): boolean {
  return note.title === title && note.content === content;
}

export function useNoteDraft({
  note,
  persistNote,
  debounceMs = 750,
}: UseNoteDraftOptions) {
  const [standaloneTitle, setStandaloneTitle] = useState("");
  const [content, setContentState] = useState("");
  const [saveStatus, setSaveStatus] = useState<NoteSaveStatus>("saved");
  const baselineRef = useRef<Note | null>(null);
  const timerRef = useRef<number | null>(null);
  const flushingRef = useRef<Promise<Note | null> | null>(null);

  const title = useMemo(
    () => resolveDisplayedNoteTitle(content, standaloneTitle),
    [content, standaloneTitle],
  );
  const hasFrontmatterTitle = useMemo(
    () => Boolean(extractFrontmatterTitle(content)),
    [content],
  );

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    const baseline = baselineRef.current;
    if (
      baseline &&
      note &&
      baseline.id === note.id &&
      baseline.updated_at === note.updated_at &&
      baseline.title === note.title &&
      baseline.content === note.content
    ) {
      return;
    }

    baselineRef.current = note;
    clearTimer();
    setStandaloneTitle(note?.title ?? "");
    setContentState(note?.content ?? "");
    setSaveStatus("saved");
  }, [note]);

  const flush = async (): Promise<Note | null> => {
    clearTimer();

    const baseline = baselineRef.current;

    if (!baseline || !persistNote) {
      setSaveStatus("saved");
      return null;
    }

    const currentTitle = resolveDisplayedNoteTitle(content, standaloneTitle);
    if (sameDraft(baseline, currentTitle, content)) {
      setSaveStatus("saved");
      return baseline;
    }

    if (flushingRef.current) {
      return flushingRef.current;
    }

    setSaveStatus("saving");
    const pending = persistNote(baseline.id, {
      title: currentTitle,
      content,
    })
      .then((updated) => {
        baselineRef.current = updated;
        setStandaloneTitle(updated.title);
        setContentState(updated.content);
        setSaveStatus("saved");
        return updated;
      })
      .catch((error) => {
        console.error("[notes] persistNote failed", error);
        setSaveStatus("unsaved");
        return null;
      })
      .finally(() => {
        flushingRef.current = null;
      });

    flushingRef.current = pending;
    return pending;
  };

  useEffect(() => {
    const baseline = baselineRef.current;

    if (!baseline || !persistNote) {
      clearTimer();
      setSaveStatus("saved");
      return;
    }

    const currentTitle = resolveDisplayedNoteTitle(content, standaloneTitle);
    if (sameDraft(baseline, currentTitle, content)) {
      clearTimer();
      setSaveStatus("saved");
      return;
    }

    setSaveStatus("unsaved");
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      void flush();
    }, debounceMs);

    return () => clearTimer();
  }, [content, debounceMs, note, persistNote, standaloneTitle]);

  useEffect(() => () => clearTimer(), []);

  const setTitle = (nextTitle: string) => {
    setStandaloneTitle(nextTitle);
    setContentState((current) => {
      if (!hasLeadingFrontmatter(current)) {
        return current;
      }

      return updateFrontmatterTitle(current, nextTitle);
    });
  };

  const setContent = (nextContent: DraftContentUpdater) => {
    const resolvedContent =
      typeof nextContent === "function" ? nextContent(content) : nextContent;

    if (resolvedContent === content) {
      return;
    }

    const nextFrontmatterTitle = extractFrontmatterTitle(resolvedContent);
    if (nextFrontmatterTitle) {
      setStandaloneTitle(nextFrontmatterTitle);
    } else if (!hasLeadingFrontmatter(resolvedContent)) {
      setStandaloneTitle((currentTitle) => {
        if (currentTitle.trim()) {
          return currentTitle;
        }

        return baselineRef.current?.title ?? "";
      });
    }
    setContentState(resolvedContent);
  };

  return {
    title,
    standaloneTitle,
    content,
    saveStatus,
    hasFrontmatterTitle,
    setTitle,
    setContent,
    flush,
  };
}

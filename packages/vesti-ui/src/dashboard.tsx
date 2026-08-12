"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Database,
  Loader2,
  Moon,
  RefreshCw,
  Settings,
  Sun,
  X,
} from "lucide-react";
import { DataManagementPanel } from "./components/DataManagementPanel";
import { LibraryDataProvider } from "./contexts/library-data";
import { ExploreTab } from "./tabs/explore-tab";
import { AitiCard } from "./components/AitiCard";
import { LearnCard } from "./components/LearnCard";
import { RoundtablePanel } from "./components/RoundtablePanel";
import { learnTopicSuggestions } from "./lib/learnTopics";
import { DepositsTab } from "./tabs/deposits-tab";
import { DailyTab } from "./tabs/daily-tab";
import { LibraryTab } from "./tabs/library-tab";
import { NetworkTab } from "./tabs/network-tab";
import { PromptsTab } from "./tabs/prompts-tab";
import type { AitiImagery, AitiProfile, CompanionOwlIcons, DashboardLabels, LearnProfile, PlazaData, StorageApi, SummaryBatchState, SummaryCoverage, UiThemeMode } from "./types";
import type { NotionDatabaseOption, NotionSettings } from "./notion-integration";
import {
  advanceSummaryBatch,
  createSummaryBatchProgress,
  planSummaryBatch,
} from "./lib/summaryBatch";
import {
  connectToNotion,
  disconnectNotion,
  formatNotionErrorMessage,
  getNotionSettings,
  isNotionConnected,
  isNotionExportConfigured,
  listNotionDatabases,
  selectNotionDatabase,
} from "./notion-integration";

export type Tab = "library" | "explore" | "network" | "prompts" | "deposits" | "daily";
type DrawerView = "settings" | "data";
type ReturnTab = Exclude<Tab, "library">;
type ExploreSubMode = "ask" | "aiti" | "learn" | "roundtable";
type DashboardNavRequest = {
  tab?: unknown;
  requestedAt?: unknown;
};
type ThemeSyncStatus = "idle" | "syncing" | "error";

const DASHBOARD_NAV_REQUEST_KEY = "vesti_dashboard_open_tab";
/** Explore pill 选择记忆: reopening the app returns to the last sub-mode. */
const EXPLORE_MODE_STORAGE_KEY = "vesti.explore.mode";

function readStoredExploreMode(): ExploreSubMode {
  if (typeof window === "undefined") return "ask";
  const raw = window.localStorage.getItem(EXPLORE_MODE_STORAGE_KEY);
  return raw === "ask" || raw === "aiti" || raw === "learn" || raw === "roundtable"
    ? raw
    : "ask";
}

const DEFAULT_LABELS: DashboardLabels = {
  tabs: { library: "LIBRARY", explore: "EXPLORE", network: "KNOWLEDGE GRAPH", prompts: "PROMPTS", deposits: "MEMORY SPACE", daily: "DAILY" },
  nav: {
    backToExplore: "Back to Explore",
    backToNetwork: "Back to Knowledge Graph",
    dashboardSections: "Dashboard sections",
    closeDrawer: "Close drawer backdrop",
  },
  settings: {
    settings: "Settings",
    dataOperations: "Data Operations",
    appearance: "Appearance",
    modelIntegration: "Model / Integration",
    themeShared: "Shared with dock appearance.",
    themeSharedDark: "Dark mode is active.",
    themeSharedLight: "Light mode is active.",
    syncingAppearance: "Syncing appearance...",
    changesStayInSync: "Changes here stay in sync with the dock settings panel.",
    modelscopeKeyPlaceholder: "Paste your ModelScope key",
    savedLocally: "Saved locally",
    saveFailed: "Save failed",
    storedInChromeStorage: "Stored in chrome.storage.local",
    availableInExtension: "Available in extension only",
    notionWorkspaceConnected: "Notion workspace connected",
    connectToNotion: "Connect to Notion",
    legacyToken: "Legacy token detected. Reconnect to upgrade to official OAuth.",
    oauthFlowDesc: "Opens the official Notion authorization flow.",
    connecting: "Connecting...",
    change: "Change",
    connect: "Connect",
    searchSharedDatabases: "Search shared databases",
    loadingSharedDatabases: "Loading shared databases...",
    noDatabasesLoaded: "No databases loaded yet.",
    chooseDatabase: "Choose a database to enable export",
    actionFailed: "Action failed",
    notionConnected: "Notion connected.",
    notionDisconnected: "Notion disconnected.",
    settingsSaved: "Saved locally",
    manageIntegrationKeys: "Manage dashboard-only integration keys.",
    modelscopeKeyLabel: "ModelScope Key",
    save: "Save",
    notionExportTitle: "Notion Export",
    notionExportDesc: "Connect with Notion and choose the database used for annotation export.",
    connectedChooseDatabase: "Connected. Choose the database used for one-shot exports.",
    oauthUnavailableOutsideExtension: "OAuth login is unavailable outside the extension build.",
    disconnect: "Disconnect",
    targetDatabase: "Target Database",
    databaseSearchPlaceholder: "Search shared databases",
    refresh: "Refresh",
    shareDatabaseHint: "Share the database with your Notion integration, then refresh if it does not appear yet.",
    selectedColon: "Selected: ",
    readyForOneShotExport: "Ready for one-shot export",
    noSharedDatabasesFound: "No shared databases found yet. Share the database with the integration, then refresh.",
    selectedDatabaseMessage: "Selected {title}.",
    themeUpdateFailed: "Theme update failed.",
  },
  library: {
    allConversations: "All Conversations",
    starred: "Starred",
    recent: "Recent",
    folders: "FOLDERS",
    myNotes: "My Notes",
    exporting: "Exporting...",
    notion: "Notion",
    general: "General",
    libraryNavigation: "Library navigation",
    conversationCount: "conversations",
    noMessages: "No messages captured yet.",
    loadingMessages: "Loading messages...",
    you: "You",
    untitled: "Untitled",
    newNote: "New Note",
    saving: "Saving...",
    unsavedChanges: "Unsaved changes",
    noNoteYet: "No note yet",
    deleteNote: "Delete note",
    exitSplitView: "Exit split view",
    deleteNotAvailable: "Delete is not available yet.",
    renameNotAvailable: "Renaming is not available yet.",
    deleteFolderNotAvailable: "Deleting folders is not available yet.",
    renameFolderFailed: "Failed to rename folder.",
    deleteFolderFailed: "Failed to delete folder.",
    updateStarFailed: "Failed to update star.",
    renameConversationFailed: "Failed to rename conversation.",
    newFolderPrompt: "New folder name",
    renameFolderPrompt: "Rename folder",
    renameConversationPrompt: "Rename conversation",
    deleteConversationLabel: "Delete conversation",
    initiatingPipeline: "Initiating pipeline...",
    extractingCore: "Extracting core question...",
    generatingInsights: "Generating insights...",
    savingSummary: "Saving summary...",
    loadRelatedFailed: "Failed to load related conversations",
    loadMessagesFailed: "Failed to load messages",
    directoryExportNotSupported: "This browser surface does not support local directory export.",
    directorySelectionCancelled: "Directory selection was cancelled.",
    saveBeforeExport: "Save the current note before exporting it.",
    exportFailed: "Could not export this note to Obsidian.",
    analyzed: "Analyzed",
    notAnalyzedYet: "Not analyzed yet",
    summary: "Summary",
    noSummaryYet: "No summary yet. Generate one to see structured insights.",
    generateSummary: "Generate Summary",
    regenerate: "Regenerate",
    importToNotes: "Import to Notes",
    viewNote: "View Note",
    originalConversation: "Original Conversation",
    preview: "Preview",
    messageCountLabel: "messages",
    showOriginalMessages: "Show original messages",
    hideOriginalMessages: "Hide original messages",
    loadingOriginalConversation: "Loading original conversation...",
    messagesAvailableButEmpty: "Messages are available, but preview text is empty.",
    openOriginal: "Open",
    splitView: "Split View",
    openSplitView: "Open split view",
    exitSplit: "Exit Split",
    conversationNote: "Conversation Note",
    updatedAt: "Updated",
    updatedAtTime: "Updated {time}",
    notesForPrefix: "Notes for: {title}",
    linkedConversations: "Linked Conversations",
    noLinkedConversations: "No linked conversations",
    open: "Open",
    focusNote: "Focus Note",
    noNoteLinkedYet: "No note linked yet",
    startExtractingHint: "Start extracting from the reader or create a conversation note to keep your reading and writing side by side.",
    startWritingPlaceholder: "Start writing...",
    createConversationNote: "Create Conversation Note",
    extractedExcerptsPlaceholder: "Extracted excerpts and your notes will appear here...",
    relatedConversations: "Related Conversations",
    findingRelated: "Finding related conversations...",
    noRelatedConversations: "No related conversations yet.",
    unableToLoadRelated: "Unable to load related conversations.",
    relatedNotes: "Related Notes",
    addAnnotation: "Add annotation",
    openAnnotation: "Open annotation",
    annotation: "Comment",
    annotationCount: "1 annotation",
    annotationsCount: "{count} annotations",
    deleteThisComment: "Delete this comment?",
    deleting: "Deleting...",
    cancel: "Cancel",
    commentPlaceholder: "Comment...",
    commentsUnavailable: "Comments are unavailable in this build.",
    couldNotSaveComment: "Couldn't save this comment.",
    couldNotDeleteComment: "Couldn't delete this comment.",
    myNotesExportUnavailable: "My Notes export is not available in this build.",
    savedToMyNotes: "Saved to My Notes.",
    couldNotExportToMyNotes: "Couldn't export this comment to My Notes.",
    notionExportUnavailable: "Notion export is not available in this build.",
    sentToNotion: "Sent to Notion.",
    notionSettingsMissing: "Connect to Notion and choose a database in Settings before exporting.",
    notionReconnectRequired: "Your Notion session expired. Reconnect in Settings and try again.",
    couldNotExportToNotion: "Couldn't export this comment to Notion.",
    addedOn: "Added on",
    dayAfter: "day",
    daysAfter: "days",
    afterTheConversation: "after the conversation",
    unknownTime: "Added at an unknown time",
    localNote: "Local",
    obsidianNote: "Obsidian",
    noExcerptYet: "No excerpt yet.",
    conflict: "Conflict",
    vaultPath: "Vault Path",
    sourceHash: "Source Hash",
    unknown: "Unknown",
    unavailable: "Unavailable",
    attachments: "Attachments",
    attachmentPreview: "Attachment Preview",
    previewAvailableForImages: "Preview is available for imported images.",
    useOpenForOtherAttachments: "Use Open for other attachment types.",
    importMetadata: "Import Metadata",
    exportToObsidian: "Export to Obsidian",
    choosingFolder: "Choosing Folder...",
    notesWorkspace: "Notes Workspace",
    selectNoteToEdit: "Select a note to start editing",
    localNotesAndObsidianShareEditor: "Local notes and imported Obsidian files now share the same Markdown editor surface.",
    loadingNotes: "Loading notes...",
    createLocalNoteHint: "Create a local note, then export it to an Obsidian folder whenever you are ready.",
    createNote: "Create a note",
    localNotes: "Local Notes",
    noLocalNotesYet: "No local notes yet.",
    importedVaults: "Imported Vaults",
    renameNote: "Rename Note",
    updateNoteTitle: "Update the title for this note.",
    noteTitlePlaceholder: "Note title",
    deleteNoteConfirm: "Delete note",
    deleteConversationConfirm: "Delete this conversation?",
    deleteFolderConfirm: "Delete folder",
    star: "Star",
    unstar: "Unstar",
    rename: "Rename",
    changeFolder: "Change folder",
    removeFromFolder: "Remove from folder",
    delete: "Delete",
    folderActions: "Folder actions",
    createNewFolder: "Create new folder",
    newFolder: "New folder",
    conversationActions: "Conversation actions",
    extract: "Extract",
    justNow: "just now",
    minutesAgo: "m ago",
    hoursAgo: "h ago",
    daysAgo: "d ago",
    monthsAgo: "mo ago",
    yearsAgo: "y ago",
    sourceFileChangedAfterEdits: "Source file changed after local edits. Re-import skipped to avoid overwriting this note.",
    dateUnknown: "Unknown date",
    frontmatter: "Frontmatter",
    chooseConversationsTitle: "Choose Conversations",
    chooseConversationsDesc: "Search, preview, and pick the conversations the agent is allowed to use.",
    applySelected: "Apply Selected",
    useAll: "Use All",
    noSearchResults: "No conversations match this search.",
    noPreviewAvailable: "No preview available",
    closeSidebar: "Close sidebar",
    openSidebar: "Open sidebar",
    emptyDetailTitle: "Select a conversation",
    emptyDetailHint: "Choose a conversation from the list to read it here.",
    summaryCard: {
      coreQuestion: "Core Question",
      thinkingJourney: "Thinking Journey",
      step: "Step",
      example: "Example",
      keyInsights: "Key Insights",
      unresolvedThreads: "Unresolved Threads",
      metaObservations: "Meta Observations",
      thinkingStyle: "Thinking Style",
      emotionalTone: "Emotional Tone",
      depth: "Depth",
      nextSteps: "Next Steps",
      fallback: "Fallback summary",
    },
    moveToTopic: "Move to topic",
    noTopic: "No topic",
    sourceTree: {
      sectionLabel: "SOURCES",
      notes: "My Notes",
      browser: "Browser",
      wslBadge: "WSL",
    },
    organize: {
      button: "Organize",
      title: "Organize library",
      subtitle: "Local rules only — nothing leaves this device.",
      actionEmpty: "Clean empty conversations",
      actionEmptyDesc: "Trash conversations with no captured messages.",
      actionDuplicates: "Merge duplicate candidates",
      actionDuplicatesDesc: "Find cross-source duplicates; keep the most complete copy.",
      actionTag: "Batch tag",
      actionTagDesc: "Add a tag to every conversation in a scope.",
      actionArchive: "Batch archive to topic",
      actionArchiveDesc: "Move conversations in a project or time window into a topic.",
      back: "Back",
      previewAffected: "{count} conversations affected",
      previewEmpty: "Nothing matches this rule right now.",
      previewMore: "…and {count} more",
      confirm: "Apply",
      executing: "Applying…",
      done: "Done — {count} conversations updated.",
      failed: "Failed: {message}",
      cancel: "Cancel",
      close: "Close",
      tagLabel: "Tag to add",
      tagPlaceholder: "e.g. paper-reading",
      archiveTarget: "Move into topic",
      archiveNoTopic: "No topic",
      scopeAll: "Scope: all conversations",
      scopeSelection: "Scope: current selection",
      scopeOlder30: "Inactive 30+ days",
      scopeOlder90: "Inactive 90+ days",
      keepLabel: "keep",
      dropLabel: "{count} to trash",
      reasonSameSource: "Same capture id from multiple sources",
      reasonSameTitle: "Identical title from multiple sources",
      unavailable: "Not available in this build.",
    },
  },
  explore: {
    chooseConversationsTitle: "Choose Conversations",
    chooseConversationsDesc: "Search, preview, and pick the conversations the agent is allowed to use.",
    applySelected: "Apply Selected",
    useAll: "Use All",
    noSearchResults: "No conversations match this search.",
    noPreviewAvailable: "No preview available",
    closeSidebar: "Close sidebar",
    openSidebar: "Open sidebar",
    noConversationsSelected: "0 conversations selected",
    oneConversationSelected: "1 conversation selected",
    multipleConversationsSelected: "{count} conversations selected",
    newChat: "New Chat",
    noConversationsYet: "No conversations yet",
    libraryEmptyTitle: "Nothing to recall yet",
    libraryEmptyHint: "Sync your AI sessions first, then come back — answers are recalled across your conversation library and cited with sources.",
    today: "Today",
    yesterday: "Yesterday",
    earlier: "Earlier",
    agent: "Agent",
    classic: "Classic",
    all: "All",
    selected: "Selected",
    allConversations: "All conversations",
    send: "Send",
    starterPrompts: "Starter prompts",
    choosePromptHint: "Choose one to populate the composer, then edit it before sending.",
    loadingStarterIdeas: "Loading starter ideas",
    starterDeckReady: "Starter deck ready",
    cardsUpdateHint: "Cards update on every new chat.",
    askPlaceholder: "Ask your knowledge base, summarize a week, or trace a decision trail...",
    askAgentPlaceholder: "Ask your knowledge base (Agent mode)...",
    askClassicPlaceholder: "Ask your knowledge base (Classic mode)...",
    agentModeDesc: "Agent mode shows the planner route, tool calls, source controls, and editable context drafts.",
    classicModeDesc: "Classic mode searches your history and returns concise source-grounded answers.",
    newChatPrefill: "New Chat (Prefill)",
    searchByTitlePlaceholder: "Search by title or snippet...",
    fillComposer: "FILL COMPOSER",
    starterDeck1Eyebrow: "Start with a task",
    starterDeck1Title: "Explore your library with a lighter touch.",
    starterDeck1Description: "Ask a focused question, then let Explore search, summarize, and stitch together the minimal context needed.",
    starterDeck2Eyebrow: "Private by default",
    starterDeck2Title: "Ask for the shape of the work, not the whole transcript.",
    starterDeck2Description: "Explore is most useful when it compresses a library into a narrow, trustworthy answer you can inspect.",
    starterDeck3Eyebrow: "Work in layers",
    starterDeck3Title: "Start broad, then narrow to the sources that matter.",
    starterDeck3Description: "Use a starter prompt to get a compact answer, then inspect the source conversations if you need verification.",
    modeStages: {
      agent: [
        "Understanding your question...",
        "Recalling relevant sessions...",
        "Organizing recalled sources...",
        "Generating the answer from sources...",
        "Polishing the final answer...",
      ],
      classic: [
        "Understanding your question...",
        "Searching indexed context...",
        "Synthesizing a longer answer...",
      ],
    },
    starterDecks: [
      {
        eyebrow: "Start with a task",
        title: "Explore your library with a lighter touch.",
        description: "Ask a focused question, then let Explore search, summarize, and stitch together the minimal context needed.",
        privacyTip: "Keep prompts narrow. Ask for themes, decisions, or one time window instead of raw transcripts.",
        capabilityHint: "Summaries, weekly digests, and source-grounded answers are all available here.",
        prompts: [
          {
            title: "Summarize this week",
            prompt: "Summarize what I worked on this week and highlight the main decisions.",
            detail: "Great for rolling up a recent batch of conversations into a concise review.",
          },
          {
            title: "Find the decision trail",
            prompt: "Show the conversations that explain how we reached the final decision.",
            detail: "Use this when you want the context behind a conclusion, not just the conclusion.",
          },
          {
            title: "Group related threads",
            prompt: "Group the most related conversations about this topic and explain why they belong together.",
            detail: "Useful for clustering a topic without exposing the full raw conversation history.",
          },
          {
            title: "Build a quick brief",
            prompt: "Create a short brief from the most relevant conversations and keep it source-grounded.",
            detail: "A compact starting point when you want a clean handoff or a summary note.",
          },
        ],
      },
      {
        eyebrow: "Private by default",
        title: "Ask for the shape of the work, not the whole transcript.",
        description: "Explore is most useful when it compresses a library into a narrow, trustworthy answer you can inspect.",
        privacyTip: "Favor descriptors like themes, blockers, or outcomes. Avoid asking for everything at once.",
        capabilityHint: "You can search across all conversations or a selected subset, then refine sources afterward.",
        prompts: [
          {
            title: "What changed?",
            prompt: "What changed across my conversations over the last week?",
            detail: "A safe way to surface progress without pulling in more than you need.",
          },
          {
            title: "Cluster the blockers",
            prompt: "Cluster the repeated blockers or open questions across my conversations.",
            detail: "Helps reveal recurring pain points and where the discussion kept circling back.",
          },
          {
            title: "Trace one topic",
            prompt: "Trace the main discussion around privacy or search and summarize the arc.",
            detail: "Good for following a single thread through multiple conversations.",
          },
          {
            title: "Surface next steps",
            prompt: "Surface the next actions implied by the most relevant conversations.",
            detail: "Turns scattered discussion into a practical follow-up list.",
          },
        ],
      },
      {
        eyebrow: "Work in layers",
        title: "Start broad, then narrow to the sources that matter.",
        description: "Use a starter prompt to get a compact answer, then inspect the source conversations if you need verification.",
        privacyTip: "Short prompts usually reveal less than a fully detailed request, which helps keep exploration focused.",
        capabilityHint: "Ask for weekly summaries, cross-conversation themes, or a source list you can inspect manually.",
        prompts: [
          {
            title: "Weekly recap",
            prompt: "Give me a compact weekly recap with the main themes and follow-ups.",
            detail: "Designed for a weekly digest that stays concise but still useful.",
          },
          {
            title: "Theme map",
            prompt: "Map the main themes across my conversations about architecture and tooling.",
            detail: "Useful when the goal is to understand the library at a higher level first.",
          },
          {
            title: "Evidence first",
            prompt: "List the most relevant conversations for this topic and summarize each one briefly.",
            detail: "A good bridge between search and review when you want a source-backed answer.",
          },
          {
            title: "Decision summary",
            prompt: "Summarize the decision and the evidence that led to it.",
            detail: "Short, inspectable, and suitable for quick handoff notes.",
          },
        ],
      },
    ],
    libraryStarter: {
      titleTemplate: 'Continue "{cue}"',
      promptTemplate: 'Continue "{cue}" and search the related context before summarizing the key points.',
      detail: "Built from recent library cues using only lightweight title and snippet context.",
    },
    toolLabels: {
      intent_planner: "Intent Planner",
      time_scope_resolver: "Time Scope Resolver",
      weekly_summary_tool: "Weekly Summary Tool",
      query_planner: "Query Planner (Legacy)",
      search_rag: "Semantic Search",
      summary_tool: "Summary Tool",
      context_compiler: "Context Compiler",
      answer_synthesizer: "Answer Synthesizer",
    },
    toolExplanations: {
      intent_planner: "Uses the model to decide what the user is asking for, which route to run, and whether a time window is required.",
      time_scope_resolver: "Turns phrases like 'this week' into a concrete date range so the answer is auditable.",
      weekly_summary_tool: "Finds the conversations in that period, then reuses or generates a week-level digest.",
      query_planner: "Legacy fixed planning step from the earlier Explore pipeline.",
      search_rag: "Searches the knowledge base by semantic similarity to retrieve the most relevant conversations.",
      summary_tool: "Fills in missing conversation summaries so multi-source answers are easier to synthesize and inspect.",
      context_compiler: "Builds the editable context draft and source set shown in the drawer.",
      answer_synthesizer: "Produces the final answer from the collected evidence and tells the user where to inspect the result.",
    },
    intentLabels: {
      fact_lookup: "Fact Lookup",
      cross_conversation_summary: "Cross-Conversation Summary",
      weekly_review: "Weekly Review",
      timeline: "Timeline",
      clarification_needed: "Clarification Needed",
    },
    pathLabels: {
      rag: "Semantic Search",
      weekly_summary: "Weekly Summary",
      clarify: "Clarify First",
    },
    toolStatus: {
      running: "running",
      completed: "completed",
      failed: "failed",
    },
    inRange: "In range",
    unknown: "Unknown",
    unavailable: "Unavailable",
    noToolCalls: "No tool calls",
    toolCallsSummary: "{count} steps · {seconds}s",
    toolCallsSummaryFailed: "{count} steps · {failed} failed · {seconds}s",
    stepsLabel: "steps",
    failedLabel: "failed",
    untitled: "untitled",
    you: "You",
    assistantName: "Vesti",
    plan: "Plan",
    toolCalls: "Tool Calls",
    intentPrefix: "Intent:",
    routePrefix: "Route:",
    scopePrefix: "Scope:",
    timePrefix: "Time:",
    currentScopePrefix: "Current scope:",
    sourceControls: "Source Controls",
    openContextDraft: "Open Context Draft",
    sources: "Sources",
    noRelevantConversations: "No relevant conversations found",
    refreshingSuggestions: "Refreshing suggestions...",
    open: "Open",
    failedToLoadConversations: "Failed to load conversations.",
    exploreUnavailable: "Explore is unavailable in the current environment.",
    chooseAtLeastOne: "Choose at least one conversation before using Selected scope.",
    failedToRetrieveAnswer: "Failed to retrieve answer.",
    deleteConversationConfirm: "Delete this conversation?",
    contextDraftSaved: "Context draft saved.",
    savedLocally: "Saved locally for this view (storage adapter unavailable).",
    failedToSaveContext: "Failed to save context draft.",
    copiedToClipboard: "Copied to clipboard.",
    clipboardUnavailable: "Clipboard is unavailable in this environment.",
    downloaded: "Downloaded {filename}.",
    selectAtLeastOneSource: "Select at least one source before regenerating.",
    couldNotDetermineQuery: "Could not determine the query for this answer.",
    regeneratedNotice: "Regenerated as a new turn using {count} selected source(s).",
    failedToRegenerate: "Failed to regenerate answer.",
    dismiss: "Dismiss",
    untitledSession: "Untitled",
    noMessages: "No messages",
    rename: "Rename",
    delete: "Delete",
    inputLabel: "Input:",
    outputLabel: "Output:",
    errorLabel: "Error:",
    resizeSidebarAria: "Resize Explore sidebar",
    resizeDrawerAria: "Resize Explore details drawer",
    executionDetails: "Execution Details",
    contextDraft: "Context Draft",
    plannerDecision: "Planner Decision",
    sourceLimitPrefix: "Source limit:",
    summaryTargetPrefix: "Summary target:",
    timeScopePrefix: "Time scope:",
    whyThisRoute: "Why This Route",
    goalPrefix: "Goal:",
    clarificationPrefix: "Clarification:",
    plannedTools: "Planned Tools",
    plannerFootnote: "The planner chooses the high-level route with the model. Tool execution stays bounded and inspectable in the app.",
    noPlannerMetadata: "No planner metadata was recorded for this answer.",
    noToolCallsRecorded: "No tool calls were recorded for this answer.",
    activeQuery: "Active Query",
    selectedSourcesPrefix: "Selected sources:",
    candidateSources: "Candidate Sources",
    noContextCandidates: "No context candidates for this answer.",
    saving: "Saving...",
    saveSelection: "Save Selection",
    regenerateAnswer: "Regenerate Answer",
    openDraft: "Open Draft",
    regenerationFootnote: "Regeneration appends a new turn using only the selected conversations.",
    draftEditable: "Draft (Editable)",
    save: "Save",
    copy: "Copy",
    downloadTxt: "Download TXT",
    companion: {
      title: "Night Talk",
      subtitle: "The owl remembers what you've said.",
      personaLabel: "Persona",
      personaListener: "Listener",
      personaCreator: "Creator",
      scopeLabel: "Memory sense",
      scopeFull: "Full sense",
      scopeMemory: "Memory space only",
      scopeChat: "This chat only",
      scopeFullHint: "Night Talk draws on your long-term memories, deposits, and related past conversations.",
      scopeMemoryHint: "Night Talk only uses your memory space — no conversation recall.",
      scopeChatHint: "Night Talk only sees this conversation; your memory space stays untouched.",
      newChat: "New Night Talk",
      emptyTitle: "Tell me something",
      emptyBody: "I remember all your conversations — the wins, the stuck points, the half-formed 2am ideas.",
      inputPlaceholder: "Say something to Night Talk… (Enter to send, Shift+Enter for a new line)",
      send: "Send",
      thinking: "Night Talk is thinking…",
      errorTitle: "Night Talk couldn't catch that one",
    },
  },
  data: {
    title: "Data Management",
    unavailableTitle: "Data operations unavailable",
    unavailableDesc: "This environment does not provide export/clear/storage APIs.",
    usedAppLimit: "Used / App limit (1GB)",
    unknown: "Unknown",
    browserQuota: "Browser quota",
    healthy: "Healthy",
    softLimitWarning: "Soft limit warning",
    writeBlocked: "Write blocked",
    storageWarning: "Storage crossed 900MB. Export or clear old data soon.",
    storageBlocked: "Storage reached 1GB. New writes are blocked until you export or clear data.",
    advancedStorageDetails: "Advanced storage details (Chrome)",
    chromeStorageUsed: "chrome.storage.local used",
    estimatedIndexedDb: "Estimated IndexedDB + other",
    softLimit: "Soft limit",
    unlimitedStorage: "unlimitedStorage",
    enabled: "enabled",
    disabled: "disabled",
    exportLocalData: "Export local data",
    exportFormat: "Export {format}",
    exportHint: "JSON is reversible and includes summaries + weekly caches. TXT/MD are human-readable exports.",
    dangerZone: "Danger zone",
    dangerDesc: "Clears all conversations, messages, cached summaries, and weekly reports. LLM configuration remains unchanged.",
    clearLocalData: "Clear local data",
    clearPrompt: "This will clear all local conversations and cached insights.\\nType DELETE to continue:",
    clearCancelled: "Clear cancelled.",
    localDataCleared: "Local data cleared. LLM configuration is kept.",
    exportedFile: "Exported {filename}",
    runningDataAction: "Running data action...",
    refreshingStorage: "Refreshing storage...",
  },
  network: {
    emptyTitle: "Your knowledge graph will appear here.",
    emptyDesc: "Capture a few conversations first, then reopen the Knowledge Graph to watch it evolve over time.",
    noConversationsYet: "No conversations captured yet.",
    replayInfo: "This replay runs the full timeline in 8 seconds, even when everything was captured today.",
    newConversationOn: "+ New conversation on {platform}",
    conversationOn: "+ {label} · {platform}",
    buildingGraph: "Building graph...",
    trendLabel: "Trend · daily new conversations",
    noSemanticLinks: "No semantic links yet. Playback still shows how conversations accumulated over time.",
    dragHint: "Drag the trend line to pause on a moment.",
    replay: "Replay",
    edgeLoadingUnavailable: "Semantic edge loading is unavailable in this environment.",
    edgePlaybackUnavailable: "Semantic edge playback is temporarily unavailable.",
    close: "Close",
    started: "Started",
    messages: "messages",
    semanticLinks: "semantic links",
    noPreviewSnippet: "No preview snippet available for this conversation yet.",
    tags: "Tags",
    connectedConversations: "Connected conversations",
    noSemanticLinksForNode: "No semantic links for this node yet.",
    viewInLibrary: "View in Library",
    edgeSemanticSimilarity: "edge = semantic similarity",
    trendScrubberAriaLabel: "Conversation trend scrubber",
    conversationsVisible: "conversations visible",
    appearsLaterInReplay: "appears later in replay",
    starred: "Starred",
    unknownPlatform: "Unknown platform",
    conversationN: "Conversation {id}",
    thinkingMapView: "Thinking map",
    conversationMapView: "Conversations",
    thinkingMapEmpty:
      "Generate conversation summaries in the Library first — the thinking map is built from the key insights inside them.",
    loadingThinkingMap: "Building your thinking map...",
    gapInsightTitle: "Threads you haven't connected",
    gapInsightTemplate: "You explored {a} and {b} but never linked them",
    conceptMentionedIn: "Across {count} conversations",
    relatedConversations: "Related conversations",
    groupByLabel: "Group by",
    groupByPlatform: "Platform",
    groupByTopic: "Topic",
    groupByProject: "Project",
    groupOther: "Ungrouped",
    clusterConversationCount: "{count} conversations",
  },
  prompts: {
    title: "Prompt Library",
    summary: "{count} prompts",
    extractFromChats: "Extract from chats",
    extracting: "Extracting…",
    extractTooltip: "Scan recent conversations for reusable prompts",
    newPrompt: "New prompt",
    searchPlaceholder: "Search prompts…",
    favorites: "Favorites",
    allCategories: "All categories",
    sortRecent: "Recent",
    sortQuality: "Quality",
    sortUsage: "Most used",
    loading: "Loading prompts…",
    emptyNone: "No prompts yet.",
    emptyFiltered: "No prompts match the current filters.",
    emptyHint: "Extract reusable prompts from your captured conversations, or add one manually.",
    retry: "Retry",
    favorite: "Favorite",
    unfavorite: "Unfavorite",
    copy: "Copy prompt",
    deleteAria: "Delete prompt",
    closeEditor: "Close editor",
    editorNew: "New prompt",
    editorEdit: "Edit prompt",
    fieldTitle: "Trigger",
    titlePlaceholder: "Short trigger to recall this prompt (optional)",
    fieldBody: "Prompt",
    bodyPlaceholder: "Write your reusable prompt. Use {{variables}} for placeholders.",
    improveTooltip: "Rewrite this draft into a stronger prompt (uses your configured LLM)",
    improving: "Improving…",
    improveWithAI: "Improve with AI",
    fieldCategory: "Category",
    categoryPlaceholder: "e.g. Coding",
    fieldTags: "Tags (comma-sep)",
    tagsPlaceholder: "code, review",
    markFavorite: "Mark as favorite (常用)",
    openSource: "Open source conversation",
    save: "Save",
    cancel: "Cancel",
    deleteBtn: "Delete",
    usedTimes: "used {n}×",
    scorePoor: "Basic",
    scoreGood: "Good",
    scoreHigh: "High-value",
    toastBodyEmpty: "Prompt body cannot be empty.",
    toastSaved: "Prompt saved.",
    toastDuplicate: "An identical prompt already exists.",
    toastUpdated: "Prompt updated.",
    toastSaveFailed: "Failed to save prompt.",
    toastDeleted: "Prompt deleted.",
    toastDeleteFailed: "Failed to delete prompt.",
    toastFavoriteFailed: "Failed to update favorite.",
    toastCopied: "Copied to clipboard.",
    toastClipboard: "Clipboard unavailable.",
    toastImproved: "Prompt improved with AI.",
    toastNoLlm: "No LLM configured — configure one in Settings to enable AI rewrite.",
    toastImproveFailed: "AI completion failed.",
    toastExtract: "Archived {created} new prompt(s) from {candidates} candidate(s).",
    toastExtractEmpty: "No reusable prompt patterns found yet — chat a bit more, then extract again.",
    toastExtractNone: "Scanned {candidates} candidate(s); nothing new to archive.",
    toastExtractLlmFallback: "(AI summarization failed; used offline extraction results.)",
    unavailable: "Prompt management is not available in this build.",
    exportLabel: "Export",
    importLabel: "Import",
    importBackup: "Import prompts backup",
    toastExported: "Exported {n} prompts.",
    toastImported: "Imported {n} prompts ({skipped} skipped).",
    importFailed: "Import failed — invalid backup file.",
    loadFailed: "Failed to load prompts.",
    draftFirst: "Write a draft to improve first.",
    extractFailed: "Extraction failed.",
    summaryLabel: "Summary: ",
    plazaTitle: "Prompt Plaza",
    plazaSubtitle: "Recommended high-quality prompts from trusted sources.",
    plazaDaily: "Daily picks",
    plazaDailyHint: "Refreshes every day.",
    plazaUse: "Use",
    plazaSourcePrefix: "Source: ",
    supermarketTitle: "Prompt Supermarket",
    supermarketSubtitle: "Browse more quality prompts by category and add them to your plaza.",
    myPlaza: "My plaza",
    myPlazaEmpty: "Add prompts from the supermarket below to build your plaza.",
    adopt: "Add",
    adopted: "Added",
    selectAria: "Select prompt",
    selectedCount: "{n} selected",
    deleteSelected: "Delete",
    clearSelection: "Cancel",
    scanLibrary: "Scan library",
    scanning: "Scanning…",
    scanTooltip: "Scan every archived conversation (agent sessions and browser chats) for prompts you reuse",
    scanProgress: "Scanning {done}/{total}…",
    scanResultsTitle: "Scan results",
    scanSummary: "Scanned {conversations} conversations and {inputs} of your inputs — {n} candidates found",
    scanEmpty: "No reusable prompt patterns found — reuse similar instructions a few more times, then scan again.",
    scanFailed: "Scan failed.",
    scanPrivacy: "Only your own archived inputs on this device are scanned; with no LLM configured it runs fully offline — with one, candidate titles get a single naming call.",
    scanTruncated: "Large library — only the most recent conversations were scanned this time.",
    scanUsedCount: "{n}×",
    scanSourceCount: "{n} chats",
    scanAdopt: "Adopt",
    scanAdopted: "Adopted",
    scanIgnore: "Ignore",
    scanInLibrary: "In library",
    scanOriginAgent: "Agent",
    scanOriginBrowser: "Browser",
    scanClose: "Close results",
  },
  aiti: {
    modeAsk: "Ask",
    modeAiti: "AITI",
    modeRoundtable: "Roundtable",
    title: "Your AITI — your thinking strengths",
    subtitle: "Computed locally from your own conversations. A reflection of your strengths, not a verdict.",
    insufficient: "Your imagery has not taken shape yet — it needs at least 5 conversation summaries as signal. Generate summaries below, or keep chatting with your AI and it will emerge.",
    sample: "Drawn from {n} of your conversations",
    typeSeparator: " · ",
    strengthsTitle: "Your thinking strengths",
    empoweringIntro: "Across your AI conversations, these strengths shine through:",
    obsessionsTitle: "What you keep investing in",
    evidence: "seen in {n} conversations",
    axisNeedsSignal: "Needs more signal",
    axisDepthLabel: "Breadth ↔ Depth",
    axisDepthLeft: "Explorer",
    axisDepthRight: "Excavator",
    axisDepthLeftStrength: "You range widely and connect ideas across many fields.",
    axisDepthRightStrength: "You dive deep and master complex things thoroughly.",
    axisMakerLabel: "Theory ↔ Practice",
    axisMakerLeft: "Theorist",
    axisMakerRight: "Maker",
    axisMakerLeftStrength: "You think in principles and models, getting the fundamentals right.",
    axisMakerRightStrength: "You're action-oriented and turn ideas into real results fast.",
    axisFocusLabel: "Converge ↔ Wander",
    axisFocusLeft: "Converger",
    axisFocusRight: "Wanderer",
    axisFocusLeftStrength: "You stay focused and converge on the answer that matters.",
    axisFocusRightStrength: "You roam with curiosity and open up unexpected possibilities.",
    axisAffectLabel: "Cool ↔ Spirited",
    axisAffectLeft: "Cool-headed",
    axisAffectRight: "Spirited",
    axisAffectLeftStrength: "You stay calm and keep clear judgment under complexity.",
    axisAffectRightStrength: "You bring strong emotional engagement to what you explore.",
    axisSignalFaint: "Faint signal",
    imageryFaint: "The outline is still faint — some axes are gathering signal; read it lightly.",
    personaNoteLabel: "Recent footnote",
    mindMapTitle: "Thinking map",
    repoQrCaption: "Open source — scan for the repo",
    evidenceBecause: "This is so you, because…",
    evidenceConversation: "Conversation #{id}",
    exportCard: "Export imagery card",
    coverageSummary: "Summarized {x} of {y} conversations ({z} structured)",
    coverageNeedMore: "The imagery needs at least 5 structured summaries — {n} more to go.",
    coverageEmpty: "No conversations yet — sync your AI sessions first, then summaries can be generated.",
    generateSummaries: "Generate summaries",
    generatingSummaries: "Generating {done}/{total}…",
    cancelGeneration: "Stop",
    summariesResult: "Finished: {done} generated, {failed} failed.",
    llmMissing: "No model configured — set up an LLM in Settings first, then generate summaries.",
    allSummarized: "Every conversation already has a structured summary.",
  },
  learn: {
    modeLearn: "Learn",
    title: "What you've been learning",
    subtitle: "Your conversations, organized as a personal curriculum. Computed locally.",
    intro: "This is your learning map: it automatically reads the summaries of your AI conversations and lays out what you've been studying, how deep it went, and what is still open.",
    sourceLine: "Based on {n} analyzed conversations · covering {m} topics",
    insufficient: "Not enough conversations yet — with at least 3 captured conversations your learning map starts to grow here. Ask a few questions in the Ask tab first.",
    sample: "From {n} analyzed conversations",
    domainsTitle: "Knowledge domains",
    uncategorized: "Uncategorized",
    domainConversations: "{n} conversations",
    representativesTitle: "Representative conversations",
    deepen: "Go deeper",
    deepenPrompt: "Around \"{topic}\": what should I dig into next? Lay out a learning path from my past conversations.",
    glossaryTitle: "Things you've learned",
    openLoopsTitle: "Open loops",
    openLoopsEmpty: "No unresolved threads — nicely closed out.",
    weakHint: "Still a thin sample — generate summaries for more conversations (see the AITI tab) and this map will fill in.",
    weakAction: "Generate summaries on the AITI tab",
    loading: "Putting your learning map together…",
    deepenAi: "AI deep-dive",
    deepenAiRunning: "Digging deeper into \"{topic}\"…",
    deepenAiTitle: "AI learning-trajectory analysis",
    mastered: "What you've mastered",
    blindSpots: "Blind spots",
    learningPath: "Suggested path",
    deepenAiFailed: "Deep-dive failed",
    llmMissing: "No model configured — set up an LLM in Settings first; the AI deep-dive needs one to analyze.",
    groundedHint: "Grounded in {n} of your past conversations",
    savedHint: "Saved to your Ask history — replay it anytime from the Ask tab.",
    domainActivity: "{n} in the last 7 days · {m} in the last 30",
    domainIdle: "No new conversations in the last 30 days",
    nextStepTitle: "Still unresolved",
    followUp: "Follow up",
    followUpPrompt: "I left a question unresolved: \"{question}\". Walk me through it properly, drawing on my past conversations.",
    toRoundtable: "Take it to the roundtable",
    roundtablePrompt: "On \"{topic}\": where is my understanding still weak, and what is worth investing in next?",
    moreDomains: "+ {n} more areas",
    uncategorizedIncluded: "· includes uncategorized",
    synthesisRunning: "Reading your routes… {done}/{total}",
    synthesisRegenerate: "Regenerate readings",
    synthesisNextSteps: "Suggested next steps",
  },
  roundtable: {
    title: "AI Roundtable",
    subtitle: "Convene a panel of perspectives on your question, then a moderated synthesis.",
    comingSoonTitle: "AI Roundtable — coming soon",
    comingSoonBody: "The plan: convene several AI panelists with distinct perspectives on your question, then have a moderator synthesize the consensus, the disagreements, and a recommendation. The multi-turn orchestration is still being polished — until it is real, we'd rather not show you a fake run.",
    questionPlaceholder: "Ask a judgment-call question to debate…",
    intro: "The roundtable convenes several AI panelists with distinct perspectives on your question, then a moderator distills the consensus, the disagreements and a recommendation — grounded in your past conversations when recall finds relevant ones.",
    topicsLabel: "Pick a topic from your learning domains",
    topicPrompt: "Around \"{topic}\": what is the most worthwhile direction for me to invest in next?",
    personasLabel: "Panelists (pick 2-4)",
    run: "Convene panel",
    rerun: "Run it again",
    running: "The panel is deliberating…",
    seatsProgress: "{done}/{total} panelists have spoken",
    synthesisRunning: "The moderator is synthesizing…",
    latencyHint: "Each seat answers in turn, so this takes a little while.",
    needQuestion: "Type a question first.",
    seatsTitle: "Panel",
    synthesisTitle: "Moderator's synthesis",
    consensus: "Consensus",
    disagreements: "Key disagreements",
    recommendation: "Recommendation",
    openQuestions: "Open questions",
    empty: "Ask a question and convene the panel to see perspectives + a synthesis.",
    llmMissing: "No model configured — set up an LLM in Settings first; the panel needs one to deliberate.",
    seatFailed: "Turn failed",
    savedHint: "Saved to your Ask history — replay it anytime from the Ask tab.",
    groundedHint: "Grounded in {n} of your past conversations",
    personaSkeptic: "Skeptic",
    personaOptimist: "Optimist",
    personaPragmatist: "Pragmatist",
    personaDomainExpert: "Domain Expert",
    personaDevilsAdvocate: "Devil's Advocate",
    deepen: "Go deeper",
    deepenPrompt: "In the roundtable on \"{question}\", {persona} argued: \"{excerpt}\". Dig into this viewpoint against my past conversations — where does it hold, where does it not?",
    scenesLabel: "Scenario presets",
    sceneTechReview: "Tech review",
    sceneStudyQa: "Study Q&A",
    sceneDecisionDebate: "Decision debate",
    copyResult: "Copy result",
    copied: "Copied",
    copyFailed: "Copy failed",
    allSeatsFailed: "The discussion couldn't run: every panelist's turn failed. This usually means the model service is unavailable (out of quota, or a network issue) — check the model settings and try again.",
  },
};

type DashboardProps = {
  storage: StorageApi;
  logoSrc: string;
  logoAlt?: string;
  rootClassName?: string;
  themeMode?: UiThemeMode;
  onToggleTheme?: () => Promise<void> | void;
  themeSyncStatus?: ThemeSyncStatus;
  themeSyncMessage?: string | null;
  labels?: DashboardLabels;
  plaza?: PlazaData;
  onPlazaAdoptToggle?: (id: string, adopt: boolean) => void;
  aiti?: AitiProfile;
  /** P5 思维意象: host-resolved imagery + emblem asset URL + persona footnote. */
  aitiImagery?: AitiImagery | null;
  aitiEmblemUrl?: string;
  aitiPersonaNote?: string | null;
  /** 夜话: owl mood-icon asset URLs resolved by the host (import.meta.glob on
   * src/ui/assets/owl) — same hand-down pattern as aitiEmblemUrl. */
  companionOwlIcons?: CompanionOwlIcons;
  learn?: LearnProfile;
  /** Transcript/persona language for the roundtable runs ("zh" default). */
  lang?: "zh" | "en";
  /** Controlled active tab (desktop dock rail). Uncontrolled when omitted. */
  tab?: Tab;
  onTabChange?: (tab: Tab) => void;
  /** Desktop home → library source deep link: one-shot platform filter
   * request, cleared through the callback once the library applies it. */
  libraryPlatformFilter?: string | null;
  onLibraryPlatformFilterApplied?: () => void;
};

export function VestiDashboard({
  storage,
  logoSrc,
  logoAlt = "Vesti",
  rootClassName,
  themeMode = "light",
  onToggleTheme,
  themeSyncStatus = "idle",
  themeSyncMessage = null,
  labels: providedLabels,
  plaza,
  onPlazaAdoptToggle,
  aiti,
  aitiImagery,
  aitiEmblemUrl,
  aitiPersonaNote,
  companionOwlIcons,
  learn,
  lang = "zh",
  tab: controlledTab,
  onTabChange,
  libraryPlatformFilter,
  onLibraryPlatformFilterApplied,
}: DashboardProps) {
  const labels = providedLabels ?? DEFAULT_LABELS;
  const SETTINGS_KEY = "vesti_llm_settings";
  const [internalTab, setInternalTab] = useState<Tab>(() => {
    if (typeof window === "undefined") return "library";
    const params = new URLSearchParams(window.location.search);
    const tab = params.get("tab");
    if (
      tab === "explore" ||
      tab === "network" ||
      tab === "library" ||
      tab === "prompts" ||
      tab === "deposits" ||
      tab === "daily"
    )
      return tab;
    return "library";
  });
  // Controlled mode: the host (desktop dock rail) owns the active tab.
  const activeTab = controlledTab ?? internalTab;
  const setActiveTab = useCallback(
    (next: Tab) => {
      setInternalTab(next);
      onTabChange?.(next);
    },
    [onTabChange],
  );
  useEffect(() => {
    if (controlledTab) setInternalTab(controlledTab);
  }, [controlledTab]);
  const [exploreMode, setExploreMode] = useState<ExploreSubMode>(() => readStoredExploreMode());
  // Explore 子模式记忆: persist the pill choice so a restart lands back on it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(EXPLORE_MODE_STORAGE_KEY, exploreMode);
  }, [exploreMode]);

  // Learn → Ask handoff ("继续深入"): seed the Ask composer with a follow-up
  // question and switch the pane; the nonce makes repeat clicks re-seed.
  const [askSeed, setAskSeed] = useState<{ text: string; nonce: number } | null>(null);
  const handleExploreTopic = useCallback((text: string) => {
    setAskSeed({ text, nonce: Date.now() });
    setExploreMode("ask");
  }, []);
  // Learn → Roundtable handoff ("发起圆桌"): same pattern, other pane.
  const [roundtableSeed, setRoundtableSeed] = useState<{ text: string; nonce: number } | null>(null);
  const handleRoundtableTopic = useCallback((text: string) => {
    setRoundtableSeed({ text, nonce: Date.now() });
    setExploreMode("roundtable");
  }, []);
  const handleGoAiti = useCallback(() => setExploreMode("aiti"), []);

  // AITI 摘要覆盖率 + 立即生成摘要 batch state (undefined coverage → the
  // host storage doesn't implement the coverage API and the header hides).
  const summaryCoverageSupported = Boolean(storage.getSummaryCoverage);
  const [aitiCoverage, setAitiCoverage] = useState<SummaryCoverage | null>(null);
  const [aitiCoverageFailed, setAitiCoverageFailed] = useState(false);
  const [llmConfigured, setLlmConfigured] = useState<boolean | undefined>(undefined);
  const [summaryBatch, setSummaryBatch] = useState<SummaryBatchState | null>(null);
  const summaryBatchCancelRef = useRef(false);

  const refreshAitiCoverage = useCallback(async () => {
    if (!storage.getSummaryCoverage) return;
    try {
      const coverage = await storage.getSummaryCoverage();
      setAitiCoverage(coverage);
      setAitiCoverageFailed(false);
    } catch {
      // Hide the header on failure rather than spinning forever.
      setAitiCoverageFailed(true);
    }
    if (storage.getLlmConfigured) {
      const configured = await storage.getLlmConfigured().catch(() => false);
      setLlmConfigured(configured);
    }
  }, [storage]);

  useEffect(() => {
    if (exploreMode !== "aiti" || !summaryCoverageSupported) return;
    void refreshAitiCoverage();
    // Stay in step with capture syncs (and with our own batch completion,
    // which fires the same event) while the aiti pane is visible.
    const handler = () => void refreshAitiCoverage();
    window.addEventListener("vesti:data-updated", handler);
    return () => window.removeEventListener("vesti:data-updated", handler);
  }, [exploreMode, refreshAitiCoverage, summaryCoverageSupported]);

  // 立即生成摘要: strictly sequential (concurrency 1), capped by
  // planSummaryBatch; failures are counted and the run continues.
  const handleGenerateSummaries = useCallback(async () => {
    if (!storage.generateSummary || !aitiCoverage || summaryBatch?.status === "running") return;
    const ids = planSummaryBatch(aitiCoverage.pendingConversationIds);
    if (ids.length === 0) return;
    summaryBatchCancelRef.current = false;
    let progress = createSummaryBatchProgress(ids.length);
    setSummaryBatch({ status: "running", ...progress });
    for (const id of ids) {
      if (summaryBatchCancelRef.current) break;
      let outcome: "ok" | "failed" = "ok";
      try {
        await storage.generateSummary(id);
      } catch (error) {
        console.error("[Explore] Summary generation failed for conversation", id, error);
        outcome = "failed";
      }
      progress = advanceSummaryBatch(progress, outcome);
      setSummaryBatch({ status: "running", ...progress });
    }
    setSummaryBatch({ status: "done", ...progress });
    // Same recompute trigger as a capture sync: the host recomputes AITI /
    // Learn from the freshly written summaries when it hears this.
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("vesti:data-updated"));
    }
    await refreshAitiCoverage();
  }, [storage, aitiCoverage, summaryBatch?.status, refreshAitiCoverage]);

  const handleCancelSummaryBatch = useCallback(() => {
    summaryBatchCancelRef.current = true;
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerView, setDrawerView] = useState<DrawerView>("settings");
  const [modelscopeKey, setModelscopeKey] = useState("");
  const [notionSettings, setNotionSettingsState] = useState<NotionSettings>({
    authMode: "disconnected",
    accessToken: "",
    workspaceId: "",
    workspaceName: "",
    selectedDatabaseId: "",
    selectedDatabaseTitle: "",
    updatedAt: 0,
  });
  const [notionDatabaseQuery, setNotionDatabaseQuery] = useState("");
  const [notionDatabases, setNotionDatabases] = useState<NotionDatabaseOption[]>([]);
  const [notionDatabasesStatus, setNotionDatabasesStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [notionDatabasesMessage, setNotionDatabasesMessage] = useState("");
  const [notionMessage, setNotionMessage] = useState("");
  const [settingsStatus, setSettingsStatus] = useState<"idle" | "saved" | "error">(
    "idle"
  );
  const [notionStatus, setNotionStatus] = useState<"idle" | "saved" | "error" | "loading">(
    "idle"
  );
  const [settingsAvailable, setSettingsAvailable] = useState(true);
  const [openConversationId, setOpenConversationId] = useState<number | null>(null);
  const [returnTab, setReturnTab] = useState<ReturnTab | null>(null);
  const [mountedTabs, setMountedTabs] = useState<Record<Tab, boolean>>(() => ({
    library: activeTab === "library",
    explore: activeTab === "explore",
    network: activeTab === "network",
    prompts: activeTab === "prompts",
    deposits: activeTab === "deposits",
    daily: activeTab === "daily",
  }));
  const userMenuRef = useRef<HTMLDivElement | null>(null);
  const notionAvailable =
    typeof chrome !== "undefined" &&
    Boolean(chrome.storage?.local) &&
    Boolean(chrome.identity?.launchWebAuthFlow);
  const notionConnected = isNotionConnected(notionSettings);
  const notionExportReady = isNotionExportConfigured(notionSettings);

  useEffect(() => {
    setMountedTabs((prev) => {
      if (prev[activeTab]) return prev;
      return {
        ...prev,
        [activeTab]: true,
      };
    });
  }, [activeTab]);

  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;

    const applyNavRequest = (raw: unknown) => {
      if (!raw || typeof raw !== "object") return;
      const tab = (raw as DashboardNavRequest).tab;
      if (
        tab === "library" ||
        tab === "explore" ||
        tab === "network" ||
        tab === "prompts" ||
        tab === "deposits" ||
        tab === "daily"
      ) {
        setActiveTab(tab);
      }
    };

    chrome.storage.local.get(DASHBOARD_NAV_REQUEST_KEY, (result) => {
      applyNavRequest(result?.[DASHBOARD_NAV_REQUEST_KEY]);
    });

    const onStorageChanged: Parameters<typeof chrome.storage.onChanged.addListener>[0] =
      (changes, areaName) => {
        if (areaName !== "local") return;
        const navRequest = changes[DASHBOARD_NAV_REQUEST_KEY];
        if (!navRequest) return;
        applyNavRequest(navRequest.newValue);
      };

    chrome.storage.onChanged.addListener(onStorageChanged);
    return () => {
      chrome.storage.onChanged.removeListener(onStorageChanged);
    };
  }, []);

  useEffect(() => {
    if (!drawerOpen || drawerView !== "settings") {
      setSettingsStatus("idle");
      return;
    }
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      setSettingsAvailable(false);
      return;
    }
    chrome.storage.local.get(SETTINGS_KEY, (result) => {
      setSettingsAvailable(true);
      const settings = result?.[SETTINGS_KEY] as { apiKey?: string } | undefined;
      setModelscopeKey(settings?.apiKey ?? "");
    });
    void getNotionSettings()
      .then((settings) => {
        setNotionSettingsState(settings);
      })
      .catch((error) => {
        setNotionStatus("error");
        setNotionMessage(formatNotionErrorMessage(error));
      });
  }, [drawerOpen, drawerView]);

  useEffect(() => {
    if (!drawerOpen || drawerView !== "settings" || !notionConnected) {
      return;
    }

    void listNotionDatabases("")
      .then((results) => {
        setNotionDatabases(results);
        setNotionDatabasesStatus("ready");
        setNotionDatabasesMessage(
          results.length === 0
            ? labels.settings.noSharedDatabasesFound
            : ""
        );
      })
      .catch((error) => {
        setNotionDatabasesStatus("error");
        setNotionDatabasesMessage(formatNotionErrorMessage(error));
      });
  }, [drawerOpen, drawerView, notionConnected]);

  useEffect(() => {
    if (!settingsOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!userMenuRef.current) return;
      if (userMenuRef.current.contains(event.target as Node)) return;
      setSettingsOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [settingsOpen]);

  const handleSaveModelscopeKey = () => {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      setSettingsAvailable(false);
      setSettingsStatus("error");
      return;
    }
    chrome.storage.local.get(SETTINGS_KEY, (result) => {
      const err = chrome.runtime?.lastError;
      if (err) {
        setSettingsStatus("error");
        return;
      }
      const existing = (result?.[SETTINGS_KEY] as Record<string, unknown>) ?? {};
      const next = {
        ...existing,
        apiKey: modelscopeKey.trim(),
      };
      chrome.storage.local.set({ [SETTINGS_KEY]: next }, () => {
        const saveErr = chrome.runtime?.lastError;
        if (saveErr) {
          setSettingsStatus("error");
          return;
        }
        setSettingsStatus("saved");
        setTimeout(() => setSettingsStatus("idle"), 1500);
      });
    });
  };

  const handleSelectTab = (tab: Tab) => {
    setActiveTab(tab);
    if (tab !== "library") {
      setReturnTab(null);
      setOpenConversationId(null);
      return;
    }
    setReturnTab(null);
  };

  const loadNotionDatabases = async (query = notionDatabaseQuery) => {
    if (!notionConnected) {
      setNotionDatabases([]);
      setNotionDatabasesStatus("idle");
      setNotionDatabasesMessage("");
      return;
    }

    setNotionDatabasesStatus("loading");
    setNotionDatabasesMessage("");
    try {
      const results = await listNotionDatabases(query);
      setNotionDatabases(results);
      setNotionDatabasesStatus("ready");
      setNotionDatabasesMessage(
        results.length === 0
          ? labels.settings.noSharedDatabasesFound
          : ""
      );
    } catch (error) {
      setNotionDatabasesStatus("error");
      setNotionDatabasesMessage(formatNotionErrorMessage(error));
    }
  };

  const handleConnectNotion = async () => {
    setNotionStatus("loading");
    setNotionMessage("");
    try {
      const next = await connectToNotion();
      setNotionSettingsState(next);
      setNotionDatabaseQuery("");
      await loadNotionDatabases("");
      setNotionStatus("saved");
      setNotionMessage(labels.settings.notionConnected);
      setTimeout(() => setNotionStatus("idle"), 1500);
    } catch (error) {
      setNotionStatus("error");
      setNotionMessage(formatNotionErrorMessage(error));
    }
  };

  const handleDisconnectNotion = async () => {
    setNotionStatus("loading");
    setNotionMessage("");
    try {
      const next = await disconnectNotion();
      setNotionSettingsState(next);
      setNotionDatabases([]);
      setNotionDatabasesStatus("idle");
      setNotionDatabasesMessage("");
      setNotionDatabaseQuery("");
      setNotionStatus("saved");
      setNotionMessage(labels.settings.notionDisconnected);
      setTimeout(() => setNotionStatus("idle"), 1500);
    } catch (error) {
      setNotionStatus("error");
      setNotionMessage(formatNotionErrorMessage(error));
    }
  };

  const handleSelectNotionDatabase = async (database: NotionDatabaseOption) => {
    setNotionStatus("loading");
    setNotionMessage("");
    try {
      const next = await selectNotionDatabase(database);
      setNotionSettingsState(next);
      setNotionStatus("saved");
      setNotionMessage(
        labels.settings.selectedDatabaseMessage.replace("{title}", database.title)
      );
      setTimeout(() => setNotionStatus("idle"), 1500);
    } catch (error) {
      setNotionStatus("error");
      setNotionMessage(formatNotionErrorMessage(error));
    }
  };

  const handleOpenConversation = (conversationId: number) => {
    const originTab = activeTab === "explore" || activeTab === "network" ? activeTab : null;
    setReturnTab(originTab);
    setActiveTab("library");
    setOpenConversationId(conversationId);
  };

  const handleReturnToSource = () => {
    if (!returnTab) return;
    setActiveTab(returnTab);
    setOpenConversationId(null);
    setReturnTab(null);
  };

  const openDrawer = (view: DrawerView) => {
    setDrawerView(view);
    setDrawerOpen(true);
    setSettingsOpen(false);
  };

  const isDarkMode = themeMode === "dark";
  const isThemeSwitchDisabled = !onToggleTheme || themeSyncStatus === "syncing";
  const themeDescription = isDarkMode
    ? `${labels.settings.themeShared} ${labels.settings.themeSharedDark}`
    : `${labels.settings.themeShared} ${labels.settings.themeSharedLight}`;
  const themeFeedback =
    themeSyncStatus === "syncing"
      ? labels.settings.syncingAppearance
      : themeSyncMessage || labels.settings.changesStayInSync;
  const returnToSourceLabel =
    activeTab === "library" && returnTab
      ? returnTab === "explore"
        ? labels.nav.backToExplore
        : labels.nav.backToNetwork
      : null;

  const brand = (
    <div className="flex items-center gap-2">
      <img src={logoSrc} alt={logoAlt} className="h-7 w-7" />
      <h1 className="text-base font-[family-name:var(--font-lora)] font-semibold text-text-primary">
        Vesti
      </h1>
    </div>
  );

  // In controlled mode (desktop dock rail) the host provides tab navigation,
  // so the in-page tab bar is redundant.
  const tabNav = controlledTab ? null : (
    <nav
      aria-label={labels.nav.dashboardSections}
      className="flex items-center justify-center gap-3 lg:gap-5"
    >
      <button
        type="button"
        onClick={() => handleSelectTab("library")}
        className={`inline-flex items-center px-3 py-1.5 text-[14px] leading-none font-mono font-medium uppercase tracking-[0.26em] transition-colors ${
          activeTab === "library"
            ? "text-text-primary"
            : "text-text-tertiary hover:text-text-secondary"
        }`}
      >
        {labels.tabs.library}
      </button>
      <button
        type="button"
        onClick={() => handleSelectTab("explore")}
        className={`inline-flex items-center px-3 py-1.5 text-[14px] leading-none font-mono font-medium uppercase tracking-[0.26em] transition-colors ${
          activeTab === "explore"
            ? "text-text-primary"
            : "text-text-tertiary hover:text-text-secondary"
        }`}
      >
        {labels.tabs.explore}
      </button>
      <button
        type="button"
        onClick={() => handleSelectTab("network")}
        className={`inline-flex items-center px-3 py-1.5 text-[14px] leading-none font-mono font-medium uppercase tracking-[0.26em] transition-colors ${
          activeTab === "network"
            ? "text-text-primary"
            : "text-text-tertiary hover:text-text-secondary"
        }`}
      >
        {labels.tabs.network}
      </button>
      <button
        type="button"
        onClick={() => handleSelectTab("prompts")}
        className={`inline-flex items-center px-3 py-1.5 text-[14px] leading-none font-mono font-medium uppercase tracking-[0.26em] transition-colors ${
          activeTab === "prompts"
            ? "text-text-primary"
            : "text-text-tertiary hover:text-text-secondary"
        }`}
      >
        {labels.tabs.prompts}
      </button>
      <button
        type="button"
        onClick={() => handleSelectTab("deposits")}
        className={`inline-flex items-center px-3 py-1.5 text-[14px] leading-none font-mono font-medium uppercase tracking-[0.26em] transition-colors ${
          activeTab === "deposits"
            ? "text-text-primary"
            : "text-text-tertiary hover:text-text-secondary"
        }`}
      >
        {labels.tabs.deposits}
      </button>
      <button
        type="button"
        onClick={() => handleSelectTab("daily")}
        className={`inline-flex items-center px-3 py-1.5 text-[14px] leading-none font-mono font-medium uppercase tracking-[0.26em] transition-colors ${
          activeTab === "daily"
            ? "text-text-primary"
            : "text-text-tertiary hover:text-text-secondary"
        }`}
      >
        {labels.tabs.daily}
      </button>
    </nav>
  );

  const userMenu = (
    <div ref={userMenuRef} className="relative">
      <button
        type="button"
        onClick={() => setSettingsOpen((open) => !open)}
        className="inline-flex items-center gap-1 rounded-lg p-1.5 transition-colors hover:bg-bg-surface-card"
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-primary text-sm font-sans text-text-inverse">
          U
        </div>
        <ChevronDown strokeWidth={1.75} className="h-4 w-4 text-text-secondary" />
      </button>
      {settingsOpen && (
        <div className="absolute right-0 top-full z-50 mt-2 w-52 rounded-lg border border-border-subtle bg-bg-primary py-1 shadow-[0_8px_24px_rgba(0,0,0,0.08)]">
          <button
            type="button"
            onClick={() => openDrawer("settings")}
            className="inline-flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] font-sans text-text-primary transition-colors hover:bg-bg-surface-card"
          >
            <Settings strokeWidth={1.6} className="h-4 w-4" />
            <span>{labels.settings.settings}</span>
          </button>
          <button
            type="button"
            onClick={() => openDrawer("data")}
            className="inline-flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] font-sans text-text-primary transition-colors hover:bg-bg-surface-card"
          >
            <Database strokeWidth={1.6} className="h-4 w-4" />
            <span>{labels.settings.dataOperations}</span>
          </button>
        </div>
      )}
    </div>
  );

  return (
    <LibraryDataProvider storage={storage}>
      {/* h-full, not h-screen: the desktop shell mounts this below a fixed
          title bar inside an overflow-hidden window — a 100vh root would be
          taller than its slot and the bottom strip could never scroll into
          view. */}
      <div
        className={`${rootClassName ?? ""} relative flex h-full flex-col bg-bg-primary text-text-primary`}
      >
        {/* In controlled mode the desktop shell (title bar + dock) replaces
            the in-page header, so the whole row is skipped — brand and tabNav
            are already null here, and the avatar menu only duplicates the
            shell's own settings page. */}
        {!controlledTab && (
          <header className="bg-bg-tertiary">
            <div className="hidden h-14 border-b border-border-subtle px-6 lg:grid lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:items-center">
              <div className="justify-self-start">{brand}</div>
              <div className="justify-self-center self-center">{tabNav}</div>
              <div className="justify-self-end">{userMenu}</div>
            </div>
            <div className="lg:hidden">
              <div className="flex h-14 items-center justify-between border-b border-border-subtle px-4 sm:px-6">
                {brand}
                {userMenu}
              </div>
              <div className="border-b border-border-subtle px-4 sm:px-6">{tabNav}</div>
            </div>
          </header>
        )}

        <div className="flex-1 overflow-hidden">
          {mountedTabs.library && (
            <div className={`h-full ${activeTab === "library" ? "block" : "hidden"}`}>
              <LibraryTab
                storage={storage}
                themeMode={themeMode}
                openConversationId={openConversationId}
                onConversationOpened={() => setOpenConversationId(null)}
                platformFilter={libraryPlatformFilter}
                onPlatformFilterApplied={onLibraryPlatformFilterApplied}
                returnToSourceLabel={returnToSourceLabel}
                onReturnToSource={returnToSourceLabel ? handleReturnToSource : undefined}
                labels={labels.library}
              />
            </div>
          )}
          {mountedTabs.explore && (
            <div className={`h-full ${activeTab === "explore" ? "flex flex-col" : "hidden"}`}>
              {/* Explore = the reflective-AI hub: 问答 / AITI 画像 / 学习 / 圆桌 */}
              <div className="flex items-center gap-1 border-b border-border-subtle px-4 py-2">
                {(["ask", "aiti", "learn", "roundtable"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setExploreMode(mode)}
                    className={`rounded-full px-3 py-1 text-[12px] font-medium transition-colors ${
                      exploreMode === mode
                        ? "bg-accent-primary-light text-accent-primary"
                        : "text-text-tertiary hover:text-text-secondary"
                    }`}
                  >
                    {mode === "ask"
                      ? labels.aiti.modeAsk
                      : mode === "aiti"
                        ? labels.aiti.modeAiti
                        : mode === "learn"
                          ? labels.learn.modeLearn
                          : labels.aiti.modeRoundtable}
                  </button>
                ))}
              </div>
              <div className={`min-h-0 flex-1 ${exploreMode === "ask" ? "block" : "hidden"}`}>
                <ExploreTab
                  storage={storage}
                  themeMode={themeMode}
                  onOpenConversation={handleOpenConversation}
                  labels={labels.explore}
                  seedQuery={askSeed}
                  owlIcons={companionOwlIcons}
                />
              </div>
              {exploreMode === "aiti" && (
                <div className="min-h-0 flex-1">
                  <AitiCard
                    profile={aiti}
                    labels={labels.aiti}
                    imagery={aitiImagery}
                    emblemUrl={aitiEmblemUrl}
                    personaNote={aitiPersonaNote}
                    onOpenConversation={handleOpenConversation}
                    storage={storage}
                    sendToLabels={labels.library}
                    coverage={
                      summaryCoverageSupported && !aitiCoverageFailed ? aitiCoverage : undefined
                    }
                    llmConfigured={llmConfigured}
                    summaryBatch={summaryBatch}
                    onGenerateSummaries={
                      storage.generateSummary ? handleGenerateSummaries : undefined
                    }
                    onCancelSummaryBatch={handleCancelSummaryBatch}
                  />
                </div>
              )}
              {exploreMode === "learn" && (
                <div className="min-h-0 flex-1">
                  <LearnCard
                    profile={learn}
                    labels={labels.learn}
                    onOpenConversation={handleOpenConversation}
                    onOpenAiti={handleGoAiti}
                    onExploreTopic={handleExploreTopic}
                    onRoundtableTopic={handleRoundtableTopic}
                    storage={storage}
                    sendToLabels={labels.library}
                    lang={lang}
                  />
                </div>
              )}
              {exploreMode === "roundtable" && (
                <div className="min-h-0 flex-1">
                  <RoundtablePanel
                    storage={storage}
                    themeMode={themeMode}
                    labels={labels.roundtable}
                    sendToLabels={labels.library}
                    lang={lang}
                    onOpenConversation={handleOpenConversation}
                    topicSuggestions={
                      learn?.available ? learnTopicSuggestions(learn) : undefined
                    }
                    onExploreTopic={handleExploreTopic}
                    seedQuestion={roundtableSeed}
                  />
                </div>
              )}
            </div>
          )}
          {mountedTabs.network && (
            <div className={`h-full ${activeTab === "network" ? "block" : "hidden"}`}>
              <NetworkTab
                storage={storage}
                themeMode={themeMode}
                isActive={activeTab === "network"}
                onSelectConversation={handleOpenConversation}
                labels={labels.network}
              />
            </div>
          )}
          {mountedTabs.prompts && (
            <div className={`h-full ${activeTab === "prompts" ? "block" : "hidden"}`}>
              <PromptsTab
                storage={storage}
                themeMode={themeMode}
                isActive={activeTab === "prompts"}
                onOpenConversation={handleOpenConversation}
                labels={labels.prompts}
                plaza={plaza}
                onPlazaAdoptToggle={onPlazaAdoptToggle}
              />
            </div>
          )}
          {mountedTabs.deposits && (
            <div className={`h-full ${activeTab === "deposits" ? "block" : "hidden"}`}>
              <DepositsTab
                storage={storage}
                labels={labels.deposits}
                sendToLabels={labels.library}
              />
            </div>
          )}
          {mountedTabs.daily && (
            <div className={`h-full ${activeTab === "daily" ? "block" : "hidden"}`}>
              <DailyTab
                storage={storage}
                labels={labels.daily}
                sendToLabels={labels.library}
              />
            </div>
          )}
        </div>

        {drawerOpen && (
          <>
            <button
              type="button"
              aria-label={labels.nav.closeDrawer}
              onClick={() => setDrawerOpen(false)}
              className="absolute inset-0 z-40 bg-black/20"
            />
            <aside className="absolute right-0 top-0 z-50 flex h-full w-[420px] max-w-[90vw] flex-col border-l border-border-subtle bg-bg-primary shadow-[0_0_24px_rgba(0,0,0,0.12)]">
              <div className="flex h-14 items-center justify-between border-b border-border-subtle px-4">
                <div className="inline-flex items-center gap-2 text-sm font-sans text-text-primary">
                  {drawerView === "settings" ? (
                    <Settings strokeWidth={1.6} className="h-4 w-4" />
                  ) : (
                    <Database strokeWidth={1.6} className="h-4 w-4" />
                  )}
                  <span>{drawerView === "settings" ? labels.settings.settings : labels.settings.dataOperations}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  className="rounded-md p-1 text-text-secondary transition-colors hover:bg-bg-surface-card hover:text-text-primary"
                >
                  <X strokeWidth={1.8} className="h-4 w-4" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4">
                {drawerView === "settings" ? (
                  <div className="flex flex-col gap-4">
                    <section className="rounded-xl border border-border-subtle bg-bg-surface p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-start gap-3">
                          <div className="flex h-9 w-9 items-center justify-center rounded-[12px] bg-bg-secondary text-text-secondary">
                            {isDarkMode ? (
                              <Moon className="h-4 w-4" strokeWidth={1.5} />
                            ) : (
                              <Sun className="h-4 w-4" strokeWidth={1.5} />
                            )}
                          </div>
                          <div className="min-w-0">
                            <p className="text-[13px] font-medium text-text-primary">{labels.settings.appearance}</p>
                            <p className="mt-1 text-[11px] text-text-tertiary">{themeDescription}</p>
                          </div>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={isDarkMode}
                          onClick={() => {
                            if (!onToggleTheme) return;
                            void onToggleTheme();
                          }}
                          disabled={isThemeSwitchDisabled}
                          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus ${
                            isDarkMode ? "bg-accent-primary" : "bg-bg-secondary"
                          } ${isThemeSwitchDisabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
                        >
                          <span
                            className={`inline-block h-5 w-5 rounded-full border border-border-subtle bg-bg-primary shadow-sm transition-transform ${
                              isDarkMode ? "translate-x-5" : "translate-x-1"
                            }`}
                          />
                        </button>
                      </div>
                      <p
                        className={`mt-3 text-[11px] ${
                          themeSyncStatus === "error" ? "text-danger" : "text-text-tertiary"
                        }`}
                      >
                        {themeFeedback}
                      </p>
                    </section>

                    <section className="rounded-xl border border-border-subtle bg-bg-surface p-4">
                      <div className="mb-3">
                        <p className="text-[13px] font-medium text-text-primary">{labels.settings.modelIntegration}</p>
                        <p className="mt-1 text-[11px] text-text-tertiary">
                          {labels.settings.manageIntegrationKeys}
                        </p>
                      </div>
                      <label className="mb-2 block text-[12px] font-sans text-text-secondary">
                        {labels.settings.modelscopeKeyLabel}
                      </label>
                      <input
                        type="password"
                        value={modelscopeKey}
                        onChange={(event) => setModelscopeKey(event.target.value)}
                        placeholder={labels.settings.modelscopeKeyPlaceholder}
                        disabled={!settingsAvailable}
                        className="w-full rounded-md border border-border-default bg-bg-primary px-3 py-2 text-sm font-sans text-text-primary placeholder:text-text-tertiary focus:border-accent-primary focus:outline-none focus:ring-2 focus:ring-accent-primary/20 disabled:opacity-60"
                      />
                      <div className="mt-3 flex items-center justify-between gap-3">
                        <button
                          type="button"
                          onClick={handleSaveModelscopeKey}
                          className="rounded-md bg-accent-primary px-3 py-1.5 text-xs font-medium text-text-inverse transition-colors hover:bg-accent-primary-hover"
                        >
                          {labels.settings.save}
                        </button>
                        <span className="text-right text-[11px] font-sans text-text-tertiary">
                          {settingsAvailable
                            ? settingsStatus === "saved"
                              ? labels.settings.savedLocally
                              : settingsStatus === "error"
                                ? labels.settings.saveFailed
                                : labels.settings.storedInChromeStorage
                          : labels.settings.availableInExtension}
                        </span>
                      </div>

                      <div className="mt-4 rounded-lg border border-border-subtle bg-bg-primary p-4">
                        <div className="mb-3">
                          <p className="text-[13px] font-medium text-text-primary">
                            {labels.settings.notionExportTitle}
                          </p>
                          <p className="mt-1 text-[11px] text-text-tertiary">
                            {labels.settings.notionExportDesc}
                          </p>
                        </div>

                        <div className="rounded-md border border-border-subtle bg-bg-primary px-3 py-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-[12px] font-sans font-medium text-text-primary">
                                {notionConnected
                                  ? notionSettings.workspaceName || labels.settings.notionWorkspaceConnected
                                  : notionAvailable
                                    ? labels.settings.connectToNotion
                                    : labels.settings.availableInExtension}
                              </div>
                              <p className="mt-1 text-[11px] font-sans leading-relaxed text-text-tertiary">
                                {notionConnected
                                  ? notionSettings.authMode === "legacy_manual"
                                    ? labels.settings.legacyToken
                                    : labels.settings.connectedChooseDatabase
                                  : notionAvailable
                                    ? labels.settings.oauthFlowDesc
                                    : labels.settings.oauthUnavailableOutsideExtension}
                              </p>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              <button
                                type="button"
                                onClick={() => void handleConnectNotion()}
                                disabled={!notionAvailable || notionStatus === "loading"}
                                className="rounded-md bg-accent-primary px-3 py-1.5 text-xs font-sans font-medium text-text-inverse transition-colors hover:bg-accent-primary-hover disabled:opacity-60"
                              >
                                {notionStatus === "loading"
                                  ? labels.settings.connecting
                                  : notionConnected
                                    ? labels.settings.change
                                    : labels.settings.connect}
                              </button>
                              {notionConnected ? (
                                <button
                                  type="button"
                                  onClick={() => void handleDisconnectNotion()}
                                  disabled={notionStatus === "loading"}
                                  className="rounded-md border border-border-subtle px-3 py-1.5 text-xs font-sans text-text-secondary transition-colors hover:bg-bg-secondary disabled:opacity-60"
                                >
                                  {labels.settings.disconnect}
                                </button>
                              ) : null}
                            </div>
                          </div>
                        </div>

                        {notionConnected ? (
                          <>
                            <label className="mb-2 mt-3 block text-[12px] font-sans text-text-secondary">
                              {labels.settings.targetDatabase}
                            </label>
                            <div className="flex gap-2">
                              <input
                                type="text"
                                value={notionDatabaseQuery}
                                onChange={(event) => {
                                  setNotionDatabaseQuery(event.target.value);
                                  setNotionDatabasesStatus("idle");
                                  setNotionDatabasesMessage("");
                                }}
                                placeholder={labels.settings.databaseSearchPlaceholder}
                                className="w-full rounded-md border border-border-default bg-bg-primary px-3 py-2 text-sm font-sans text-text-primary placeholder:text-text-tertiary focus:border-accent-primary focus:outline-none focus:ring-2 focus:ring-accent-primary/20"
                              />
                              <button
                                type="button"
                                onClick={() => void loadNotionDatabases()}
                                disabled={notionDatabasesStatus === "loading"}
                                className="inline-flex items-center gap-1 rounded-md border border-border-subtle px-3 py-1.5 text-xs font-sans text-text-secondary transition-colors hover:bg-bg-secondary disabled:opacity-60"
                              >
                                {notionDatabasesStatus === "loading" ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.6} />
                                )}
                                {labels.settings.refresh}
                              </button>
                            </div>
                            <p className="mt-2 text-[11px] font-sans leading-relaxed text-text-tertiary">
                              {labels.settings.shareDatabaseHint}
                            </p>

                            <div className="mt-3 rounded-md border border-border-subtle bg-bg-primary p-2">
                              {notionDatabases.length > 0 ? (
                                <div className="max-h-44 space-y-2 overflow-y-auto">
                                  {notionDatabases.map((database) => {
                                    const selected =
                                      database.id === notionSettings.selectedDatabaseId;
                                    return (
                                      <button
                                        key={database.id}
                                        type="button"
                                        onClick={() => void handleSelectNotionDatabase(database)}
                                        className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                                          selected
                                            ? "border-accent-primary/40 bg-accent-primary-light/40"
                                            : "border-transparent hover:border-border-subtle hover:bg-bg-secondary"
                                        }`}
                                      >
                                        <div className="text-[12px] font-sans font-medium text-text-primary">
                                          {database.title}
                                        </div>
                                        <div className="mt-1 text-[11px] font-sans text-text-tertiary">
                                          {database.id}
                                        </div>
                                      </button>
                                    );
                                  })}
                                </div>
                              ) : (
                                <div className="px-1 py-2 text-[11px] font-sans text-text-tertiary">
                                  {notionDatabasesStatus === "loading"
                                    ? labels.settings.loadingSharedDatabases
                                    : labels.settings.noDatabasesLoaded}
                                </div>
                              )}
                            </div>

                            <div className="mt-3 flex items-center justify-between">
                              <span className="text-right text-[11px] font-sans text-text-tertiary">
                                {notionExportReady
                                  ? `${labels.settings.selectedColon}${
                                      notionSettings.selectedDatabaseTitle ||
                                      notionSettings.selectedDatabaseId
                                    }`
                                  : labels.settings.chooseDatabase}
                              </span>
                            </div>
                          </>
                        ) : null}

                        <div className="mt-3 flex items-center justify-between">
                          <span className="text-right text-[11px] font-sans text-text-tertiary">
                            {settingsAvailable
                              ? notionStatus === "saved"
                                ? labels.settings.savedLocally
                                : notionStatus === "error"
                                  ? labels.settings.actionFailed
                                  : notionConnected
                                    ? labels.settings.readyForOneShotExport
                                    : labels.settings.storedInChromeStorage
                              : labels.settings.availableInExtension}
                          </span>
                        </div>
                        {notionMessage ? (
                          <p
                            className={`mt-2 text-[11px] font-sans ${
                              notionStatus === "error" ? "text-danger" : "text-text-secondary"
                            }`}
                          >
                            {notionMessage}
                          </p>
                        ) : null}
                        {notionDatabasesMessage ? (
                          <p
                            className={`mt-2 text-[11px] font-sans ${
                              notionDatabasesStatus === "error"
                                ? "text-danger"
                                : "text-text-tertiary"
                            }`}
                          >
                            {notionDatabasesMessage}
                          </p>
                        ) : null}
                      </div>
                    </section>
                  </div>
                ) : (
                  <DataManagementPanel storage={storage} labels={labels.data} />
                )}
              </div>
            </aside>
          </>
        )}
      </div>
    </LibraryDataProvider>
  );
}

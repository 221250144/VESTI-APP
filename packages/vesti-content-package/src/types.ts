export type ContentPackageCitationSourceType =
  | "inline_pill"
  | "search_card"
  | "reference_list"
  | "unknown";

export interface ContentPackageCitationLike {
  label: string;
  href: string;
  host: string;
  sourceType: ContentPackageCitationSourceType;
}

export type ContentPackageArtifactKind =
  | "canvas"
  | "preview"
  | "code_artifact"
  | "download_card"
  | "standalone_artifact"
  | "unknown";

export type ContentPackageArtifactCaptureMode =
  | "presence_only"
  | "embedded_dom_snapshot"
  | "standalone_artifact";

export interface ContentPackageArtifactLike {
  kind: ContentPackageArtifactKind;
  label?: string;
  captureMode?: ContentPackageArtifactCaptureMode;
  renderDimensions?: { width: number; height: number };
  plainText?: string;
  markdownSnapshot?: string;
  normalizedHtmlSnapshot?: string;
}

export type ContentPackageAttachmentOccurrenceRole = "user_upload";

export interface ContentPackageAttachmentLike {
  indexAlt: string;
  label?: string;
  mime?: string | null;
  occurrenceRole: ContentPackageAttachmentOccurrenceRole;
}

export interface ContentPackageMessageLike {
  content_text: string;
  citations?: ContentPackageCitationLike[];
  attachments?: ContentPackageAttachmentLike[];
  artifacts?: ContentPackageArtifactLike[];
}

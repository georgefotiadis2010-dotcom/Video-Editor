export type FontFamilyOption = "inter" | "marker" | "impact";

export type PillStyleOption = "black" | "crimson" | "white" | "outline";

export type AspectMode = "force-9x16" | "original";

export interface TextStyleConfig {
  fontFamily: FontFamilyOption;
  fontSize: number; // Base px at 1080w
  yPositionPercent: number; // 10 - 88
  maxWidthPercent: number; // 55 - 92
  textColor: string;
  pillStyle: PillStyleOption;
  pillOpacity: number; // 0.3 - 1.0
  uppercase: boolean;
  lineHeight: number; // 1.15 - 1.5
}

export interface TextPreset {
  id: string;
  label: string;
  badge: string;
  config: Partial<TextStyleConfig>;
}

export interface VideoMetadata {
  file: File;
  url: string;
  width: number;
  height: number;
  duration: number;
  sizeBytes: number;
}

export interface RenderedClip {
  id: string;
  index: number;
  hookText: string;
  filename: string;
  blob: Blob;
  url: string;
  sizeBytes: number;
  renderMs: number;
}

export type RenderPhase =
  | "idle"
  | "loading-ffmpeg"
  | "rendering"
  | "completed"
  | "cancelled"
  | "error";

export type EditorMode = "beat-sync" | "single-loop";

export type BeatDensity = "every-beat" | "balanced" | "every-2-beats";

export type ClipArrangementMode = "shuffle-per-hook" | "shared-edit";

export interface SourceClipItem extends VideoMetadata {
  id: string;
}

export interface AudioAnalysis {
  file: File;
  url: string;
  duration: number;
  bpm: number;
  waveformPeaks: number[];
  beats: number[];
  drops: number[];
  recommendedStart: number;
  recommendedEnd: number;
}

export interface BeatCutSegment {
  index: number;
  startTime: number;
  endTime: number;
  duration: number;
  clipId: string;
  clipName: string;
  sourceStart: number;
}

import { fetchFile, toBlobURL } from "@ffmpeg/util";
import type {
  AspectMode,
  BeatCutSegment,
  SourceClipItem,
} from "@/types/renderer";

interface FFmpegProgressEvent {
  progress: number;
  time: number;
}

interface FFmpegLogEvent {
  type: string;
  message: string;
}

interface FFmpegInstance {
  loaded: boolean;
  load: (config: {
    coreURL: string;
    wasmURL: string;
  }) => Promise<boolean>;
  on: {
    (event: "log", cb: (e: FFmpegLogEvent) => void): void;
    (event: "progress", cb: (e: FFmpegProgressEvent) => void): void;
  };
  off: {
    (event: "log", cb: (e: FFmpegLogEvent) => void): void;
    (event: "progress", cb: (e: FFmpegProgressEvent) => void): void;
  };
  writeFile: (path: string, data: Uint8Array) => Promise<boolean>;
  readFile: (path: string) => Promise<Uint8Array | string>;
  deleteFile: (path: string) => Promise<boolean>;
  exec: (args: string[]) => Promise<number>;
  terminate: () => void;
}

declare global {
  interface Window {
    FFmpegWASM?: {
      FFmpeg: new () => FFmpegInstance;
    };
  }
}

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

let ffmpegInstance: FFmpegInstance | null = null;
let loadPromise: Promise<FFmpegInstance> | null = null;
let scriptPromise: Promise<void> | null = null;

function loadFFmpegScript(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("FFmpeg.wasm can only run in the browser."));
  }
  if (window.FFmpegWASM?.FFmpeg) {
    return Promise.resolve();
  }
  if (scriptPromise) {
    return scriptPromise;
  }

  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${BASE_PATH}/ffmpeg/ffmpeg.js`;
    script.async = true;
    script.onload = () => {
      if (window.FFmpegWASM?.FFmpeg) {
        resolve();
      } else {
        reject(new Error(`FFmpegWASM failed to initialize from ${BASE_PATH}/ffmpeg/ffmpeg.js`));
      }
    };
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error(`Failed to load ${BASE_PATH}/ffmpeg/ffmpeg.js`));
    };
    document.head.appendChild(script);
  });

  return scriptPromise;
}

export async function getFFmpeg(
  onLog?: (message: string) => void
): Promise<FFmpegInstance> {
  if (ffmpegInstance && ffmpegInstance.loaded) {
    return ffmpegInstance;
  }

  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = (async () => {
    await loadFFmpegScript();
    const FFmpegCtor = window.FFmpegWASM?.FFmpeg;
    if (!FFmpegCtor) {
      throw new Error("FFmpeg constructor unavailable.");
    }

    const ffmpeg = new FFmpegCtor();
    if (onLog) {
      ffmpeg.on("log", ({ message }) => onLog(message));
    }

    const coreURL = await toBlobURL(
      `${BASE_PATH}/ffmpeg/ffmpeg-core.js`,
      "text/javascript"
    );
    const wasmURL = await toBlobURL(
      `${BASE_PATH}/ffmpeg/ffmpeg-core.wasm`,
      "application/wasm"
    );

    await ffmpeg.load({ coreURL, wasmURL });
    ffmpegInstance = ffmpeg;
    return ffmpeg;
  })();

  try {
    return await loadPromise;
  } catch (err) {
    loadPromise = null;
    ffmpegInstance = null;
    throw err;
  }
}

export function resetFFmpeg(): void {
  if (ffmpegInstance) {
    try {
      ffmpegInstance.terminate();
    } catch {
      // Ignore termination errors
    }
  }
  ffmpegInstance = null;
  loadPromise = null;
}

export interface RenderHookJobParams {
  ffmpeg: FFmpegInstance;
  sourceFile: File;
  sourceWritten: boolean;
  overlayPngBytes: Uint8Array;
  outputFilename: string;
  aspectMode: AspectMode;
  muteAudio: boolean;
  onProgress?: (ratio: number) => void;
}

export async function renderSingleHookVideo({
  ffmpeg,
  sourceFile,
  sourceWritten,
  overlayPngBytes,
  outputFilename,
  aspectMode,
  muteAudio,
  onProgress,
}: RenderHookJobParams): Promise<Blob> {
  const inputName = "input_source.mp4";
  const overlayName = "hook_overlay.png";
  const outName = "output_clip.mp4";

  if (!sourceWritten) {
    await ffmpeg.writeFile(inputName, await fetchFile(sourceFile));
  }

  await ffmpeg.writeFile(overlayName, overlayPngBytes);

  const progressHandler = ({ progress }: FFmpegProgressEvent) => {
    if (onProgress) {
      onProgress(Math.max(0, Math.min(1, progress)));
    }
  };

  ffmpeg.on("progress", progressHandler);

  try {
    const filterComplex =
      aspectMode === "force-9x16"
        ? "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[bg];[bg][1:v]overlay=0:0:format=auto[v]"
        : "[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2[bg];[bg][1:v]overlay=0:0:format=auto[v]";

    const args = [
      "-i",
      inputName,
      "-i",
      overlayName,
      "-filter_complex",
      filterComplex,
      "-map",
      "[v]",
      ...(muteAudio ? ["-an"] : ["-map", "0:a?", "-c:a", "copy"]),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-y",
      outName,
    ];

    const exitCode = await ffmpeg.exec(args);
    if (exitCode !== 0) {
      throw new Error(`FFmpeg exited with code ${exitCode} on ${outputFilename}`);
    }

    const data = await ffmpeg.readFile(outName);
    const uint8 =
      data instanceof Uint8Array ? data : new TextEncoder().encode(data);
    const copy = new Uint8Array(uint8.byteLength);
    copy.set(uint8);

    return new Blob([copy.buffer], { type: "video/mp4" });
  } finally {
    ffmpeg.off("progress", progressHandler);
    await ffmpeg.deleteFile(overlayName).catch(() => {});
    await ffmpeg.deleteFile(outName).catch(() => {});
  }
}

export async function cleanupSourceFile(ffmpeg: FFmpegInstance): Promise<void> {
  await ffmpeg.deleteFile("input_source.mp4").catch(() => {});
}

function getAudioExtension(file: File): string {
  const match = file.name.toLowerCase().match(/\.(mp3|wav|m4a|aac|ogg|flac)$/);
  return match ? match[1] : "mp3";
}

function getTargetDimensions(
  clips: SourceClipItem[],
  aspectMode: AspectMode
): { width: number; height: number } {
  if (aspectMode === "force-9x16" || clips.length === 0) {
    return { width: 1080, height: 1920 };
  }
  const first = clips[0];
  return {
    width: Math.max(2, Math.floor(first.width / 2) * 2),
    height: Math.max(2, Math.floor(first.height / 2) * 2),
  };
}

export async function prepareBeatSyncAssets(
  ffmpeg: FFmpegInstance,
  clips: SourceClipItem[],
  audioFile: File
): Promise<{ clipFileMap: Map<string, string>; audioFileName: string }> {
  const clipFileMap = new Map<string, string>();
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const ext = clip.file.name.toLowerCase().endsWith(".mov") ? "mov" : "mp4";
    const fsName = `bs_src_${i}.${ext}`;
    await ffmpeg.writeFile(fsName, await fetchFile(clip.file));
    clipFileMap.set(clip.id, fsName);
  }

  const audioExt = getAudioExtension(audioFile);
  const audioFileName = `bs_audio.${audioExt}`;
  await ffmpeg.writeFile(audioFileName, await fetchFile(audioFile));

  return { clipFileMap, audioFileName };
}

export async function cleanupBeatSyncAssets(
  ffmpeg: FFmpegInstance,
  clipFileMap: Map<string, string>,
  audioFileName: string
): Promise<void> {
  for (const fsName of clipFileMap.values()) {
    await ffmpeg.deleteFile(fsName).catch(() => {});
  }
  await ffmpeg.deleteFile(audioFileName).catch(() => {});
  await ffmpeg.deleteFile("bs_base_synced.mp4").catch(() => {});
}

async function renderCutSegments(
  ffmpeg: FFmpegInstance,
  segments: BeatCutSegment[],
  clips: SourceClipItem[],
  clipFileMap: Map<string, string>,
  aspectMode: AspectMode,
  onSegmentProgress?: (completed: number, total: number) => void
): Promise<string[]> {
  const { width, height } = getTargetDimensions(clips, aspectMode);
  const clipDurationMap = new Map(clips.map((c) => [c.id, c.duration]));
  const segNames: string[] = [];

  const vfFilter =
    aspectMode === "force-9x16"
      ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=30`
      : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30`;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const srcName = clipFileMap.get(seg.clipId);
    if (!srcName) {
      throw new Error(`Missing source clip in virtual FS for ${seg.clipName}`);
    }

    const segOut = `bs_seg_${i}.mp4`;
    const clipDur = clipDurationMap.get(seg.clipId) ?? seg.duration;
    const needsLoop = clipDur < seg.duration + 0.05;

    const args = needsLoop
      ? [
          "-stream_loop",
          "-1",
          "-i",
          srcName,
          "-ss",
          "0",
          "-t",
          seg.duration.toFixed(3),
          "-vf",
          vfFilter,
          "-an",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-crf",
          "23",
          "-pix_fmt",
          "yuv420p",
          "-y",
          segOut,
        ]
      : [
          "-ss",
          seg.sourceStart.toFixed(3),
          "-t",
          seg.duration.toFixed(3),
          "-i",
          srcName,
          "-vf",
          vfFilter,
          "-an",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-crf",
          "23",
          "-pix_fmt",
          "yuv420p",
          "-y",
          segOut,
        ];

    const exitCode = await ffmpeg.exec(args);
    if (exitCode !== 0) {
      throw new Error(
        `FFmpeg failed trimming beat segment ${i + 1} (exit ${exitCode})`
      );
    }

    segNames.push(segOut);
    onSegmentProgress?.(i + 1, segments.length);
  }

  return segNames;
}

async function cleanupSegments(
  ffmpeg: FFmpegInstance,
  segNames: string[]
): Promise<void> {
  for (const name of segNames) {
    await ffmpeg.deleteFile(name).catch(() => {});
  }
  await ffmpeg.deleteFile("bs_concat.txt").catch(() => {});
}

export interface BeatSyncSharedBaseParams {
  ffmpeg: FFmpegInstance;
  segments: BeatCutSegment[];
  clips: SourceClipItem[];
  clipFileMap: Map<string, string>;
  audioFileName: string;
  windowStart: number;
  windowEnd: number;
  aspectMode: AspectMode;
  onProgress?: (ratio: number) => void;
}

export async function buildBeatSyncedBaseVideo({
  ffmpeg,
  segments,
  clips,
  clipFileMap,
  audioFileName,
  windowStart,
  windowEnd,
  aspectMode,
  onProgress,
}: BeatSyncSharedBaseParams): Promise<void> {
  const totalDuration = Math.max(0.5, windowEnd - windowStart);
  const segNames = await renderCutSegments(
    ffmpeg,
    segments,
    clips,
    clipFileMap,
    aspectMode,
    (done, total) => onProgress?.((done / total) * 0.8)
  );

  const concatText = segNames.map((n) => `file '${n}'`).join("\n");
  await ffmpeg.writeFile("bs_concat.txt", new TextEncoder().encode(concatText));

  const fadeOutStart = Math.max(0, totalDuration - 0.35).toFixed(3);
  const audioFilter = `afade=t=in:st=0:d=0.1,afade=t=out:st=${fadeOutStart}:d=0.35`;

  try {
    const exitCode = await ffmpeg.exec([
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      "bs_concat.txt",
      "-ss",
      windowStart.toFixed(3),
      "-t",
      totalDuration.toFixed(3),
      "-i",
      audioFileName,
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-c:v",
      "copy",
      "-af",
      audioFilter,
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      "-movflags",
      "+faststart",
      "-y",
      "bs_base_synced.mp4",
    ]);

    if (exitCode !== 0) {
      throw new Error(`FFmpeg failed assembling beat-synced base (exit ${exitCode})`);
    }
    onProgress?.(1);
  } finally {
    await cleanupSegments(ffmpeg, segNames);
  }
}

export async function renderHookOnSyncedBase(
  ffmpeg: FFmpegInstance,
  overlayPngBytes: Uint8Array,
  outputFilename: string,
  onProgress?: (ratio: number) => void
): Promise<Blob> {
  const overlayName = "bs_hook_overlay.png";
  const outName = "bs_output_clip.mp4";
  await ffmpeg.writeFile(overlayName, overlayPngBytes);

  const progressHandler = ({ progress }: FFmpegProgressEvent) => {
    onProgress?.(Math.max(0, Math.min(1, progress)));
  };
  ffmpeg.on("progress", progressHandler);

  try {
    const exitCode = await ffmpeg.exec([
      "-i",
      "bs_base_synced.mp4",
      "-i",
      overlayName,
      "-filter_complex",
      "[0:v][1:v]overlay=0:0:format=auto[v]",
      "-map",
      "[v]",
      "-map",
      "0:a?",
      "-c:a",
      "copy",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-y",
      outName,
    ]);

    if (exitCode !== 0) {
      throw new Error(`FFmpeg exited with code ${exitCode} on ${outputFilename}`);
    }

    const data = await ffmpeg.readFile(outName);
    const uint8 =
      data instanceof Uint8Array ? data : new TextEncoder().encode(data);
    const copy = new Uint8Array(uint8.byteLength);
    copy.set(uint8);

    return new Blob([copy.buffer], { type: "video/mp4" });
  } finally {
    ffmpeg.off("progress", progressHandler);
    await ffmpeg.deleteFile(overlayName).catch(() => {});
    await ffmpeg.deleteFile(outName).catch(() => {});
  }
}

export interface RenderSingleBeatSyncedReelParams {
  ffmpeg: FFmpegInstance;
  segments: BeatCutSegment[];
  clips: SourceClipItem[];
  clipFileMap: Map<string, string>;
  audioFileName: string;
  windowStart: number;
  windowEnd: number;
  overlayPngBytes: Uint8Array;
  outputFilename: string;
  aspectMode: AspectMode;
  onProgress?: (ratio: number) => void;
}

export async function renderSingleBeatSyncedReel({
  ffmpeg,
  segments,
  clips,
  clipFileMap,
  audioFileName,
  windowStart,
  windowEnd,
  overlayPngBytes,
  outputFilename,
  aspectMode,
  onProgress,
}: RenderSingleBeatSyncedReelParams): Promise<Blob> {
  const totalDuration = Math.max(0.5, windowEnd - windowStart);
  const segNames = await renderCutSegments(
    ffmpeg,
    segments,
    clips,
    clipFileMap,
    aspectMode,
    (done, total) => onProgress?.((done / total) * 0.65)
  );

  const concatText = segNames.map((n) => `file '${n}'`).join("\n");
  await ffmpeg.writeFile("bs_concat.txt", new TextEncoder().encode(concatText));

  const overlayName = "bs_hook_overlay.png";
  const outName = "bs_output_clip.mp4";
  await ffmpeg.writeFile(overlayName, overlayPngBytes);

  const fadeOutStart = Math.max(0, totalDuration - 0.35).toFixed(3);
  const audioFilter = `afade=t=in:st=0:d=0.1,afade=t=out:st=${fadeOutStart}:d=0.35`;

  const progressHandler = ({ progress }: FFmpegProgressEvent) => {
    onProgress?.(0.65 + Math.max(0, Math.min(1, progress)) * 0.35);
  };
  ffmpeg.on("progress", progressHandler);

  try {
    const exitCode = await ffmpeg.exec([
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      "bs_concat.txt",
      "-ss",
      windowStart.toFixed(3),
      "-t",
      totalDuration.toFixed(3),
      "-i",
      audioFileName,
      "-i",
      overlayName,
      "-filter_complex",
      "[0:v][2:v]overlay=0:0:format=auto[v]",
      "-map",
      "[v]",
      "-map",
      "1:a",
      "-af",
      audioFilter,
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-shortest",
      "-movflags",
      "+faststart",
      "-y",
      outName,
    ]);

    if (exitCode !== 0) {
      throw new Error(`FFmpeg exited with code ${exitCode} on ${outputFilename}`);
    }

    const data = await ffmpeg.readFile(outName);
    const uint8 =
      data instanceof Uint8Array ? data : new TextEncoder().encode(data);
    const copy = new Uint8Array(uint8.byteLength);
    copy.set(uint8);

    return new Blob([copy.buffer], { type: "video/mp4" });
  } finally {
    ffmpeg.off("progress", progressHandler);
    await cleanupSegments(ffmpeg, segNames);
    await ffmpeg.deleteFile(overlayName).catch(() => {});
    await ffmpeg.deleteFile(outName).catch(() => {});
  }
}

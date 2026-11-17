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

interface WorkerFSBlobEntry {
  name: string;
  data: Blob;
}

export interface FFmpegInstance {
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
  createDir?: (path: string) => Promise<boolean>;
  deleteDir?: (path: string) => Promise<boolean>;
  mount?: (
    fsType: "WORKERFS",
    options: { blobs?: WorkerFSBlobEntry[]; files?: File[] },
    mountPoint: string
  ) => Promise<boolean>;
  unmount?: (mountPoint: string) => Promise<boolean>;
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
let loadGeneration = 0;

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
        scriptPromise = null;
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
  if (ffmpegInstance) {
    if (ffmpegInstance.loaded) {
      return ffmpegInstance;
    }
    // Stale/unloaded instance; clean up and reload
    try {
      ffmpegInstance.terminate();
    } catch {
      // Ignore termination errors
    }
    ffmpegInstance = null;
  }

  if (loadPromise) {
    return loadPromise;
  }

  const gen = ++loadGeneration;
  loadPromise = (async () => {
    await loadFFmpegScript();
    if (gen !== loadGeneration) {
      throw new Error("FFmpeg load was cancelled.");
    }

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

    if (gen !== loadGeneration) {
      try {
        ffmpeg.terminate();
      } catch {
        // Ignore
      }
      throw new Error("FFmpeg load was cancelled.");
    }

    await ffmpeg.load({ coreURL, wasmURL });

    if (gen !== loadGeneration) {
      try {
        ffmpeg.terminate();
      } catch {
        // Ignore
      }
      throw new Error("FFmpeg load was cancelled.");
    }

    if (!ffmpeg.loaded) {
      throw new Error("FFmpeg failed to load WebAssembly core.");
    }

    ffmpegInstance = ffmpeg;
    return ffmpeg;
  })();

  try {
    return await loadPromise;
  } catch (err) {
    if (gen === loadGeneration) {
      loadPromise = null;
      ffmpegInstance = null;
    }
    throw err;
  }
}

export function resetFFmpeg(): void {
  loadGeneration += 1;
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

export function isFFmpegLoaded(): boolean {
  return Boolean(ffmpegInstance && ffmpegInstance.loaded);
}

export function formatFFmpegError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return "Unknown FFmpeg rendering error.";
}

function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(1, progress));
}

function createThrottledProgress(
  onProgress?: (ratio: number) => void
): ((event: FFmpegProgressEvent) => void) | null {
  if (!onProgress) return null;
  let lastRatio = -1;
  let lastEmit = 0;
  return ({ progress }: FFmpegProgressEvent) => {
    const ratio = clampProgress(progress);
    const now = performance.now();
    if (
      lastRatio < 0 ||
      ratio === 1 ||
      (Math.abs(ratio - lastRatio) >= 0.015 && now - lastEmit >= 90)
    ) {
      lastRatio = ratio;
      lastEmit = now;
      onProgress(ratio);
    }
  };
}

/**
 * Mounts File/Blob objects into FFmpeg's WORKERFS without copying bytes into RAM.
 * Falls back to MEMFS writeFile only if WORKERFS mount is unavailable.
 */
async function mountInputBlobs(
  ffmpeg: FFmpegInstance,
  mountDir: string,
  entries: { fsName: string; file: Blob }[]
): Promise<{ usedWorkerFs: boolean; paths: Map<string, string> }> {
  const paths = new Map<string, string>();
  if (typeof ffmpeg.mount === "function" && typeof ffmpeg.createDir === "function") {
    try {
      await ffmpeg.unmount?.(mountDir).catch(() => {});
      await ffmpeg.createDir(mountDir).catch(() => {});
      await ffmpeg.mount(
        "WORKERFS",
        {
          blobs: entries.map((e) => ({ name: e.fsName, data: e.file })),
        },
        mountDir
      );
      for (const e of entries) {
        paths.set(e.fsName, `${mountDir}/${e.fsName}`);
      }
      return { usedWorkerFs: true, paths };
    } catch {
      // Fall back to MEMFS writeFile below
    }
  }

  for (const e of entries) {
    await ffmpeg.writeFile(e.fsName, await fetchFile(e.file));
    paths.set(e.fsName, e.fsName);
  }
  return { usedWorkerFs: false, paths };
}

async function unmountInputDir(
  ffmpeg: FFmpegInstance,
  mountDir: string,
  fallbackNames: string[]
): Promise<void> {
  if (!ffmpeg.loaded) return;
  await ffmpeg.unmount?.(mountDir).catch(() => {});
  for (const name of fallbackNames) {
    await ffmpeg.deleteFile(name).catch(() => {});
  }
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

const SINGLE_LOOP_MOUNT_DIR = "/src_loop";
const BEAT_SYNC_MOUNT_DIR = "/src_bs";

export async function prepareSingleLoopBase(
  ffmpeg: FFmpegInstance,
  sourceFile: File,
  aspectMode: AspectMode,
  muteAudio: boolean,
  onProgress?: (ratio: number) => void
): Promise<void> {
  const inputFileName = "input_source.mp4";
  const baseName = "loop_base.mp4";
  const mounted = await mountInputBlobs(ffmpeg, SINGLE_LOOP_MOUNT_DIR, [
    { fsName: inputFileName, file: sourceFile },
  ]);
  const inputPath = mounted.paths.get(inputFileName) ?? inputFileName;

  const vf =
    aspectMode === "force-9x16"
      ? "scale=1080:1920:force_original_aspect_ratio=increase:flags=fast_bilinear,crop=1080:1920,setsar=1"
      : "scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=fast_bilinear,setsar=1";

  const progressHandler = createThrottledProgress(onProgress);
  if (progressHandler) {
    ffmpeg.on("progress", progressHandler);
  }

  try {
    const args = [
      "-i",
      inputPath,
      "-vf",
      vf,
      ...(muteAudio ? ["-an"] : ["-map", "0:v", "-map", "0:a?", "-c:a", "copy"]),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "21",
      "-pix_fmt",
      "yuv420p",
      "-y",
      baseName,
    ];

    const exitCode = await ffmpeg.exec(args);
    if (exitCode !== 0) {
      throw new Error(`FFmpeg failed preparing background loop (exit ${exitCode})`);
    }
  } finally {
    if (progressHandler) {
      ffmpeg.off("progress", progressHandler);
    }
    await unmountInputDir(ffmpeg, SINGLE_LOOP_MOUNT_DIR, [inputFileName]);
  }
}

export async function renderHookOnSingleLoopBase(
  ffmpeg: FFmpegInstance,
  overlayPngBytes: Uint8Array,
  outputFilename: string,
  muteAudio: boolean,
  onProgress?: (ratio: number) => void
): Promise<Blob> {
  const baseName = "loop_base.mp4";
  const overlayName = "hook_overlay.png";
  const outName = "output_clip.mp4";

  await ffmpeg.writeFile(overlayName, overlayPngBytes);

  const progressHandler = createThrottledProgress(onProgress);
  if (progressHandler) {
    ffmpeg.on("progress", progressHandler);
  }

  try {
    const args = [
      "-i",
      baseName,
      "-i",
      overlayName,
      "-filter_complex",
      "[0:v][1:v]overlay=0:0:format=auto[v]",
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
    if (progressHandler) {
      ffmpeg.off("progress", progressHandler);
    }
    if (ffmpeg.loaded) {
      await ffmpeg.deleteFile(overlayName).catch(() => {});
      await ffmpeg.deleteFile(outName).catch(() => {});
    }
  }
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
  const inputFileName = "input_source.mp4";
  const overlayName = "hook_overlay.png";
  const outName = "output_clip.mp4";

  let inputPath = `${SINGLE_LOOP_MOUNT_DIR}/${inputFileName}`;
  if (!sourceWritten) {
    const mounted = await mountInputBlobs(ffmpeg, SINGLE_LOOP_MOUNT_DIR, [
      { fsName: inputFileName, file: sourceFile },
    ]);
    inputPath = mounted.paths.get(inputFileName) ?? inputFileName;
  }

  await ffmpeg.writeFile(overlayName, overlayPngBytes);

  const progressHandler = createThrottledProgress(onProgress);
  if (progressHandler) {
    ffmpeg.on("progress", progressHandler);
  }

  try {
    const filterComplex =
      aspectMode === "force-9x16"
        ? "[0:v]scale=1080:1920:force_original_aspect_ratio=increase:flags=fast_bilinear,crop=1080:1920,setsar=1[bg];[bg][1:v]overlay=0:0:format=auto[v]"
        : "[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=fast_bilinear[bg];[bg][1:v]overlay=0:0:format=auto[v]";

    const args = [
      "-i",
      inputPath,
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
    if (progressHandler) {
      ffmpeg.off("progress", progressHandler);
    }
    if (ffmpeg.loaded) {
      await ffmpeg.deleteFile(overlayName).catch(() => {});
      await ffmpeg.deleteFile(outName).catch(() => {});
    }
  }
}

export async function cleanupSourceFile(ffmpeg: FFmpegInstance): Promise<void> {
  if (!ffmpeg.loaded) return;
  await unmountInputDir(ffmpeg, SINGLE_LOOP_MOUNT_DIR, ["input_source.mp4"]);
  await ffmpeg.deleteFile("loop_base.mp4").catch(() => {});
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
  audioFile: File,
  onProgress?: (done: number, total: number, currentName: string) => void
): Promise<{ clipFileMap: Map<string, string>; audioFileName: string }> {
  const entries: { fsName: string; file: Blob; clipId?: string }[] = [];
  const total = clips.length + 1;

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const ext = clip.file.name.toLowerCase().endsWith(".mov") ? "mov" : "mp4";
    const fsName = `bs_src_${i}.${ext}`;
    entries.push({ fsName, file: clip.file, clipId: clip.id });
  }

  const audioExt = getAudioExtension(audioFile);
  const audioFsName = `bs_audio.${audioExt}`;
  entries.push({ fsName: audioFsName, file: audioFile });

  onProgress?.(0, total, clips[0]?.file.name ?? audioFile.name);
  const mounted = await mountInputBlobs(ffmpeg, BEAT_SYNC_MOUNT_DIR, entries);

  const clipFileMap = new Map<string, string>();
  for (const entry of entries) {
    if (entry.clipId) {
      clipFileMap.set(
        entry.clipId,
        mounted.paths.get(entry.fsName) ?? entry.fsName
      );
    }
  }
  const audioFileName = mounted.paths.get(audioFsName) ?? audioFsName;
  onProgress?.(total, total, audioFile.name);

  return { clipFileMap, audioFileName };
}

export async function cleanupBeatSyncAssets(
  ffmpeg: FFmpegInstance,
  clipFileMap: Map<string, string>,
  audioFileName: string
): Promise<void> {
  if (!ffmpeg.loaded) return;
  const fallbackNames = [
    ...Array.from(clipFileMap.values()).filter((p) => !p.startsWith("/")),
    ...(audioFileName.startsWith("/") ? [] : [audioFileName]),
  ];
  await unmountInputDir(ffmpeg, BEAT_SYNC_MOUNT_DIR, fallbackNames);
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
  if (segments.length === 0) {
    throw new Error("No valid beat segments to render in the selected window.");
  }
  const { width, height } = getTargetDimensions(clips, aspectMode);
  const clipDurationMap = new Map(clips.map((c) => [c.id, c.duration]));
  const segNames: string[] = [];

  const vfFilter =
    aspectMode === "force-9x16"
      ? `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=fast_bilinear,crop=${width}:${height},setsar=1,fps=30`
      : `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=fast_bilinear,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30`;

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
  if (!ffmpeg.loaded) return;
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

  const progressHandler = createThrottledProgress(onProgress);
  if (progressHandler) {
    ffmpeg.on("progress", progressHandler);
  }

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
    if (progressHandler) {
      ffmpeg.off("progress", progressHandler);
    }
    if (ffmpeg.loaded) {
      await ffmpeg.deleteFile(overlayName).catch(() => {});
      await ffmpeg.deleteFile(outName).catch(() => {});
    }
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

  const progressHandler = createThrottledProgress(
    onProgress ? (ratio) => onProgress(0.65 + ratio * 0.35) : undefined
  );
  if (progressHandler) {
    ffmpeg.on("progress", progressHandler);
  }

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
    if (progressHandler) {
      ffmpeg.off("progress", progressHandler);
    }
    await cleanupSegments(ffmpeg, segNames);
    if (ffmpeg.loaded) {
      await ffmpeg.deleteFile(overlayName).catch(() => {});
      await ffmpeg.deleteFile(outName).catch(() => {});
    }
  }
}

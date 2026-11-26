import { fetchFile, toBlobURL } from "@ffmpeg/util";
import { buildFFmpegVideoChain } from "@/lib/video-effects";
import type {
  AspectMode,
  BeatCutSegment,
  SourceClipItem,
  VideoCropRect,
  VideoFilterConfig,
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
  videoFilter?: VideoFilterConfig;
  videoCrop?: VideoCropRect;
  onProgress?: (ratio: number) => void;
}

const SINGLE_LOOP_MOUNT_DIR = "/src_loop";
const BEAT_SYNC_MOUNT_DIR = "/src_bs";

export async function prepareSingleLoopBase(
  ffmpeg: FFmpegInstance,
  sourceFile: File,
  aspectMode: AspectMode,
  muteAudio: boolean,
  onProgress?: (ratio: number) => void,
  videoFilter?: VideoFilterConfig,
  videoCrop?: VideoCropRect
): Promise<void> {
  const inputFileName = "input_source.mp4";
  const baseName = "loop_base.mp4";
  const mounted = await mountInputBlobs(ffmpeg, SINGLE_LOOP_MOUNT_DIR, [
    { fsName: inputFileName, file: sourceFile },
  ]);
  const inputPath = mounted.paths.get(inputFileName) ?? inputFileName;

  const vf = buildFFmpegVideoChain({
    aspectMode,
    crop: videoCrop,
    filter: videoFilter,
  });

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
  videoFilter,
  videoCrop,
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
    const bgChain = buildFFmpegVideoChain({
      aspectMode,
      crop: videoCrop,
      filter: videoFilter,
    });
    const filterComplex = `[0:v]${bgChain}[bg];[bg][1:v]overlay=0:0:format=auto[v]`;

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

function buildSegmentMotionAndEffectFilters(
  seg: BeatCutSegment,
  targetWidth: number,
  targetHeight: number
): string[] {
  const filters: string[] = [];

  if (seg.speed && Math.abs(seg.speed - 1) > 0.02) {
    filters.push(`setpts=PTS/${seg.speed.toFixed(3)}`);
  }

  const zoom = seg.zoom ?? 1;
  if (zoom > 1.01) {
    const scaledW = Math.max(targetWidth, Math.round((targetWidth * zoom) / 2) * 2);
    const scaledH = Math.max(targetHeight, Math.round((targetHeight * zoom) / 2) * 2);
    const maxOffsetX = Math.max(0, scaledW - targetWidth);
    const maxOffsetY = Math.max(0, scaledH - targetHeight);
    const panX = Math.max(-1, Math.min(1, seg.panX ?? 0));
    const panY = Math.max(-1, Math.min(1, seg.panY ?? 0));
    const cropX = Math.round(((panX + 1) / 2) * maxOffsetX);
    const cropY = Math.round(((panY + 1) / 2) * maxOffsetY);
    filters.push(
      `scale=${scaledW}:${scaledH}:flags=lanczos`,
      `crop=${targetWidth}:${targetHeight}:${cropX}:${cropY}`
    );
  }

  if (seg.effect === "rgb-glitch") {
    filters.push("rgbashift=rh=4:bh=-4:enable='lt(t,0.12)'");
  } else if (seg.effect === "vhs-tape") {
    filters.push("noise=alls=14:allf=t+u");
  } else if (seg.effect === "halation-bloom") {
    filters.push("gblur=sigma=0.6");
  } else if (seg.effect === "dim-backdrop") {
    filters.push("eq=brightness=-0.12:contrast=1.08");
  }

  if (seg.transitionFlash) {
    filters.push("eq=brightness=0.28:enable='lt(t,0.08)'");
  }

  return filters;
}

async function renderCutSegments(
  ffmpeg: FFmpegInstance,
  segments: BeatCutSegment[],
  clips: SourceClipItem[],
  clipFileMap: Map<string, string>,
  aspectMode: AspectMode,
  onSegmentProgress?: (completed: number, total: number) => void,
  videoFilter?: VideoFilterConfig,
  videoCrop?: VideoCropRect
): Promise<string[]> {
  if (segments.length === 0) {
    throw new Error("No valid beat segments to render in the selected window.");
  }
  const { width, height } = getTargetDimensions(clips, aspectMode);
  const clipDurationMap = new Map(clips.map((c) => [c.id, c.duration]));
  const segNames: string[] = [];

  const baseVfFilter = buildFFmpegVideoChain({
    aspectMode,
    targetWidth: width,
    targetHeight: height,
    crop: videoCrop,
    filter: videoFilter,
    fps: 30,
  });

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const srcName = clipFileMap.get(seg.clipId);
    if (!srcName) {
      throw new Error(`Missing source clip in virtual FS for ${seg.clipName}`);
    }

    const segFilters = buildSegmentMotionAndEffectFilters(seg, width, height);
    const vfFilter =
      segFilters.length > 0
        ? `${baseVfFilter},${segFilters.join(",")}`
        : baseVfFilter;

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
  videoFilter?: VideoFilterConfig;
  videoCrop?: VideoCropRect;
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
  videoFilter,
  videoCrop,
  onProgress,
}: BeatSyncSharedBaseParams): Promise<void> {
  const totalDuration = Math.max(0.5, windowEnd - windowStart);
  const segNames = await renderCutSegments(
    ffmpeg,
    segments,
    clips,
    clipFileMap,
    aspectMode,
    (done, total) => onProgress?.((done / total) * 0.8),
    videoFilter,
    videoCrop
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
  videoFilter?: VideoFilterConfig;
  videoCrop?: VideoCropRect;
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
  videoFilter,
  videoCrop,
  onProgress,
}: RenderSingleBeatSyncedReelParams): Promise<Blob> {
  const totalDuration = Math.max(0.5, windowEnd - windowStart);
  const segNames = await renderCutSegments(
    ffmpeg,
    segments,
    clips,
    clipFileMap,
    aspectMode,
    (done, total) => onProgress?.((done / total) * 0.65),
    videoFilter,
    videoCrop
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

const PREVIEW_MOUNT_DIR = "/input_preview";
let previewTaskQueue: Promise<unknown> = Promise.resolve();
let previewGeneration = 0;

export function cancelPendingPreviewTasks(): void {
  previewGeneration += 1;
}

export async function waitForIdlePreviewQueue(): Promise<void> {
  cancelPendingPreviewTasks();
  await previewTaskQueue.catch(() => {});
}

function enqueuePreviewTask<T>(task: () => Promise<T>): Promise<T> {
  const gen = previewGeneration;
  const run = previewTaskQueue.then(async () => {
    if (gen !== previewGeneration) {
      throw new Error("Preview task cancelled.");
    }
    return task();
  });
  previewTaskQueue = run.catch(() => {});
  return run;
}

function parseVideoMetaFromLogs(logs: string[]): {
  width?: number;
  height?: number;
  duration?: number;
} {
  let width: number | undefined;
  let height: number | undefined;
  let duration: number | undefined;

  for (const line of logs) {
    if (duration === undefined) {
      const durMatch = line.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (durMatch) {
        const hrs = Number(durMatch[1]);
        const mins = Number(durMatch[2]);
        const secs = Number(durMatch[3]);
        const total = hrs * 3600 + mins * 60 + secs;
        if (Number.isFinite(total) && total > 0) {
          duration = total;
        }
      }
    }
    if (width === undefined && /Video:/.test(line)) {
      const dimMatch = line.match(/,\s*(\d{2,5})x(\d{2,5})(?:[\s,\[]|$)/);
      if (dimMatch) {
        const w = Number(dimMatch[1]);
        const h = Number(dimMatch[2]);
        if (w > 0 && h > 0) {
          width = w;
          height = h;
        }
      }
    }
  }

  return { width, height, duration };
}

function sanitizeInputFilename(name: string, fallbackExt: string): string {
  const base = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return base || `input.${fallbackExt}`;
}

export async function extractVideoThumbnailAndMetaWithFFmpeg(
  file: File
): Promise<{
  thumbnailUrl: string;
  width?: number;
  height?: number;
  duration?: number;
}> {
  return enqueuePreviewTask(async () => {
    const ffmpeg = await getFFmpeg();
    const fsName = sanitizeInputFilename(file.name, "mov");
    const outThumb = `preview_thumb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.jpg`;
    const logs: string[] = [];
    const logHandler = ({ message }: FFmpegLogEvent) => {
      logs.push(message);
    };

    ffmpeg.on("log", logHandler);
    try {
      const mounted = await mountInputBlobs(ffmpeg, PREVIEW_MOUNT_DIR, [
        { fsName, file },
      ]);
      const inputPath = mounted.paths.get(fsName) ?? fsName;

      let exitCode = await ffmpeg.exec([
        "-ss",
        "0.5",
        "-i",
        inputPath,
        "-frames:v",
        "1",
        "-vf",
        "scale='min(360,iw)':-2",
        "-q:v",
        "4",
        "-y",
        outThumb,
      ]);

      let data: Uint8Array | string | null = null;
      if (exitCode === 0) {
        data = await ffmpeg.readFile(outThumb).catch(() => null);
      }

      if (!data || (data instanceof Uint8Array && data.byteLength === 0)) {
        exitCode = await ffmpeg.exec([
          "-ss",
          "0",
          "-i",
          inputPath,
          "-frames:v",
          "1",
          "-vf",
          "scale='min(360,iw)':-2",
          "-q:v",
          "4",
          "-y",
          outThumb,
        ]);
        if (exitCode !== 0) {
          throw new Error(`FFmpeg thumbnail extraction failed (exit ${exitCode})`);
        }
        data = await ffmpeg.readFile(outThumb);
      }

      const uint8 =
        data instanceof Uint8Array ? data : new TextEncoder().encode(data);
      const copy = new Uint8Array(uint8.byteLength);
      copy.set(uint8);

      const blob = new Blob([copy.buffer], { type: "image/jpeg" });
      const thumbnailUrl = URL.createObjectURL(blob);
      const meta = parseVideoMetaFromLogs(logs);

      return { thumbnailUrl, ...meta };
    } finally {
      ffmpeg.off("log", logHandler);
      await unmountInputDir(ffmpeg, PREVIEW_MOUNT_DIR, [fsName]);
      if (ffmpeg.loaded) {
        await ffmpeg.deleteFile(outThumb).catch(() => {});
      }
    }
  });
}

export async function generatePreviewProxyWithFFmpeg(
  file: File
): Promise<string> {
  return enqueuePreviewTask(async () => {
    const ffmpeg = await getFFmpeg();
    const fsName = sanitizeInputFilename(file.name, "mov");
    const outProxy = `preview_proxy_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.mp4`;

    try {
      const mounted = await mountInputBlobs(ffmpeg, PREVIEW_MOUNT_DIR, [
        { fsName, file },
      ]);
      const inputPath = mounted.paths.get(fsName) ?? fsName;

      const exitCode = await ffmpeg.exec([
        "-i",
        inputPath,
        "-vf",
        "scale='min(480,iw)':-2",
        "-r",
        "24",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "28",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-y",
        outProxy,
      ]);

      if (exitCode !== 0) {
        throw new Error(`FFmpeg preview proxy failed (exit ${exitCode})`);
      }

      const data = await ffmpeg.readFile(outProxy);
      const uint8 =
        data instanceof Uint8Array ? data : new TextEncoder().encode(data);
      const copy = new Uint8Array(uint8.byteLength);
      copy.set(uint8);

      const blob = new Blob([copy.buffer], { type: "video/mp4" });
      return URL.createObjectURL(blob);
    } finally {
      await unmountInputDir(ffmpeg, PREVIEW_MOUNT_DIR, [fsName]);
      if (ffmpeg.loaded) {
        await ffmpeg.deleteFile(outProxy).catch(() => {});
      }
    }
  });
}

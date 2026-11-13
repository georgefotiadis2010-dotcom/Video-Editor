"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import {
  Archive,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Download,
  FileAudio,
  FileVideo,
  Film,
  Loader2,
  Music,
  Play,
  Shuffle,
  Sliders,
  Square,
  Trash2,
  Upload,
  X,
  Zap,
} from "lucide-react";
import { HookPreviewStage } from "@/components/HookPreviewStage";
import { WaveformBeatEditor } from "@/components/WaveformBeatEditor";
import { analyzeAudioFile, selectCutsInWindow } from "@/lib/beat-detector";
import { buildBeatCutPlan } from "@/lib/beat-planner";
import {
  buildBeatSyncedBaseVideo,
  cleanupBeatSyncAssets,
  getFFmpeg,
  prepareBeatSyncAssets,
  renderHookOnSyncedBase,
  renderSingleBeatSyncedReel,
  resetFFmpeg,
} from "@/lib/ffmpeg-client";
import {
  DEFAULT_TEXT_STYLE,
  renderHookOverlayPng,
  SAMPLE_HOOKS_20,
  slugifyHook,
  TEXT_PRESETS,
} from "@/lib/text-overlay";
import type {
  AspectMode,
  AudioAnalysis,
  BeatDensity,
  ClipArrangementMode,
  FontFamilyOption,
  PillStyleOption,
  RenderedClip,
  RenderPhase,
  SourceClipItem,
  TextStyleConfig,
} from "@/types/renderer";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function triggerDownload(url: string, filename: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

function probeVideoFile(file: File): Promise<SourceClipItem> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.src = objectUrl;

    probe.onloadedmetadata = () => {
      resolve({
        id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        url: objectUrl,
        width: probe.videoWidth || 1080,
        height: probe.videoHeight || 1920,
        duration: probe.duration || 1,
        sizeBytes: file.size,
      });
    };

    probe.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error(`Could not read video metadata for ${file.name}`));
    };
  });
}

function SectionLabel({
  index,
  title,
  meta,
  done,
}: {
  index: string;
  title: string;
  meta?: string;
  done: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-xs font-bold text-[#FF4D2E]">
        {index}
      </span>
      <h2 className="text-sm font-bold tracking-tight text-[#F5F5F2]">
        {title}
      </h2>
      {meta && (
        <span className="font-mono text-xs text-[#8B8F9C]">{meta}</span>
      )}
      {done && <span className="nb-led-ready ml-1" aria-label="Ready" />}
    </div>
  );
}

export function BeatSyncEditor() {
  const audioInputRef = useRef<HTMLInputElement | null>(null);
  const videosInputRef = useRef<HTMLInputElement | null>(null);
  const cancelRequestedRef = useRef(false);
  const renderedRef = useRef<RenderedClip[]>([]);
  const clipsRef = useRef<SourceClipItem[]>([]);

  // Song & Beat State
  const [audioAnalysis, setAudioAnalysis] = useState<AudioAnalysis | null>(
    null
  );
  const [isAnalyzingAudio, setIsAnalyzingAudio] = useState(false);
  const [isDraggingAudio, setIsDraggingAudio] = useState(false);
  const [windowStart, setWindowStart] = useState(0);
  const [windowEnd, setWindowEnd] = useState(12);
  const [beatDensity, setBeatDensity] = useState<BeatDensity>("balanced");
  const [customCuts, setCustomCuts] = useState<number[] | null>(null);

  // Raw Clips State
  const [clips, setClips] = useState<SourceClipItem[]>([]);
  const [isDraggingVideos, setIsDraggingVideos] = useState(false);
  const [draggedClipId, setDraggedClipId] = useState<string | null>(null);
  const [dragOverClipId, setDragOverClipId] = useState<string | null>(null);

  // Hooks & Styling State
  const [hooksText, setHooksText] = useState<string>(
    SAMPLE_HOOKS_20.slice(0, 5).join("\n")
  );
  const [activeHookIndex, setActiveHookIndex] = useState(0);
  const [styleConfig, setStyleConfig] =
    useState<TextStyleConfig>(DEFAULT_TEXT_STYLE);
  const [aspectMode, setAspectMode] = useState<AspectMode>("force-9x16");
  const [arrangementMode, setArrangementMode] =
    useState<ClipArrangementMode>("shuffle-per-hook");
  const [autoDownloadEach, setAutoDownloadEach] = useState(false);
  const [showFineTune, setShowFineTune] = useState(false);

  // Render State
  const [phase, setPhase] = useState<RenderPhase>("idle");
  const [statusMessage, setStatusMessage] = useState(
    "Add your song, raw clips, and hooks — we'll cut to the beat drops."
  );
  const [currentClipIndex, setCurrentClipIndex] = useState(0);
  const [currentClipProgress, setCurrentClipProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const [renderedClips, setRenderedClips] = useState<RenderedClip[]>([]);
  const [previewClip, setPreviewClip] = useState<RenderedClip | null>(null);
  const [isZipping, setIsZipping] = useState(false);

  const hooks = useMemo(
    () =>
      hooksText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    [hooksText]
  );

  // Sync refs for unmount cleanup
  useEffect(() => {
    renderedRef.current = renderedClips;
  }, [renderedClips]);

  useEffect(() => {
    clipsRef.current = clips;
  }, [clips]);

  useEffect(() => {
    return () => {
      for (const clip of renderedRef.current) {
        URL.revokeObjectURL(clip.url);
      }
      for (const src of clipsRef.current) {
        URL.revokeObjectURL(src.url);
      }
    };
  }, []);

  useEffect(() => {
    if (audioAnalysis) {
      return () => {
        URL.revokeObjectURL(audioAnalysis.url);
      };
    }
  }, [audioAnalysis]);

  useEffect(() => {
    if (phase !== "loading-ffmpeg" && phase !== "rendering") return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 500);
    return () => window.clearInterval(timer);
  }, [phase]);

  const autoCuts = useMemo(() => {
    if (!audioAnalysis) return [];
    return selectCutsInWindow(
      audioAnalysis.beats,
      audioAnalysis.drops,
      windowStart,
      windowEnd,
      beatDensity
    );
  }, [audioAnalysis, windowStart, windowEnd, beatDensity]);

  const activeCuts = useMemo(() => {
    const source = customCuts ?? autoCuts;
    return source
      .filter((t) => t > windowStart + 0.22 && t < windowEnd - 0.22)
      .sort((a, b) => a - b);
  }, [customCuts, autoCuts, windowStart, windowEnd]);

  const previewPlan = useMemo(() => {
    if (!audioAnalysis || clips.length === 0) return [];
    return buildBeatCutPlan(activeCuts, windowStart, windowEnd, clips);
  }, [audioAnalysis, activeCuts, windowStart, windowEnd, clips]);

  const clearRenderedClips = useCallback(() => {
    setRenderedClips((prev) => {
      for (const clip of prev) {
        URL.revokeObjectURL(clip.url);
      }
      return [];
    });
    setPreviewClip(null);
  }, []);

  const handleAudioFile = useCallback(async (file: File) => {
    if (
      !file.type.startsWith("audio/") &&
      !/\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name)
    ) {
      setErrorMessage(
        "Please select a valid audio file (.mp3, .wav, .m4a, .aac, .ogg)."
      );
      return;
    }

    setErrorMessage(null);
    setIsAnalyzingAudio(true);
    setStatusMessage(`Scanning beat drops in "${file.name}"...`);

    try {
      const analysis = await analyzeAudioFile(file);
      setAudioAnalysis(analysis);
      setWindowStart(analysis.recommendedStart);
      setWindowEnd(analysis.recommendedEnd);
      setCustomCuts(null);
      setStatusMessage(
        `Locked onto ${analysis.bpm} BPM & ${analysis.drops.length} drop${analysis.drops.length === 1 ? "" : "s"}.`
      );
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to decode audio file.";
      setErrorMessage(msg);
    } finally {
      setIsAnalyzingAudio(false);
    }
  }, []);

  const handleVideoFiles = useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList).filter(
      (f) =>
        f.type.startsWith("video/") || /\.(mp4|mov|webm|m4v)$/i.test(f.name)
    );
    if (files.length === 0) {
      setErrorMessage(
        "Please select valid video files (.mp4, .mov, .webm, .m4v)."
      );
      return;
    }

    setErrorMessage(null);
    const loaded: SourceClipItem[] = [];
    for (const file of files) {
      try {
        const item = await probeVideoFile(file);
        loaded.push(item);
      } catch {
        // Skip unreadable clip and continue
      }
    }

    if (loaded.length === 0) {
      setErrorMessage("Could not read metadata from the selected video files.");
      return;
    }

    setClips((prev) => [...prev, ...loaded]);
  }, []);

  const handleRemoveClip = (id: string) => {
    setClips((prev) => {
      const target = prev.find((c) => c.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((c) => c.id !== id);
    });
  };

  const handleClearClips = () => {
    setClips((prev) => {
      for (const c of prev) URL.revokeObjectURL(c.url);
      return [];
    });
  };

  const handleToggleCustomCut = (time: number) => {
    const base = customCuts ?? autoCuts;
    const existingIdx = base.findIndex((t) => Math.abs(t - time) < 0.2);
    const next =
      existingIdx >= 0
        ? base.filter((_, idx) => idx !== existingIdx)
        : [...base, time].sort((a, b) => a - b);
    setCustomCuts(next);
  };

  const handleStartBatch = async () => {
    if (!audioAnalysis || clips.length === 0 || hooks.length === 0) return;

    cancelRequestedRef.current = false;
    clearRenderedClips();
    setErrorMessage(null);
    setElapsedSeconds(0);
    setCurrentClipIndex(0);
    setCurrentClipProgress(0);
    setPhase("loading-ffmpeg");
    setStatusMessage("Initializing local FFmpeg.wasm engine...");

    const firstClip = clips[0];
    const targetWidth =
      aspectMode === "force-9x16"
        ? 1080
        : Math.max(2, Math.floor(firstClip.width / 2) * 2);
    const targetHeight =
      aspectMode === "force-9x16"
        ? 1920
        : Math.max(2, Math.floor(firstClip.height / 2) * 2);

    try {
      const ffmpeg = await getFFmpeg();
      if (cancelRequestedRef.current) {
        setPhase("cancelled");
        setStatusMessage("Beat-sync render cancelled.");
        return;
      }

      setPhase("rendering");
      setStatusMessage(
        `Loading ${clips.length} clip${clips.length === 1 ? "" : "s"} & song locally...`
      );

      const { clipFileMap, audioFileName } = await prepareBeatSyncAssets(
        ffmpeg,
        clips,
        audioAnalysis.file
      );

      try {
        if (arrangementMode === "shared-edit") {
          const basePlan = buildBeatCutPlan(
            activeCuts,
            windowStart,
            windowEnd,
            clips
          );
          if (basePlan.length === 0) {
            throw new Error("No valid beat segments in the selected window.");
          }

          setStatusMessage(
            `Chopping ${basePlan.length} beat cuts & syncing song...`
          );
          await buildBeatSyncedBaseVideo({
            ffmpeg,
            segments: basePlan,
            clips,
            clipFileMap,
            audioFileName,
            windowStart,
            windowEnd,
            aspectMode,
            onProgress: (ratio) => setCurrentClipProgress(ratio),
          });
        }

        for (let i = 0; i < hooks.length; i++) {
          if (cancelRequestedRef.current) {
            setPhase("cancelled");
            setStatusMessage(
              `Cancelled after rendering ${i} of ${hooks.length} Reels.`
            );
            break;
          }

          const hookText = hooks[i];
          const filename = slugifyHook(hookText, i);
          setCurrentClipIndex(i);
          setCurrentClipProgress(0);
          setStatusMessage(
            `Rendering Reel ${i + 1}/${hooks.length}: "${hookText.slice(0, 40)}${hookText.length > 40 ? "…" : ""}"`
          );

          const clipStart = performance.now();
          const overlayPngBytes = await renderHookOverlayPng(
            targetWidth,
            targetHeight,
            hookText,
            styleConfig
          );

          let blob: Blob;
          if (arrangementMode === "shared-edit") {
            blob = await renderHookOnSyncedBase(
              ffmpeg,
              overlayPngBytes,
              filename,
              (ratio) => setCurrentClipProgress(ratio)
            );
          } else {
            const seed = Date.now() + i * 7919;
            const plan = buildBeatCutPlan(
              activeCuts,
              windowStart,
              windowEnd,
              clips,
              seed
            );
            blob = await renderSingleBeatSyncedReel({
              ffmpeg,
              segments: plan,
              clips,
              clipFileMap,
              audioFileName,
              windowStart,
              windowEnd,
              overlayPngBytes,
              outputFilename: filename,
              aspectMode,
              onProgress: (ratio) => setCurrentClipProgress(ratio),
            });
          }

          if (cancelRequestedRef.current) {
            setPhase("cancelled");
            setStatusMessage("Beat-sync render cancelled.");
            break;
          }

          const url = URL.createObjectURL(blob);
          const rendered: RenderedClip = {
            id: `bs-${i}-${Date.now()}`,
            index: i,
            hookText,
            filename,
            blob,
            url,
            sizeBytes: blob.size,
            renderMs: Math.round(performance.now() - clipStart),
          };

          setRenderedClips((prev) => [...prev, rendered]);
          if (autoDownloadEach) {
            triggerDownload(url, filename);
          }
        }

        if (!cancelRequestedRef.current) {
          setPhase("completed");
          setCurrentClipProgress(1);
          setStatusMessage(
            `Done! ${hooks.length} beat-synced Reel${hooks.length === 1 ? "" : "s"} ready to post.`
          );
        }
      } finally {
        await cleanupBeatSyncAssets(ffmpeg, clipFileMap, audioFileName);
      }
    } catch (err) {
      if (cancelRequestedRef.current) {
        setPhase("cancelled");
        setStatusMessage("Beat-sync render cancelled.");
        return;
      }
      const message =
        err instanceof Error ? err.message : "Unknown FFmpeg rendering error.";
      setPhase("error");
      setErrorMessage(message);
      setStatusMessage("Render failed. Check the error message below.");
    }
  };

  const handleCancelBatch = () => {
    cancelRequestedRef.current = true;
    resetFFmpeg();
    setPhase("cancelled");
    setStatusMessage("Render cancelled and FFmpeg worker reset.");
  };

  const handleDownloadZip = async () => {
    if (renderedClips.length === 0 || isZipping) return;
    setIsZipping(true);
    try {
      const zip = new JSZip();
      for (const clip of renderedClips) {
        zip.file(clip.filename, clip.blob);
      }
      const zipBlob = await zip.generateAsync({ type: "blob" });
      const zipUrl = URL.createObjectURL(zipBlob);
      triggerDownload(
        zipUrl,
        `lxg-beatsync-${renderedClips.length}-reels.zip`
      );
      window.setTimeout(() => URL.revokeObjectURL(zipUrl), 10000);
    } finally {
      setIsZipping(false);
    }
  };

  const isBusy = phase === "loading-ffmpeg" || phase === "rendering";
  const missingStep = !audioAnalysis
    ? "Upload a song to detect beat drops"
    : clips.length === 0
      ? "Add at least 1 raw phone video"
      : hooks.length === 0
        ? "Add at least 1 text hook"
        : null;

  const canRender = missingStep === null && !isBusy;
  const overallRatio =
    hooks.length > 0
      ? (currentClipIndex + currentClipProgress) / hooks.length
      : 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
        {/* LEFT COLUMN: 3 Clean Steps */}
        <div className="flex flex-col gap-4 lg:col-span-7">
          {/* STEP 1: Song & Beat Drops */}
          <section
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("Files")) {
                e.preventDefault();
                setIsDraggingAudio(true);
              }
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setIsDraggingAudio(false);
              }
            }}
            onDrop={(e) => {
              if (e.dataTransfer.files?.length) {
                e.preventDefault();
                setIsDraggingAudio(false);
                const f = e.dataTransfer.files[0];
                if (f) handleAudioFile(f);
              }
            }}
            className={`nb-module p-5 transition ${
              isDraggingAudio ? "!border-[#FF4D2E] ring-1 ring-[#FF4D2E]/50" : ""
            }`}
          >
            <div className="mb-3.5 flex items-center justify-between gap-2">
              <SectionLabel
                index="01"
                title="Song"
                done={Boolean(audioAnalysis)}
              />
              {audioAnalysis && (
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => audioInputRef.current?.click()}
                  className="nb-key rounded-xl px-3 py-1 font-mono text-[11px] font-semibold"
                >
                  Replace
                </button>
              )}
            </div>

            <input
              ref={audioInputRef}
              type="file"
              accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleAudioFile(f);
                e.target.value = "";
              }}
            />

            {isAnalyzingAudio ? (
              <div className="nb-well flex items-center justify-center gap-2.5 rounded-2xl py-8">
                <Loader2 className="h-4 w-4 animate-spin text-[#FF4D2E]" />
                <span className="font-mono text-xs text-[#9A9DA8]">
                  Analyzing BPM & drops...
                </span>
              </div>
            ) : !audioAnalysis ? (
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDraggingAudio(true);
                }}
                onDragLeave={() => setIsDraggingAudio(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDraggingAudio(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f) handleAudioFile(f);
                }}
                onClick={() => audioInputRef.current?.click()}
                className={`nb-well flex cursor-pointer items-center justify-between border border-dashed px-4 py-4 transition ${
                  isDraggingAudio
                    ? "!border-[#FF4D2E] bg-[#FF4D2E]/10"
                    : "border-white/15 hover:border-[#FF4D2E]/60"
                }`}
              >
                <div className="flex items-center gap-3">
                  <Music className="h-4 w-4 text-[#FF4D2E]" />
                  <span className="text-sm font-medium text-[#F5F5F2]">
                    Drop MP3 / WAV / M4A
                  </span>
                </div>
                <span className="font-mono text-[11px] uppercase tracking-wider text-[#8B8F9C]">
                  Browse
                </span>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="nb-well flex items-center justify-between rounded-xl px-3.5 py-2.5 text-xs">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <FileAudio className="h-4 w-4 shrink-0 text-[#FF4D2E]" />
                    <span className="truncate font-semibold text-[#F5F5F2]">
                      {audioAnalysis.file.name}
                    </span>
                  </div>
                  <span className="shrink-0 font-mono text-[#9A9DA8]">
                    {formatDuration(audioAnalysis.duration)} ·{" "}
                    {formatBytes(audioAnalysis.file.size)}
                  </span>
                </div>

                <WaveformBeatEditor
                  analysis={audioAnalysis}
                  windowStart={windowStart}
                  windowEnd={windowEnd}
                  onChangeWindow={(s, e) => {
                    setWindowStart(s);
                    setWindowEnd(e);
                  }}
                  activeCuts={activeCuts}
                  onToggleCustomCut={handleToggleCustomCut}
                  beatDensity={beatDensity}
                  onChangeDensity={(d) => {
                    setBeatDensity(d);
                    setCustomCuts(null);
                  }}
                  onResetAutoBeats={() => setCustomCuts(null)}
                  hasCustomBeats={customCuts !== null}
                />
              </div>
            )}
          </section>

          {/* STEP 2: Raw Phone Videos */}
          <section className="nb-module p-5">
            <div className="mb-3.5 flex items-center justify-between gap-2">
              <SectionLabel
                index="02"
                title="Raw Clips"
                meta={clips.length > 0 ? `(${clips.length})` : undefined}
                done={clips.length > 0}
              />
              {clips.length > 0 && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => videosInputRef.current?.click()}
                    className="nb-key rounded-xl px-3 py-1 font-mono text-[11px] font-semibold"
                  >
                    + Add
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={handleClearClips}
                    className="nb-key rounded-xl px-3 py-1 font-mono text-[11px] font-semibold text-[#9A9DA8]"
                  >
                    Clear
                  </button>
                </div>
              )}
            </div>

            <input
              ref={videosInputRef}
              type="file"
              multiple
              accept="video/*,.mp4,.mov,.webm,.m4v"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) handleVideoFiles(e.target.files);
                e.target.value = "";
              }}
            />

            <div
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes("Files")) {
                  e.preventDefault();
                  setIsDraggingVideos(true);
                }
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setIsDraggingVideos(false);
                }
              }}
              onDrop={(e) => {
                if (e.dataTransfer.files?.length) {
                  e.preventDefault();
                  setIsDraggingVideos(false);
                  handleVideoFiles(e.dataTransfer.files);
                }
              }}
              onClick={() => {
                if (clips.length === 0) videosInputRef.current?.click();
              }}
              className={`nb-well rounded-2xl border-2 border-dashed transition ${
                clips.length === 0 ? "cursor-pointer px-4 py-5" : "p-3"
              } ${
                isDraggingVideos
                  ? "!border-[#FF4D2E] bg-[#FF4D2E]/10"
                  : "border-white/15 hover:border-[#FF4D2E]/60"
              }`}
            >
              {clips.length === 0 ? (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Upload className="h-4 w-4 text-[#FF4D2E]" />
                    <span className="text-sm font-medium text-[#F5F5F2]">
                      Drop raw videos (MP4 / MOV)
                    </span>
                  </div>
                  <span className="font-mono text-[11px] uppercase tracking-wider text-[#8B8F9C]">
                    Browse
                  </span>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                  {clips.map((clip, idx) => (
                    <div
                      key={clip.id}
                      draggable={!isBusy}
                      onDragStart={(e) => {
                        setDraggedClipId(clip.id);
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", clip.id);
                      }}
                      onDragOver={(e) => {
                        if (!draggedClipId || draggedClipId === clip.id) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        if (dragOverClipId !== clip.id) {
                          setDragOverClipId(clip.id);
                        }
                      }}
                      onDragLeave={() => {
                        if (dragOverClipId === clip.id) {
                          setDragOverClipId(null);
                        }
                      }}
                      onDrop={(e) => {
                        if (!draggedClipId || draggedClipId === clip.id) return;
                        e.preventDefault();
                        e.stopPropagation();
                        setClips((prev) => {
                          const fromIdx = prev.findIndex(
                            (c) => c.id === draggedClipId
                          );
                          const toIdx = prev.findIndex((c) => c.id === clip.id);
                          if (fromIdx === -1 || toIdx === -1) return prev;
                          const next = [...prev];
                          const [moved] = next.splice(fromIdx, 1);
                          next.splice(toIdx, 0, moved);
                          return next;
                        });
                        setDraggedClipId(null);
                        setDragOverClipId(null);
                      }}
                      onDragEnd={() => {
                        setDraggedClipId(null);
                        setDragOverClipId(null);
                      }}
                      className={`group relative cursor-grab overflow-hidden rounded-2xl border bg-[#17181D] shadow-md transition active:cursor-grabbing ${
                        dragOverClipId === clip.id
                          ? "scale-[1.02] border-[#FF4D2E] ring-2 ring-[#FF4D2E]/50"
                          : draggedClipId === clip.id
                            ? "border-white/20 opacity-50"
                            : "border-white/10"
                      }`}
                    >
                      <div className="relative aspect-[9/12] w-full bg-black">
                        <video
                          src={clip.url}
                          muted
                          loop
                          playsInline
                          preload="metadata"
                          onMouseEnter={(e) => e.currentTarget.play().catch(() => {})}
                          onMouseLeave={(e) => {
                            e.currentTarget.pause();
                            e.currentTarget.currentTime = 0;
                          }}
                          className="h-full w-full object-cover"
                        />
                        <span className="absolute left-2 top-2 rounded-lg border border-white/15 bg-black/80 px-2 py-0.5 font-mono text-[10px] font-bold text-[#F5F5F2] backdrop-blur-sm">
                          #{idx + 1}
                        </span>
                        <span className="absolute bottom-2 right-2 rounded-lg border border-white/15 bg-black/80 px-2 py-0.5 font-mono text-[10px] text-[#C4C7D0] backdrop-blur-sm">
                          {clip.duration.toFixed(1)}s
                        </span>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => handleRemoveClip(clip.id)}
                          className="nb-key absolute right-2 top-2 rounded-full p-1.5 opacity-0 transition group-hover:opacity-100 disabled:opacity-0"
                          title="Remove clip"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                      <div className="truncate px-2.5 py-1.5 font-mono text-[10px] font-medium text-[#C4C7D0]">
                        {clip.file.name}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {previewPlan.length > 0 && (
              <div className="nb-well mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl px-3.5 py-2 text-[11px] text-[#C4C7D0]">
                <span className="flex items-center gap-1.5">
                  <Film className="h-3.5 w-3.5 text-[#FF4D2E]" />
                  <strong className="text-[#F5F5F2]">
                    {previewPlan.length} beat cuts
                  </strong>{" "}
                  planned across {clips.length} clip
                  {clips.length === 1 ? "" : "s"}
                </span>
                <span className="font-mono text-[#9A9DA8]">
                  Avg{" "}
                  {(
                    previewPlan.reduce((s, c) => s + c.duration, 0) /
                    previewPlan.length
                  ).toFixed(2)}
                  s/cut · {(windowEnd - windowStart).toFixed(1)}s Reel
                </span>
              </div>
            )}
          </section>

          {/* STEP 3: Text Hooks & Quick Style */}
          <section className="nb-module p-5">
            <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2">
              <SectionLabel
                index="03"
                title="Hooks & Edit"
                meta={`(${hooks.length} ${hooks.length === 1 ? "Reel" : "Reels"})`}
                done={hooks.length > 0}
              />

              <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => {
                    const seen = new Set<string>();
                    const unique: string[] = [];
                    for (const h of hooks) {
                      const k = h.toLowerCase();
                      if (!seen.has(k)) {
                        seen.add(k);
                        unique.push(h);
                      }
                    }
                    setHooksText(unique.join("\n"));
                    setActiveHookIndex(0);
                  }}
                  className="nb-key rounded-xl px-2.5 py-1 font-semibold"
                >
                  Dedupe
                </button>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => {
                    setHooksText(SAMPLE_HOOKS_20.join("\n"));
                    setActiveHookIndex(0);
                  }}
                  className="nb-key rounded-xl px-2.5 py-1 font-semibold text-[#F5F5F2]"
                >
                  20 Samples
                </button>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => {
                    setHooksText("");
                    setActiveHookIndex(0);
                  }}
                  className="nb-key rounded-xl px-2.5 py-1 font-semibold text-[#9A9DA8]"
                >
                  Clear
                </button>
              </div>
            </div>

            <textarea
              value={hooksText}
              disabled={isBusy}
              onChange={(e) => {
                setHooksText(e.target.value);
                setActiveHookIndex(0);
              }}
              rows={5}
              placeholder="One hook per line..."
              className="nb-well nb-scroll w-full rounded-2xl px-4 py-3 font-sans text-sm leading-relaxed text-[#F5F5F2] placeholder-[#5A5E6B] focus:border-[#FF4D2E] focus:outline-none disabled:opacity-60"
            />

            {/* Arrangement Toggle */}
            <div className="mt-3.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <button
                type="button"
                disabled={isBusy}
                onClick={() => setArrangementMode("shuffle-per-hook")}
                className={`nb-key flex items-center gap-3 rounded-2xl px-3.5 py-2.5 text-left ${
                  arrangementMode === "shuffle-per-hook" ? "nb-key-active" : ""
                }`}
              >
                <Shuffle className="h-4 w-4 shrink-0" />
                <div>
                  <p className="text-xs font-bold">Shuffle per Hook</p>
                  <p className="font-mono text-[10px] opacity-80">
                    Unique cut order each Reel
                  </p>
                </div>
              </button>

              <button
                type="button"
                disabled={isBusy}
                onClick={() => setArrangementMode("shared-edit")}
                className={`nb-key flex items-center gap-3 rounded-2xl px-3.5 py-2.5 text-left ${
                  arrangementMode === "shared-edit" ? "nb-key-active" : ""
                }`}
              >
                <Zap className="h-4 w-4 shrink-0" />
                <div>
                  <p className="text-xs font-bold">Same Cut for All</p>
                  <p className="font-mono text-[10px] opacity-80">
                    Cut once, stamp all hooks
                  </p>
                </div>
              </button>
            </div>

            {/* 1-Click Presets + Expandable Fine-Tune */}
            <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-3.5">
              <div className="flex flex-wrap gap-1.5">
                {TEXT_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    disabled={isBusy}
                    onClick={() =>
                      setStyleConfig((prev) => ({ ...prev, ...preset.config }))
                    }
                    className="nb-key rounded-xl px-3 py-1 font-mono text-[11px] font-semibold"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => setShowFineTune((prev) => !prev)}
                className={`nb-key inline-flex items-center gap-1.5 rounded-xl px-3 py-1 font-mono text-[11px] font-semibold ${
                  showFineTune ? "nb-key-active" : ""
                }`}
              >
                <Sliders className="h-3 w-3" />
                <span>Style</span>
                {showFineTune ? (
                  <ChevronUp className="h-3 w-3" />
                ) : (
                  <ChevronDown className="h-3 w-3" />
                )}
              </button>
            </div>

            {showFineTune && (
              <div className="nb-well mt-3.5 rounded-2xl p-4">
                <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                  <div>
                    <label className="mb-1.5 block font-mono text-[10px] font-semibold uppercase tracking-wider text-[#9A9DA8]">
                      Font
                    </label>
                    <select
                      value={styleConfig.fontFamily}
                      disabled={isBusy}
                      onChange={(e) =>
                        setStyleConfig((p) => ({
                          ...p,
                          fontFamily: e.target.value as FontFamilyOption,
                        }))
                      }
                      className="w-full rounded-xl border border-white/10 bg-[#17181D] px-3 py-2 text-xs font-medium text-[#F5F5F2] focus:border-[#FF4D2E] focus:outline-none"
                    >
                      <option value="inter">Inter (Clean Viral)</option>
                      <option value="marker">Permanent Marker (LXG)</option>
                      <option value="impact">Impact (Meme Bold)</option>
                    </select>
                  </div>

                  <div>
                    <label className="mb-1.5 block font-mono text-[10px] font-semibold uppercase tracking-wider text-[#9A9DA8]">
                      Pill Style
                    </label>
                    <select
                      value={styleConfig.pillStyle}
                      disabled={isBusy}
                      onChange={(e) =>
                        setStyleConfig((p) => ({
                          ...p,
                          pillStyle: e.target.value as PillStyleOption,
                        }))
                      }
                      className="w-full rounded-xl border border-white/10 bg-[#17181D] px-3 py-2 text-xs font-medium text-[#F5F5F2] focus:border-[#FF4D2E] focus:outline-none"
                    >
                      <option value="black">Black Pill</option>
                      <option value="crimson">LXG Crimson</option>
                      <option value="white">White Pill</option>
                      <option value="outline">Outline Only</option>
                    </select>
                  </div>

                  <div>
                    <div className="mb-1 flex justify-between text-xs">
                      <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-[#9A9DA8]">
                        Font Size
                      </span>
                      <span className="font-mono font-bold text-[#F5F5F2]">
                        {styleConfig.fontSize}px
                      </span>
                    </div>
                    <input
                      type="range"
                      min={36}
                      max={84}
                      value={styleConfig.fontSize}
                      disabled={isBusy}
                      onChange={(e) =>
                        setStyleConfig((p) => ({
                          ...p,
                          fontSize: Number(e.target.value),
                        }))
                      }
                      style={
                        {
                          "--attr-min": 36,
                          "--attr-max": 84,
                          "--control-value": styleConfig.fontSize,
                        } as React.CSSProperties
                      }
                      className="nb-slider"
                    />
                  </div>

                  <div>
                    <div className="mb-1 flex justify-between text-xs">
                      <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-[#9A9DA8]">
                        Vertical Position
                      </span>
                      <span className="font-mono font-bold text-[#F5F5F2]">
                        {styleConfig.yPositionPercent}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={10}
                      max={85}
                      value={styleConfig.yPositionPercent}
                      disabled={isBusy}
                      onChange={(e) =>
                        setStyleConfig((p) => ({
                          ...p,
                          yPositionPercent: Number(e.target.value),
                        }))
                      }
                      style={
                        {
                          "--attr-min": 10,
                          "--attr-max": 85,
                          "--control-value": styleConfig.yPositionPercent,
                        } as React.CSSProperties
                      }
                      className="nb-slider"
                    />
                  </div>
                </div>

                <div className="mt-3.5 flex flex-wrap items-center gap-4 border-t border-white/10 pt-3.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-[#9A9DA8]">
                      Aspect:
                    </span>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => setAspectMode("force-9x16")}
                      className={`nb-key rounded-xl px-2.5 py-1 text-xs font-semibold ${
                        aspectMode === "force-9x16" ? "nb-key-active" : ""
                      }`}
                    >
                      9:16 Reels
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => setAspectMode("original")}
                      className={`nb-key rounded-xl px-2.5 py-1 text-xs font-semibold ${
                        aspectMode === "original" ? "nb-key-active" : ""
                      }`}
                    >
                      Match First Clip
                    </button>
                  </div>

                  <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-[#C4C7D0]">
                    <input
                      type="checkbox"
                      checked={styleConfig.uppercase}
                      disabled={isBusy}
                      onChange={(e) =>
                        setStyleConfig((p) => ({
                          ...p,
                          uppercase: e.target.checked,
                        }))
                      }
                      className="h-4 w-4 rounded accent-[#FF4D2E]"
                    />
                    <span>UPPERCASE</span>
                  </label>

                  <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-[#C4C7D0]">
                    <input
                      type="checkbox"
                      checked={autoDownloadEach}
                      disabled={isBusy}
                      onChange={(e) => setAutoDownloadEach(e.target.checked)}
                      className="h-4 w-4 rounded accent-[#FF4D2E]"
                    />
                    <span>Auto-download each</span>
                  </label>
                </div>
              </div>
            )}
          </section>
        </div>

        {/* RIGHT COLUMN: Sticky Preview + Primary CTA */}
        <div className="flex flex-col gap-5 lg:sticky lg:top-20 lg:col-span-5">
          <HookPreviewStage
            video={clips[0] ?? null}
            hooks={hooks}
            activeHookIndex={activeHookIndex}
            onChangeHookIndex={setActiveHookIndex}
            styleConfig={styleConfig}
            aspectMode={aspectMode}
            muteAudio={true}
          />

          {/* Render Action Card */}
          <section className="nb-module p-5">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-mono text-[11px] font-semibold uppercase tracking-widest text-[#8B8F9C]">
                Export
              </span>
              {(isBusy || phase === "completed") && (
                <span className="font-mono text-xs text-[#8B8F9C]">
                  {elapsedSeconds}s
                </span>
              )}
            </div>

            <p className="mb-3.5 text-xs text-[#8B8F9C]">
              {missingStep ?? statusMessage}
            </p>

            {isBusy && (
              <div className="nb-well mb-4 flex flex-col gap-2 rounded-2xl p-3">
                <progress
                  className="lxg-progress"
                  value={Math.round(overallRatio * 100)}
                  max={100}
                />
                <div className="flex justify-between font-mono text-[11px] text-[#C4C7D0]">
                  <span>
                    Reel {currentClipIndex + 1} / {hooks.length}
                  </span>
                  <span className="font-bold text-[#FF4D2E]">
                    {Math.round(overallRatio * 100)}%
                  </span>
                </div>
              </div>
            )}

            {errorMessage && (
              <div className="mb-3 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                {errorMessage}
              </div>
            )}

            {!isBusy ? (
              <button
                type="button"
                disabled={!canRender}
                onClick={handleStartBatch}
                className="nb-key-primary inline-flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-3.5 text-xs font-extrabold uppercase tracking-wider"
              >
                <Play className="h-4 w-4 fill-current" />
                <span>
                  Render {hooks.length || 0} Beat-Synced Reel
                  {hooks.length === 1 ? "" : "s"}
                </span>
              </button>
            ) : (
              <button
                type="button"
                onClick={handleCancelBatch}
                className="nb-key inline-flex w-full items-center justify-center gap-2 rounded-2xl !border-red-500/40 !bg-red-500/15 px-4 py-3.5 text-xs font-bold uppercase tracking-wider text-red-200"
              >
                <Square className="h-3.5 w-3.5 fill-current text-[#FF4D2E]" />
                <span>Cancel</span>
              </button>
            )}
          </section>
        </div>
      </div>

      {/* Rendered Reels Vault (Full Width Below) */}
      {renderedClips.length > 0 && (
        <section className="nb-module p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <CheckCircle2 className="h-5 w-5 text-emerald-400" />
              <div>
                <h2 className="text-base font-bold text-[#F5F5F2]">
                  Ready-to-Post Reels ({renderedClips.length})
                </h2>
                <p className="font-mono text-[11px] text-[#9A9DA8]">
                  H.264 + AAC · Synced to beat drops · 100% local
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={clearRenderedClips}
                className="nb-key inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Clear</span>
              </button>
              <button
                type="button"
                disabled={isZipping}
                onClick={handleDownloadZip}
                className="nb-key-primary inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold uppercase tracking-wider"
              >
                {isZipping ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Archive className="h-3.5 w-3.5" />
                )}
                <span>Download All (.zip)</span>
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {renderedClips.map((clip) => (
              <div
                key={clip.id}
                className="nb-well flex flex-col justify-between gap-3 rounded-2xl p-3.5"
              >
                <div className="flex items-start gap-2.5">
                  <FileVideo className="mt-0.5 h-4 w-4 shrink-0 text-[#FF4D2E]" />
                  <div className="min-w-0">
                    <p className="line-clamp-2 text-xs font-semibold text-[#F5F5F2]">
                      {clip.hookText}
                    </p>
                    <p className="mt-1 font-mono text-[10px] text-[#9A9DA8]">
                      {formatBytes(clip.sizeBytes)} ·{" "}
                      {(clip.renderMs / 1000).toFixed(1)}s
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPreviewClip(clip)}
                    className="nb-key flex flex-1 items-center justify-center gap-1.5 rounded-xl py-1.5 text-xs font-semibold"
                  >
                    <Play className="h-3 w-3" />
                    <span>Preview</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => triggerDownload(clip.url, clip.filename)}
                    className="nb-key-primary flex flex-1 items-center justify-center gap-1.5 rounded-xl py-1.5 text-xs font-bold"
                  >
                    <Download className="h-3 w-3" />
                    <span>MP4</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Preview Modal */}
      {previewClip && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
          onClick={() => setPreviewClip(null)}
        >
          <div
            className="nb-module flex w-full max-w-md flex-col gap-3.5 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-xs font-bold text-[#F5F5F2]">
                {previewClip.filename}
              </span>
              <button
                type="button"
                onClick={() => setPreviewClip(null)}
                className="nb-key rounded-xl p-1.5"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <video
              src={previewClip.url}
              controls
              autoPlay
              loop
              playsInline
              className="max-h-[70vh] w-full rounded-2xl border border-white/10 bg-black object-contain"
            />

            <button
              type="button"
              onClick={() =>
                triggerDownload(previewClip.url, previewClip.filename)
              }
              className="nb-key-primary flex w-full items-center justify-center gap-2 rounded-2xl py-3 text-xs font-extrabold uppercase tracking-wider"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Download {previewClip.filename}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import {
  Archive,
  CheckCircle2,
  Download,
  FileVideo,
  Layers,
  ListChecks,
  Loader2,
  Music,
  Play,
  Sliders,
  Sparkles,
  Square,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { BeatSyncEditor } from "@/components/BeatSyncEditor";
import { Header } from "@/components/Header";
import { HookPreviewStage } from "@/components/HookPreviewStage";
import {
  cleanupSourceFile,
  getFFmpeg,
  renderSingleHookVideo,
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
  EditorMode,
  FontFamilyOption,
  PillStyleOption,
  RenderedClip,
  RenderPhase,
  TextStyleConfig,
  VideoMetadata,
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

export function BatchRendererApp() {
  const [editorMode, setEditorMode] = useState<EditorMode>("beat-sync");
  const beatTabRef = useRef<HTMLButtonElement | null>(null);
  const loopTabRef = useRef<HTMLButtonElement | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cancelRequestedRef = useRef(false);
  const clipsRef = useRef<RenderedClip[]>([]);

  const [video, setVideo] = useState<VideoMetadata | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const [hooksText, setHooksText] = useState<string>(
    SAMPLE_HOOKS_20.slice(0, 5).join("\n")
  );
  const [activeHookIndex, setActiveHookIndex] = useState(0);

  const [styleConfig, setStyleConfig] =
    useState<TextStyleConfig>(DEFAULT_TEXT_STYLE);
  const [aspectMode, setAspectMode] = useState<AspectMode>("force-9x16");
  const [muteAudio, setMuteAudio] = useState(false);
  const [autoDownloadEach, setAutoDownloadEach] = useState(false);

  const [phase, setPhase] = useState<RenderPhase>("idle");
  const [statusMessage, setStatusMessage] = useState(
    "Ready. Upload a background loop and paste your hooks."
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

  // Keep ref in sync for cleanup on unmount
  useEffect(() => {
    clipsRef.current = renderedClips;
  }, [renderedClips]);

  useEffect(() => {
    return () => {
      for (const clip of clipsRef.current) {
        URL.revokeObjectURL(clip.url);
      }
    };
  }, []);

  // Elapsed timer during active rendering
  useEffect(() => {
    if (phase !== "loading-ffmpeg" && phase !== "rendering") return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 500);
    return () => window.clearInterval(timer);
  }, [phase]);

  const clearRenderedClips = useCallback(() => {
    setRenderedClips((prev) => {
      for (const clip of prev) {
        URL.revokeObjectURL(clip.url);
      }
      return [];
    });
    setPreviewClip(null);
  }, []);

  const handleVideoFile = useCallback((file: File) => {
    if (!file.type.startsWith("video/")) {
      setErrorMessage("Please select a valid video file (.mp4, .mov, .webm).");
      return;
    }

    setErrorMessage(null);
    const objectUrl = URL.createObjectURL(file);
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.src = objectUrl;

    probe.onloadedmetadata = () => {
      setVideo((prev) => {
        if (prev?.url) URL.revokeObjectURL(prev.url);
        return {
          file,
          url: objectUrl,
          width: probe.videoWidth || 1080,
          height: probe.videoHeight || 1920,
          duration: probe.duration || 0,
          sizeBytes: file.size,
        };
      });
    };

    probe.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      setErrorMessage(
        "Could not read video metadata. Try an H.264 MP4 or MOV file."
      );
    };
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);
      const droppedFile = e.dataTransfer.files?.[0];
      if (droppedFile) {
        handleVideoFile(droppedFile);
      }
    },
    [handleVideoFile]
  );

  const handleDedupeHooks = () => {
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const h of hooks) {
      const key = h.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(h);
      }
    }
    setHooksText(unique.join("\n"));
    setActiveHookIndex(0);
  };

  const handleLoadSample20 = () => {
    setHooksText(SAMPLE_HOOKS_20.join("\n"));
    setActiveHookIndex(0);
  };

  const handleStartBatch = async () => {
    if (!video || hooks.length === 0) return;

    cancelRequestedRef.current = false;
    clearRenderedClips();
    setErrorMessage(null);
    setElapsedSeconds(0);
    setCurrentClipIndex(0);
    setCurrentClipProgress(0);
    setPhase("loading-ffmpeg");
    setStatusMessage("Initializing local FFmpeg.wasm engine...");

    const targetWidth =
      aspectMode === "force-9x16"
        ? 1080
        : Math.max(2, Math.floor(video.width / 2) * 2);
    const targetHeight =
      aspectMode === "force-9x16"
        ? 1920
        : Math.max(2, Math.floor(video.height / 2) * 2);

    try {
      const ffmpeg = await getFFmpeg();
      if (cancelRequestedRef.current) {
        setPhase("cancelled");
        setStatusMessage("Batch render cancelled.");
        return;
      }

      setPhase("rendering");
      let sourceWritten = false;

      for (let i = 0; i < hooks.length; i++) {
        if (cancelRequestedRef.current) {
          setPhase("cancelled");
          setStatusMessage(
            `Cancelled after rendering ${i} of ${hooks.length} clips.`
          );
          break;
        }

        const hookText = hooks[i];
        const filename = slugifyHook(hookText, i);
        setCurrentClipIndex(i);
        setCurrentClipProgress(0);
        setStatusMessage(
          `Rendering clip ${i + 1} of ${hooks.length}: "${hookText.slice(0, 48)}${hookText.length > 48 ? "…" : ""}"`
        );

        const clipStart = performance.now();
        const overlayPngBytes = await renderHookOverlayPng(
          targetWidth,
          targetHeight,
          hookText,
          styleConfig
        );

        const blob = await renderSingleHookVideo({
          ffmpeg,
          sourceFile: video.file,
          sourceWritten,
          overlayPngBytes,
          outputFilename: filename,
          aspectMode,
          muteAudio,
          onProgress: (ratio) => setCurrentClipProgress(ratio),
        });

        sourceWritten = true;

        if (cancelRequestedRef.current) {
          setPhase("cancelled");
          setStatusMessage("Batch render cancelled.");
          break;
        }

        const url = URL.createObjectURL(blob);
        const clip: RenderedClip = {
          id: `${i}-${Date.now()}`,
          index: i,
          hookText,
          filename,
          blob,
          url,
          sizeBytes: blob.size,
          renderMs: Math.round(performance.now() - clipStart),
        };

        setRenderedClips((prev) => [...prev, clip]);

        if (autoDownloadEach) {
          triggerDownload(url, filename);
        }
      }

      if (!cancelRequestedRef.current) {
        await cleanupSourceFile(ffmpeg);
        setPhase("completed");
        setCurrentClipProgress(1);
        setStatusMessage(
          `Done! Rendered ${hooks.length} unique MP4${hooks.length === 1 ? "" : "s"} locally.`
        );
      }
    } catch (err) {
      if (cancelRequestedRef.current) {
        setPhase("cancelled");
        setStatusMessage("Batch render cancelled.");
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
    setStatusMessage("Batch render cancelled and FFmpeg worker reset.");
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
        `lxg-batch-${renderedClips.length}-hooks.zip`
      );
      window.setTimeout(() => URL.revokeObjectURL(zipUrl), 10000);
    } finally {
      setIsZipping(false);
    }
  };

  const isBusy = phase === "loading-ffmpeg" || phase === "rendering";
  const overallProgress =
    hooks.length > 0
      ? Math.min(
          1,
          (renderedClips.length + (isBusy ? currentClipProgress : 0)) /
            hooks.length
        )
      : 0;

  return (
    <div className="flex min-h-screen flex-col text-[#F5F5F2]">
      <Header />

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-5 sm:px-6">
        {/* Mode Switcher */}
        <div className="mb-5 flex items-center justify-between gap-3">
          <div
            role="tablist"
            aria-label="Editor modes"
            className="nb-well inline-flex items-center gap-1 rounded-full p-1"
          >
            <button
              ref={beatTabRef}
              type="button"
              role="tab"
              id="tab-beat-sync"
              aria-selected={editorMode === "beat-sync"}
              tabIndex={editorMode === "beat-sync" ? 0 : -1}
              onClick={() => setEditorMode("beat-sync")}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                  e.preventDefault();
                  setEditorMode("single-loop");
                  loopTabRef.current?.focus();
                }
              }}
              className={`nb-key inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-bold tracking-wide ${
                editorMode === "beat-sync"
                  ? "nb-key-active"
                  : "!border-transparent !bg-transparent text-[#8B8F9C] hover:text-[#F5F5F2]"
              }`}
            >
              <Music className="h-3.5 w-3.5" />
              <span>Beat-Sync</span>
            </button>

            <button
              ref={loopTabRef}
              type="button"
              role="tab"
              id="tab-single-loop"
              aria-selected={editorMode === "single-loop"}
              tabIndex={editorMode === "single-loop" ? 0 : -1}
              onClick={() => setEditorMode("single-loop")}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                  e.preventDefault();
                  setEditorMode("beat-sync");
                  beatTabRef.current?.focus();
                }
              }}
              className={`nb-key inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-bold tracking-wide ${
                editorMode === "single-loop"
                  ? "nb-key-active"
                  : "!border-transparent !bg-transparent text-[#8B8F9C] hover:text-[#F5F5F2]"
              }`}
            >
              <Layers className="h-3.5 w-3.5" />
              <span>Single-Loop</span>
            </button>
          </div>
        </div>

        {/* Beat-Sync Panel */}
        <div
          role="tabpanel"
          aria-labelledby="tab-beat-sync"
          hidden={editorMode !== "beat-sync"}
        >
          {editorMode === "beat-sync" && <BeatSyncEditor />}
        </div>

        {/* Single-Loop Panel */}
        <div
          role="tabpanel"
          aria-labelledby="tab-single-loop"
          hidden={editorMode !== "single-loop"}
        >
        {/* Main 2-Column Studio Grid */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* LEFT WORKSPACE (7 cols) */}
          <div className="flex flex-col gap-6 lg:col-span-7">
            {/* Step 1: Background Video Loop */}
            <section className="nb-module p-5">
              <div className="mb-3.5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-bold text-[#FF4D2E]">
                    01
                  </span>
                  <h2 className="text-sm font-bold tracking-tight text-[#F5F5F2]">
                    Background Loop
                  </h2>
                  {video && (
                    <span className="nb-led-ready ml-1" aria-label="Ready" />
                  )}
                </div>
                {video && (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => {
                      URL.revokeObjectURL(video.url);
                      setVideo(null);
                    }}
                    className="nb-key inline-flex items-center gap-1 rounded-xl px-2.5 py-1 text-xs font-semibold text-[#9A9DA8] hover:text-[#FF4D2E]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Remove
                  </button>
                )}
              </div>

              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                onClick={() => !isBusy && fileInputRef.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === " ") && !isBusy) {
                    e.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                className={`nb-well group flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed p-6 text-center transition ${
                  isDragging
                    ? "!border-[#FF4D2E] bg-[#FF4D2E]/10"
                    : "border-white/15 hover:border-[#FF4D2E]/60"
                } ${isBusy ? "pointer-events-none opacity-60" : ""}`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/mp4,video/quicktime,video/webm,video/*"
                  className="hidden"
                  onChange={(e) => {
                    const selected = e.target.files?.[0];
                    if (selected) handleVideoFile(selected);
                    e.target.value = "";
                  }}
                />

                {video ? (
                  <div className="flex w-full flex-col items-center justify-between gap-3 sm:flex-row sm:text-left">
                    <div className="flex items-center gap-3">
                      <div className="nb-key flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[#FF4D2E]">
                        <FileVideo className="h-5 w-5" />
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold text-[#F5F5F2]">
                          {video.file.name}
                        </p>
                        <p className="font-mono text-xs text-[#9A9DA8]">
                          {video.width}×{video.height} ·{" "}
                          {formatDuration(video.duration)} ·{" "}
                          {formatBytes(video.sizeBytes)}
                        </p>
                      </div>
                    </div>
                    <span className="nb-key rounded-xl px-3 py-1.5 text-xs font-semibold">
                      Replace Loop
                    </span>
                  </div>
                ) : (
                  <>
                    <div className="nb-key mb-3 flex h-12 w-12 items-center justify-center rounded-2xl text-[#FF4D2E]">
                      <Upload className="h-5 w-5" />
                    </div>
                    <p className="text-sm font-bold text-[#F5F5F2]">
                      Drop your background video loop here
                    </p>
                    <p className="mt-1 font-mono text-[11px] text-[#9A9DA8]">
                      MP4, MOV, or WebM · 5–15s 9:16 clips render fastest
                    </p>
                  </>
                )}
              </div>

              {/* Video Options */}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-3.5">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-[#9A9DA8]">
                    Frame:
                  </span>
                  <div className="nb-well inline-flex gap-1 rounded-xl p-1">
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => setAspectMode("force-9x16")}
                      className={`nb-key rounded-lg px-2.5 py-1 text-xs font-semibold ${
                        aspectMode === "force-9x16"
                          ? "nb-key-active"
                          : "!border-transparent !bg-transparent !shadow-none text-[#9A9DA8]"
                      }`}
                    >
                      1080×1920 (9:16)
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => setAspectMode("original")}
                      className={`nb-key rounded-lg px-2.5 py-1 text-xs font-semibold ${
                        aspectMode === "original"
                          ? "nb-key-active"
                          : "!border-transparent !bg-transparent !shadow-none text-[#9A9DA8]"
                      }`}
                    >
                      Keep Original
                    </button>
                  </div>
                </div>

                <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-[#C4C7D0]">
                  <input
                    type="checkbox"
                    checked={muteAudio}
                    disabled={isBusy}
                    onChange={(e) => setMuteAudio(e.target.checked)}
                    className="h-4 w-4 rounded accent-[#FF4D2E]"
                  />
                  {muteAudio ? (
                    <VolumeX className="h-3.5 w-3.5 text-[#FF4D2E]" />
                  ) : (
                    <Volume2 className="h-3.5 w-3.5 text-[#9A9DA8]" />
                  )}
                  <span>Mute original audio</span>
                </label>
              </div>
            </section>

            {/* Step 2: Proven Hooks List */}
            <section className="nb-module p-5">
              <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-bold text-[#FF4D2E]">
                    02
                  </span>
                  <h2 className="text-sm font-bold tracking-tight text-[#F5F5F2]">
                    Hooks
                  </h2>
                  <span className="font-mono text-xs text-[#8B8F9C]">
                    ({hooks.length})
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={handleLoadSample20}
                    className="nb-key inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1 text-xs font-semibold"
                  >
                    <Sparkles className="h-3 w-3 text-[#FF4D2E]" />
                    Load 20 Sample Hooks
                  </button>
                  <button
                    type="button"
                    disabled={isBusy || hooks.length === 0}
                    onClick={handleDedupeHooks}
                    className="nb-key inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1 text-xs font-semibold"
                  >
                    <ListChecks className="h-3 w-3" />
                    Dedupe
                  </button>
                  <button
                    type="button"
                    disabled={isBusy || hooksText.length === 0}
                    onClick={() => {
                      setHooksText("");
                      setActiveHookIndex(0);
                    }}
                    className="nb-key inline-flex items-center gap-1 rounded-xl px-2.5 py-1 text-xs font-semibold text-[#9A9DA8]"
                  >
                    Clear
                  </button>
                </div>
              </div>

              <label htmlFor="hooks-textarea" className="sr-only">
                Paste one hook per line
              </label>
              <textarea
                id="hooks-textarea"
                rows={8}
                disabled={isBusy}
                value={hooksText}
                onChange={(e) => setHooksText(e.target.value)}
                placeholder="Paste 20 proven hooks from your outlier tracker (one hook per line)..."
                className="nb-well nb-scroll w-full rounded-2xl p-4 font-sans text-sm leading-relaxed text-[#F5F5F2] placeholder:text-[#5A5E6B] focus:border-[#FF4D2E] focus:outline-none disabled:opacity-60"
              />

              {hooks.length > 0 && (
                <div className="mt-3.5">
                  <div className="mb-2 flex items-center justify-between text-[11px] font-medium text-[#9A9DA8]">
                    <span>Click any hook to preview on stage:</span>
                    <span className="font-mono text-[#787C8A]">
                      01–{String(hooks.length).padStart(2, "0")}.mp4
                    </span>
                  </div>
                  <div className="nb-scroll flex max-h-24 flex-wrap gap-1.5 overflow-y-auto pr-1">
                    {hooks.map((hook, idx) => (
                      <button
                        key={`${idx}-${hook.slice(0, 12)}`}
                        type="button"
                        onClick={() => setActiveHookIndex(idx)}
                        className={`nb-key max-w-[220px] truncate rounded-xl px-2.5 py-1 text-left text-[11px] font-medium ${
                          idx === activeHookIndex ? "nb-key-active" : ""
                        }`}
                        title={hook}
                      >
                        <span className="mr-1 font-mono font-bold opacity-80">
                          {String(idx + 1).padStart(2, "0")}
                        </span>
                        {hook}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </section>

            {/* Step 3: Text Styling */}
            <section className="nb-module p-5">
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-bold text-[#FF4D2E]">
                    03
                  </span>
                  <h2 className="text-sm font-bold tracking-tight text-[#F5F5F2]">
                    Text Style
                  </h2>
                </div>
                <Sliders className="h-4 w-4 text-[#8B8F9C]" />
              </div>

              {/* Presets */}
              <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                {TEXT_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    disabled={isBusy}
                    onClick={() =>
                      setStyleConfig((prev) => ({ ...prev, ...preset.config }))
                    }
                    className="nb-key flex flex-col items-start rounded-2xl p-3 text-left"
                  >
                    <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-[#FF4D2E]">
                      {preset.badge}
                    </span>
                    <span className="mt-0.5 text-xs font-bold text-[#F5F5F2]">
                      {preset.label}
                    </span>
                  </button>
                ))}
              </div>

              {/* Controls Grid */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {/* Font Family */}
                <div>
                  <label className="mb-1.5 block font-mono text-[10px] font-semibold uppercase tracking-wider text-[#9A9DA8]">
                    Font Family
                  </label>
                  <div className="grid grid-cols-3 gap-1.5">
                    {(
                      [
                        { id: "inter", label: "Inter Bold" },
                        { id: "marker", label: "Marker" },
                        { id: "impact", label: "Impact" },
                      ] as { id: FontFamilyOption; label: string }[]
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        disabled={isBusy}
                        onClick={() =>
                          setStyleConfig((p) => ({ ...p, fontFamily: opt.id }))
                        }
                        className={`nb-key rounded-xl px-2 py-1.5 text-xs font-semibold ${
                          styleConfig.fontFamily === opt.id ? "nb-key-active" : ""
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Pill / Backdrop */}
                <div>
                  <label className="mb-1.5 block font-mono text-[10px] font-semibold uppercase tracking-wider text-[#9A9DA8]">
                    Backdrop Style
                  </label>
                  <div className="grid grid-cols-4 gap-1.5">
                    {(
                      [
                        { id: "black", label: "Black" },
                        { id: "crimson", label: "LXG Red" },
                        { id: "white", label: "White" },
                        { id: "outline", label: "Outline" },
                      ] as { id: PillStyleOption; label: string }[]
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        disabled={isBusy}
                        onClick={() =>
                          setStyleConfig((p) => ({
                            ...p,
                            pillStyle: opt.id,
                            textColor:
                              opt.id === "white" ? "#000000" : "#FFFFFF",
                          }))
                        }
                        className={`nb-key rounded-xl px-2 py-1.5 text-xs font-semibold ${
                          styleConfig.pillStyle === opt.id ? "nb-key-active" : ""
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Font Size */}
                <div>
                  <div className="mb-1 flex justify-between text-xs">
                    <label
                      htmlFor="font-size-range"
                      className="font-mono text-[10px] font-semibold uppercase tracking-wider text-[#9A9DA8]"
                    >
                      Text Size
                    </label>
                    <span className="font-mono font-bold text-[#F5F5F2]">
                      {styleConfig.fontSize}px
                    </span>
                  </div>
                  <input
                    id="font-size-range"
                    type="range"
                    min={34}
                    max={92}
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
                        "--attr-min": 34,
                        "--attr-max": 92,
                        "--control-value": styleConfig.fontSize,
                      } as React.CSSProperties
                    }
                    className="nb-slider"
                  />
                </div>

                {/* Vertical Position */}
                <div>
                  <div className="mb-1 flex justify-between text-xs">
                    <label
                      htmlFor="y-pos-range"
                      className="font-mono text-[10px] font-semibold uppercase tracking-wider text-[#9A9DA8]"
                    >
                      Vertical Position
                    </label>
                    <span className="font-mono font-bold text-[#F5F5F2]">
                      {styleConfig.yPositionPercent}%
                    </span>
                  </div>
                  <input
                    id="y-pos-range"
                    type="range"
                    min={14}
                    max={80}
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
                        "--attr-min": 14,
                        "--attr-max": 80,
                        "--control-value": styleConfig.yPositionPercent,
                      } as React.CSSProperties
                    }
                    className="nb-slider"
                  />
                </div>
              </div>

              {/* Uppercase + Text Color */}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-3.5">
                <div className="flex items-center gap-2.5">
                  <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-[#9A9DA8]">
                    Color:
                  </span>
                  {["#FFFFFF", "#000000", "#FACC15", "#E11D48"].map((hex) => (
                    <button
                      key={hex}
                      type="button"
                      disabled={isBusy}
                      onClick={() =>
                        setStyleConfig((p) => ({ ...p, textColor: hex }))
                      }
                      aria-label={`Set text color ${hex}`}
                      className={`h-7 w-7 rounded-full border-2 transition ${
                        styleConfig.textColor === hex
                          ? "scale-110 border-[#FF4D2E] ring-2 ring-[#FF4D2E]/50"
                          : "border-white/25 hover:scale-105"
                      }`}
                      style={{ backgroundColor: hex }}
                    />
                  ))}
                </div>

                <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-[#C4C7D0]">
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
                  <span>ALL CAPS</span>
                </label>
              </div>
            </section>
          </div>

          {/* RIGHT COLUMN: PREVIEW & RENDER QUEUE (5 cols) */}
          <div className="flex flex-col gap-6 lg:col-span-5">
            <HookPreviewStage
              video={video}
              hooks={hooks}
              activeHookIndex={activeHookIndex}
              onChangeHookIndex={setActiveHookIndex}
              styleConfig={styleConfig}
              aspectMode={aspectMode}
              muteAudio={muteAudio}
            />

            {/* Render Action Card */}
            <section className="nb-module p-5">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-mono text-[11px] font-semibold uppercase tracking-widest text-[#8B8F9C]">
                  Export
                </h2>
                {isBusy && (
                  <span className="font-mono text-xs text-[#8B8F9C]">
                    {formatDuration(elapsedSeconds)}
                  </span>
                )}
              </div>

              <label className="mb-4 flex cursor-pointer items-center gap-2 text-xs font-medium text-[#C4C7D0]">
                <input
                  type="checkbox"
                  checked={autoDownloadEach}
                  disabled={isBusy}
                  onChange={(e) => setAutoDownloadEach(e.target.checked)}
                  className="h-4 w-4 rounded accent-[#FF4D2E]"
                />
                <span>Auto-download each MP4 immediately as it finishes</span>
              </label>

              {!isBusy ? (
                <button
                  type="button"
                  disabled={!video || hooks.length === 0}
                  onClick={handleStartBatch}
                  className="nb-key-primary flex w-full items-center justify-center gap-2 rounded-2xl px-5 py-3.5 text-sm font-extrabold uppercase tracking-wider"
                >
                  <Play className="h-4 w-4 fill-current" />
                  <span>
                    Render {hooks.length} Unique{" "}
                    {hooks.length === 1 ? "MP4" : "MP4s"}
                  </span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleCancelBatch}
                  className="nb-key flex w-full items-center justify-center gap-2 rounded-2xl !border-red-500/40 !bg-red-500/15 px-5 py-3.5 text-sm font-bold uppercase tracking-wider text-red-200"
                >
                  <Square className="h-4 w-4 fill-current text-[#FF4D2E]" />
                  <span>Cancel Batch</span>
                </button>
              )}

              {/* Progress Bars */}
              {(isBusy || phase === "completed" || phase === "cancelled") && (
                <div className="nb-well mt-4 space-y-3 rounded-2xl p-3.5">
                  <div>
                    <div className="mb-1.5 flex justify-between text-xs">
                      <span className="font-semibold text-[#C4C7D0]">
                        Batch Progress
                      </span>
                      <span className="font-mono font-bold text-[#F5F5F2]">
                        {renderedClips.length} / {hooks.length} (
                        {Math.round(overallProgress * 100)}%)
                      </span>
                    </div>
                    <progress
                      className="lxg-progress"
                      aria-label="Overall batch render progress"
                      value={
                        phase === "loading-ffmpeg" ? undefined : overallProgress
                      }
                      max={1}
                    />
                  </div>

                  {phase === "rendering" && (
                    <div>
                      <div className="mb-1.5 flex justify-between text-[11px]">
                        <span className="text-[#9A9DA8]">
                          Clip #{currentClipIndex + 1} encoding
                        </span>
                        <span className="font-mono font-bold text-[#FF4D2E]">
                          {Math.round(currentClipProgress * 100)}%
                        </span>
                      </div>
                      <progress
                        className="lxg-progress"
                        aria-label="Current clip encode progress"
                        value={currentClipProgress}
                        max={1}
                      />
                    </div>
                  )}

                  <p
                    role="status"
                    aria-live="polite"
                    className="flex items-center gap-2 text-xs text-[#C4C7D0]"
                  >
                    {isBusy && (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[#FF4D2E]" />
                    )}
                    {phase === "completed" && (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                    )}
                    <span className="truncate">{statusMessage}</span>
                  </p>
                </div>
              )}

              {errorMessage && (
                <div
                  role="alert"
                  className="mt-4 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-200"
                >
                  {errorMessage}
                </div>
              )}
            </section>
          </div>
        </div>

        {/* Rendered Output Vault */}
        {renderedClips.length > 0 && (
          <section className="nb-module mt-8 p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-[#F5F5F2]">
                  Rendered Output Vault ({renderedClips.length})
                </h2>
                <p className="font-mono text-[11px] text-[#9A9DA8]">
                  All MP4s are encoded with H.264 + yuv420p for instant TikTok,
                  Reels, and Shorts upload.
                </p>
              </div>

              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={clearRenderedClips}
                  className="nb-key rounded-xl px-3.5 py-2 text-xs font-semibold"
                >
                  Clear Vault
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
                  <span>
                    {isZipping
                      ? "Zipping..."
                      : `Download All (${renderedClips.length} MP4s .zip)`}
                  </span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {renderedClips.map((clip) => (
                <div
                  key={clip.id}
                  className="nb-well flex flex-col justify-between gap-3 rounded-2xl p-3.5"
                >
                  <div>
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <span className="rounded-lg bg-[#FF4D2E]/15 px-2 py-0.5 font-mono text-[10px] font-bold text-[#FF4D2E]">
                        #{String(clip.index + 1).padStart(2, "0")}
                      </span>
                      <span className="font-mono text-[10px] text-[#787C8A]">
                        {formatBytes(clip.sizeBytes)} ·{" "}
                        {(clip.renderMs / 1000).toFixed(1)}s
                      </span>
                    </div>
                    <p className="line-clamp-2 text-xs font-semibold text-[#F5F5F2]">
                      {clip.hookText}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 border-t border-white/10 pt-2.5">
                    <button
                      type="button"
                      onClick={() => setPreviewClip(clip)}
                      className="nb-key flex flex-1 items-center justify-center gap-1.5 rounded-xl py-1.5 text-xs font-semibold"
                    >
                      <Play className="h-3 w-3" />
                      Preview
                    </button>
                    <button
                      type="button"
                      onClick={() => triggerDownload(clip.url, clip.filename)}
                      className="nb-key-primary flex flex-1 items-center justify-center gap-1.5 rounded-xl py-1.5 text-xs font-bold"
                    >
                      <Download className="h-3 w-3" />
                      MP4
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
        </div>
      </main>

      {/* Rendered Clip Preview Modal */}
      {previewClip && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
          onClick={() => setPreviewClip(null)}
        >
          <div
            className="nb-module relative flex w-full max-w-sm flex-col gap-3.5 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-xs font-bold text-[#F5F5F2]">
                {previewClip.filename}
              </span>
              <button
                type="button"
                onClick={() => setPreviewClip(null)}
                aria-label="Close preview"
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
              Download {previewClip.filename}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

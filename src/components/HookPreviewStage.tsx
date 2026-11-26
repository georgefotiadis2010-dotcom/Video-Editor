"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Crop,
  Eye,
  EyeOff,
  Film,
  Pause,
  Play,
  RotateCcw,
} from "lucide-react";
import { drawHookOnCanvas } from "@/lib/text-overlay";
import {
  buildPreviewCssFilter,
  DEFAULT_VIDEO_CROP,
  isCropActive,
} from "@/lib/video-effects";
import type {
  AspectMode,
  BeatCutSegment,
  SourceClipItem,
  TextStyleConfig,
  VideoCropRect,
  VideoFilterConfig,
  VideoMetadata,
} from "@/types/renderer";

export interface BeatSyncPreviewData {
  audioUrl: string;
  windowStart: number;
  windowEnd: number;
  segments: BeatCutSegment[];
  clips: SourceClipItem[];
}

interface HookPreviewStageProps {
  video: VideoMetadata | null;
  hooks: string[];
  activeHookIndex: number;
  onChangeHookIndex: (nextIndex: number) => void;
  styleConfig: TextStyleConfig;
  aspectMode: AspectMode;
  muteAudio: boolean;
  beatSyncPreview?: BeatSyncPreviewData | null;
  videoFilter?: VideoFilterConfig;
  videoCrop?: VideoCropRect;
  onChangeCrop?: (next: VideoCropRect) => void;
}

export function HookPreviewStage({
  video,
  hooks,
  activeHookIndex,
  onChangeHookIndex,
  styleConfig,
  aspectMode,
  muteAudio,
  beatSyncPreview,
  videoFilter,
  videoCrop,
  onChangeCrop,
}: HookPreviewStageProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const poolVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const activeSegIdxRef = useRef<number>(-1);
  const cropDragRef = useRef<{
    handle: "move" | "nw" | "ne" | "sw" | "se";
    startX: number;
    startY: number;
    orig: VideoCropRect;
  } | null>(null);

  const [showSafeZone, setShowSafeZone] = useState(true);
  const [isCropping, setIsCropping] = useState(false);
  const [isBeatPlaying, setIsBeatPlaying] = useState(false);
  const [activePreviewClipId, setActivePreviewClipId] = useState<string | null>(
    null
  );
  const [activeSegLabel, setActiveSegLabel] = useState<string | null>(null);
  const [decodeErrorState, setDecodeErrorState] = useState<{
    url: string;
    message: string;
  } | null>(null);

  const activeCrop = videoCrop ?? DEFAULT_VIDEO_CROP;
  const cropEnabled = isCropActive(activeCrop);

  const canBeatPreview = Boolean(
    beatSyncPreview &&
      beatSyncPreview.segments.length > 0 &&
      beatSyncPreview.clips.length > 0
  );
  const effectiveBeatPlaying = isBeatPlaying && canBeatPreview;

  const displayVideoUrl = video
    ? (video.previewUrl ?? (video.browserPlayable === false ? null : video.url))
    : null;

  const videoDecodeError =
    decodeErrorState && decodeErrorState.url === displayVideoUrl
      ? decodeErrorState.message
      : null;

  const clipInfoMap = useMemo(() => {
    const map = new Map<string, { url: string; duration: number }>();
    if (beatSyncPreview) {
      for (const c of beatSyncPreview.clips) {
        const playableUrl =
          c.previewUrl ?? (c.browserPlayable === false ? "" : c.url);
        map.set(c.id, { url: playableUrl, duration: c.duration });
      }
    }
    return map;
  }, [beatSyncPreview]);

  const stopBeatPreview = useCallback(() => {
    setIsBeatPlaying(false);
    setActivePreviewClipId(null);
    setActiveSegLabel(null);
    activeSegIdxRef.current = -1;
    if (audioRef.current) {
      audioRef.current.pause();
    }
    for (const vid of poolVideoRefs.current.values()) {
      vid.pause();
    }
  }, []);

  // Manage audio element for live beat-sync preview
  useEffect(() => {
    if (!beatSyncPreview?.audioUrl) return;
    const audio = new Audio(beatSyncPreview.audioUrl);
    audio.preload = "auto";
    audioRef.current = audio;

    return () => {
      audio.pause();
      audioRef.current = null;
    };
  }, [beatSyncPreview?.audioUrl]);

  // Real-time beat-cut playback loop using pre-warmed clip video pool
  useEffect(() => {
    if (
      !effectiveBeatPlaying ||
      !beatSyncPreview ||
      beatSyncPreview.segments.length === 0
    ) {
      return;
    }
    const audio = audioRef.current;
    if (!audio) return;

    const { windowStart, windowEnd, segments } = beatSyncPreview;
    activeSegIdxRef.current = -1;
    audio.currentTime = windowStart;
    audio.play().catch(() => {});

    const seekAndPlayPoolVideo = (
      clipId: string,
      targetTime: number,
      shouldPlay: boolean
    ) => {
      const vid = poolVideoRefs.current.get(clipId);
      if (!vid) return;
      const info = clipInfoMap.get(clipId);
      const safeTime =
        info && info.duration > 0.2 ? targetTime % info.duration : 0;

      const apply = () => {
        if (Math.abs(vid.currentTime - safeTime) > 0.12) {
          vid.currentTime = safeTime;
        }
        if (shouldPlay) {
          vid.play().catch(() => {});
        } else {
          vid.pause();
        }
      };

      if (vid.readyState >= 1) {
        apply();
      } else {
        vid.onloadedmetadata = () => {
          vid.onloadedmetadata = null;
          apply();
        };
      }
    };

    let raf = 0;
    const tick = () => {
      let t = audio.currentTime;
      if (t >= windowEnd || t < windowStart - 0.1) {
        t = windowStart;
        audio.currentTime = windowStart;
        activeSegIdxRef.current = -1;
      }

      let segIdx = segments.findIndex((s) => t >= s.startTime && t < s.endTime);
      if (segIdx === -1) {
        segIdx = t < segments[0].startTime ? 0 : segments.length - 1;
      }

      if (segIdx !== activeSegIdxRef.current) {
        const prevIdx = activeSegIdxRef.current;
        activeSegIdxRef.current = segIdx;
        const seg = segments[segIdx];

        if (prevIdx >= 0 && prevIdx < segments.length) {
          const prevClipId = segments[prevIdx].clipId;
          if (prevClipId !== seg.clipId) {
            poolVideoRefs.current.get(prevClipId)?.pause();
          }
        }

        setActivePreviewClipId(seg.clipId);
        setActiveSegLabel(`Cut ${segIdx + 1}/${segments.length}`);

        const offsetInSeg = Math.max(0, t - seg.startTime);
        seekAndPlayPoolVideo(seg.clipId, seg.sourceStart + offsetInSeg, true);

        // Pre-seek the upcoming cut if it uses a different clip
        const nextSeg = segments[(segIdx + 1) % segments.length];
        if (nextSeg && nextSeg.clipId !== seg.clipId) {
          seekAndPlayPoolVideo(nextSeg.clipId, nextSeg.sourceStart, false);
        }
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      audio.pause();
      for (const vid of poolVideoRefs.current.values()) {
        vid.pause();
      }
    };
  }, [effectiveBeatPlaying, beatSyncPreview, clipInfoMap]);

  const safeIndex =
    hooks.length > 0 ? Math.min(activeHookIndex, hooks.length - 1) : 0;
  const currentHook =
    hooks[safeIndex] ??
    "Paste your proven hooks on the left to preview them live";

  const targetWidth =
    aspectMode === "force-9x16"
      ? 1080
      : video
        ? Math.max(2, Math.floor(video.width / 2) * 2)
        : 1080;
  const targetHeight =
    aspectMode === "force-9x16"
      ? 1920
      : video
        ? Math.max(2, Math.floor(video.height / 2) * 2)
        : 1920;

  // Render preview canvas at 50% scale (e.g. 540x960) for crisp 2x Retina display without 1080p realloc lag
  const previewWidth = Math.max(2, Math.round(targetWidth * 0.5));
  const previewHeight = Math.max(2, Math.round(targetHeight * 0.5));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (canvas.width !== previewWidth) {
      canvas.width = previewWidth;
    }
    if (canvas.height !== previewHeight) {
      canvas.height = previewHeight;
    }

    let cancelled = false;
    const draw = () => {
      if (cancelled) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      drawHookOnCanvas(
        ctx,
        previewWidth,
        previewHeight,
        currentHook,
        styleConfig
      );
    };

    draw();
    if (document.fonts?.ready) {
      document.fonts.ready.then(draw);
    }

    return () => {
      cancelled = true;
    };
  }, [previewWidth, previewHeight, currentHook, styleConfig]);

  const aspectRatioCss = `${targetWidth} / ${targetHeight}`;
  const fitClass = aspectMode === "force-9x16" ? "object-cover" : "object-contain";

  const cssFilter = buildPreviewCssFilter(videoFilter);

  // Compute uniform crop preview transform when not actively editing the crop box
  const cropTransformStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (isCropping || !cropEnabled) return undefined;
    const scale =
      aspectMode === "force-9x16"
        ? Math.max(1 / activeCrop.width, 1 / activeCrop.height)
        : Math.min(1 / activeCrop.width, 1 / activeCrop.height);
    const cx = activeCrop.x + activeCrop.width / 2;
    const cy = activeCrop.y + activeCrop.height / 2;
    const txPct = 50 / scale - cx * 100;
    const tyPct = 50 / scale - cy * 100;
    return {
      transformOrigin: "0 0",
      transform: `scale(${scale.toFixed(4)}) translate(${txPct.toFixed(3)}%, ${tyPct.toFixed(3)}%)`,
    };
  }, [isCropping, cropEnabled, activeCrop, aspectMode]);

  const startCropDrag = (
    e: React.PointerEvent<HTMLElement>,
    handle: "move" | "nw" | "ne" | "sw" | "se"
  ) => {
    if (!onChangeCrop) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    cropDragRef.current = {
      handle,
      startX: e.clientX,
      startY: e.clientY,
      orig: { ...activeCrop },
    };
  };

  const handleCropPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const drag = cropDragRef.current;
    const stage = stageRef.current;
    if (!drag || !stage || !onChangeCrop) return;
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const dx = (e.clientX - drag.startX) / rect.width;
    const dy = (e.clientY - drag.startY) / rect.height;
    const minSize = 0.15;
    const { orig, handle } = drag;

    let x = orig.x;
    let y = orig.y;
    let w = orig.width;
    let h = orig.height;

    if (handle === "move") {
      x = Math.max(0, Math.min(1 - w, orig.x + dx));
      y = Math.max(0, Math.min(1 - h, orig.y + dy));
    } else {
      if (handle === "nw" || handle === "sw") {
        const right = orig.x + orig.width;
        const nextX = Math.max(0, Math.min(right - minSize, orig.x + dx));
        w = right - nextX;
        x = nextX;
      }
      if (handle === "ne" || handle === "se") {
        w = Math.max(minSize, Math.min(1 - orig.x, orig.width + dx));
      }
      if (handle === "nw" || handle === "ne") {
        const bottom = orig.y + orig.height;
        const nextY = Math.max(0, Math.min(bottom - minSize, orig.y + dy));
        h = bottom - nextY;
        y = nextY;
      }
      if (handle === "sw" || handle === "se") {
        h = Math.max(minSize, Math.min(1 - orig.y, orig.height + dy));
      }
    }

    onChangeCrop({
      x: Number(x.toFixed(4)),
      y: Number(y.toFixed(4)),
      width: Number(w.toFixed(4)),
      height: Number(h.toFixed(4)),
    });
  };

  const endCropDrag = () => {
    cropDragRef.current = null;
  };

  return (
    <div className="nb-module flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-widest text-[#8B8F9C]">
          Preview
        </span>

        <div className="flex items-center gap-1.5">
          {canBeatPreview && (
            <button
              type="button"
              onClick={() =>
                effectiveBeatPlaying ? stopBeatPreview() : setIsBeatPlaying(true)
              }
              className={`nb-key inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider ${
                effectiveBeatPlaying ? "nb-key-primary" : ""
              }`}
              title="Preview beat-synced cuts with music & text overlay in real time"
            >
              {effectiveBeatPlaying ? (
                <>
                  <Pause className="h-3 w-3" />
                  <span>Stop</span>
                </>
              ) : (
                <>
                  <Play className="h-3 w-3 fill-current text-[#FF4D2E]" />
                  <span>Beat Preview</span>
                </>
              )}
            </button>
          )}

          {onChangeCrop && (
            <button
              type="button"
              disabled={!displayVideoUrl && !canBeatPreview}
              onClick={() => setIsCropping((prev) => !prev)}
              className={`nb-key inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider ${
                isCropping
                  ? "nb-key-primary"
                  : cropEnabled
                    ? "nb-key-active"
                    : ""
              }`}
              title="Drag corners to crop video frame"
            >
              {isCropping ? (
                <>
                  <Check className="h-3 w-3" />
                  <span>Done Crop</span>
                </>
              ) : (
                <>
                  <Crop className="h-3 w-3" />
                  <span>{cropEnabled ? "Cropped" : "Crop"}</span>
                </>
              )}
            </button>
          )}

          <button
            type="button"
            onClick={() => setShowSafeZone((prev) => !prev)}
            className={`nb-key inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider ${
              showSafeZone ? "nb-key-active" : ""
            }`}
            title="Toggle TikTok / Reels UI safe-zone guides"
          >
            {showSafeZone ? (
              <Eye className="h-3 w-3" />
            ) : (
              <EyeOff className="h-3 w-3 text-[#8B8F9C]" />
            )}
            <span>Safe Zones</span>
          </button>
        </div>
      </div>

      {/* Phone Stage */}
      <div className="flex justify-center">
        <div
          ref={stageRef}
          className="relative w-full max-w-[260px] overflow-hidden rounded-2xl border border-white/10 bg-black select-none"
          style={{ aspectRatio: aspectRatioCss }}
        >
          {/* Video + Color Grade Layer */}
          <div
            className="relative h-full w-full"
            style={{
              ...cropTransformStyle,
              filter: cssFilter,
            }}
          >
            {effectiveBeatPlaying && beatSyncPreview ? (
              <div className="relative h-full w-full">
                {beatSyncPreview.clips.map((clip) => {
                  const isActive =
                    activePreviewClipId === clip.id ||
                    (!activePreviewClipId &&
                      clip.id === beatSyncPreview.segments[0]?.clipId);
                  const clipPlayableUrl =
                    clip.previewUrl ??
                    (clip.browserPlayable === false ? undefined : clip.url);

                  if (!clipPlayableUrl && clip.thumbnailUrl) {
                    return (
                      <img
                        key={clip.id}
                        src={clip.thumbnailUrl}
                        alt={clip.file.name}
                        className={`absolute inset-0 h-full w-full ${fitClass} transition-opacity duration-75 ${
                          isActive
                            ? "z-[1] opacity-100"
                            : "z-0 opacity-0 pointer-events-none"
                        }`}
                      />
                    );
                  }

                  return (
                    <video
                      key={clip.id}
                      ref={(el) => {
                        if (el) {
                          poolVideoRefs.current.set(clip.id, el);
                        } else {
                          poolVideoRefs.current.delete(clip.id);
                        }
                      }}
                      src={clipPlayableUrl}
                      poster={clip.thumbnailUrl}
                      muted
                      playsInline
                      preload="auto"
                      className={`absolute inset-0 h-full w-full ${fitClass} transition-opacity duration-75 ${
                        isActive ? "z-[1] opacity-100" : "z-0 opacity-0 pointer-events-none"
                      }`}
                    />
                  );
                })}
              </div>
            ) : displayVideoUrl ? (
              <>
                <video
                  ref={videoRef}
                  key={displayVideoUrl}
                  src={displayVideoUrl}
                  poster={video?.thumbnailUrl}
                  autoPlay
                  loop
                  muted={muteAudio}
                  playsInline
                  preload="auto"
                  onLoadedMetadata={(e) => {
                    if (e.currentTarget.videoWidth === 0) {
                      setDecodeErrorState({
                        url: displayVideoUrl,
                        message:
                          "Browser cannot preview this video codec directly — FFmpeg can still render it.",
                      });
                    }
                  }}
                  onLoadedData={(e) => {
                    const vid = e.currentTarget;
                    vid.play().catch(() => {
                      // Browser blocked unmuted autoplay; fall back to muted preview
                      vid.muted = true;
                      vid.play().catch(() => {});
                    });
                  }}
                  onError={() => {
                    setDecodeErrorState({
                      url: displayVideoUrl,
                      message:
                        "Browser cannot preview this video codec directly — FFmpeg can still render it.",
                    });
                  }}
                  className={`h-full w-full ${fitClass}`}
                />
                {videoDecodeError && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/85 p-5 text-center">
                    <Film className="h-5 w-5 text-[#FF4D2E]" />
                    <p className="font-mono text-[10px] leading-relaxed text-[#C4C7D0]">
                      {videoDecodeError}
                    </p>
                  </div>
                )}
              </>
            ) : video?.thumbnailUrl ? (
              <div className="relative h-full w-full">
                <img
                  src={video.thumbnailUrl}
                  alt={video.file.name}
                  className={`h-full w-full ${fitClass}`}
                />
                {video.isGeneratingProxy && (
                  <span className="pointer-events-none absolute bottom-2.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-white/15 bg-black/75 px-2.5 py-0.5 font-mono text-[9px] text-[#C4C7D0] backdrop-blur-sm">
                    Preparing video preview...
                  </span>
                )}
              </div>
            ) : video?.isGeneratingProxy ? (
              <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center">
                <Film className="h-5 w-5 animate-pulse text-[#FF4D2E]" />
                <p className="font-mono text-[11px] text-[#C4C7D0]">
                  Preparing clip preview...
                </p>
              </div>
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center">
                <Film className="h-5 w-5 text-[#555966]" />
                <p className="font-mono text-[11px] text-[#8B8F9C]">
                  No video loaded
                </p>
              </div>
            )}
          </div>

          {/* Color Tint / Matte Fade / Vignette Preview Overlays */}
          {videoFilter && Math.abs(videoFilter.temperature) > 0.01 && (
            <div
              className="pointer-events-none absolute inset-0 z-[1]"
              style={{
                backgroundColor:
                  videoFilter.temperature < 0
                    ? `rgba(12, 68, 92, ${Math.min(0.42, Math.abs(videoFilter.temperature) * 0.42)})`
                    : `rgba(180, 105, 40, ${Math.min(0.32, videoFilter.temperature * 0.32)})`,
                mixBlendMode: videoFilter.temperature < 0 ? "color" : "soft-light",
              }}
            />
          )}
          {videoFilter && videoFilter.fade > 0.005 && (
            <div
              className="pointer-events-none absolute inset-0 z-[1]"
              style={{
                backgroundColor: `rgba(14, 24, 32, ${Math.min(0.35, videoFilter.fade * 0.75)})`,
                mixBlendMode: "lighten",
              }}
            />
          )}
          {videoFilter && videoFilter.vignette > 0.005 && (
            <div
              className="pointer-events-none absolute inset-0 z-[1]"
              style={{
                background: `radial-gradient(circle at 50% 48%, rgba(0,0,0,0) ${Math.round(52 - videoFilter.vignette * 20)}%, rgba(0,0,0,${(videoFilter.vignette * 0.72).toFixed(2)}) 100%)`,
              }}
            />
          )}

          {effectiveBeatPlaying && activeSegLabel && (
            <span className="pointer-events-none absolute left-2.5 top-2.5 z-10 rounded-full border border-white/15 bg-black/75 px-2 py-0.5 font-mono text-[10px] font-bold text-[#FF4D2E] backdrop-blur-sm">
              {activeSegLabel}
            </span>
          )}

          {/* WYSIWYG Canvas Overlay */}
          <canvas
            ref={canvasRef}
            className="pointer-events-none absolute inset-0 z-[2] h-full w-full"
          />

          {/* Interactive Corner-Drag Crop Overlay */}
          {isCropping && onChangeCrop && (
            <div className="absolute inset-0 z-[4]">
              <div
                onPointerDown={(e) => startCropDrag(e, "move")}
                onPointerMove={handleCropPointerMove}
                onPointerUp={endCropDrag}
                onPointerCancel={endCropDrag}
                style={{
                  left: `${activeCrop.x * 100}%`,
                  top: `${activeCrop.y * 100}%`,
                  width: `${activeCrop.width * 100}%`,
                  height: `${activeCrop.height * 100}%`,
                  boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.62)",
                }}
                className="absolute cursor-move border-2 border-[#FF4D2E]"
              >
                {/* Rule-of-thirds guides */}
                <div className="pointer-events-none absolute inset-x-0 top-1/3 h-px bg-white/20" />
                <div className="pointer-events-none absolute inset-x-0 top-2/3 h-px bg-white/20" />
                <div className="pointer-events-none absolute inset-y-0 left-1/3 w-px bg-white/20" />
                <div className="pointer-events-none absolute inset-y-0 left-2/3 w-px bg-white/20" />

                {/* 4 Draggable Corner Handles */}
                {(
                  [
                    { id: "nw", pos: "-left-2 -top-2 cursor-nwse-resize" },
                    { id: "ne", pos: "-right-2 -top-2 cursor-nesw-resize" },
                    { id: "sw", pos: "-bottom-2 -left-2 cursor-nesw-resize" },
                    { id: "se", pos: "-bottom-2 -right-2 cursor-nwse-resize" },
                  ] as const
                ).map((c) => (
                  <div
                    key={c.id}
                    onPointerDown={(e) => startCropDrag(e, c.id)}
                    onPointerMove={handleCropPointerMove}
                    onPointerUp={endCropDrag}
                    onPointerCancel={endCropDrag}
                    className={`absolute h-4 w-4 rounded-sm border-2 border-white bg-[#FF4D2E] shadow-md ${c.pos}`}
                  />
                ))}
              </div>

              {cropEnabled && (
                <button
                  type="button"
                  onClick={() => onChangeCrop({ ...DEFAULT_VIDEO_CROP })}
                  className="nb-key absolute bottom-2.5 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1 rounded-full bg-black/85 px-2.5 py-1 font-mono text-[10px] font-semibold text-white"
                >
                  <RotateCcw className="h-2.5 w-2.5" />
                  <span>Reset Crop</span>
                </button>
              )}
            </div>
          )}

          {/* TikTok / Reels Safe Zone Guide */}
          {showSafeZone && !isCropping && (
            <div className="pointer-events-none absolute inset-0 z-[3]">
              <div className="absolute inset-x-0 top-0 h-[10%] border-b border-dashed border-white/20 bg-black/20" />
              <div className="absolute bottom-[14%] right-0 h-[36%] w-[16%] border-l border-t border-b border-dashed border-white/20 bg-black/20" />
              <div className="absolute inset-x-0 bottom-0 h-[18%] border-t border-dashed border-white/20 bg-black/25">
                <span className="absolute bottom-2 left-3 font-mono text-[9px] uppercase tracking-wider text-white/45">
                  Safe Zone
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Hook Stepper */}
      <div className="nb-well flex items-center justify-between gap-2 px-2 py-1.5">
        <button
          type="button"
          disabled={hooks.length <= 1}
          onClick={() =>
            onChangeHookIndex(
              (safeIndex - 1 + hooks.length) % Math.max(1, hooks.length)
            )
          }
          className="nb-key inline-flex h-7 w-8 items-center justify-center rounded-lg"
          aria-label="Previous hook"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>

        <div className="min-w-0 flex-1 text-center font-mono text-[11px] font-semibold text-[#C4C7D0]">
          {hooks.length > 0
            ? `${safeIndex + 1} / ${hooks.length}`
            : "0 / 0"}
        </div>

        <button
          type="button"
          disabled={hooks.length <= 1}
          onClick={() =>
            onChangeHookIndex((safeIndex + 1) % Math.max(1, hooks.length))
          }
          className="nb-key inline-flex h-7 w-8 items-center justify-center rounded-lg"
          aria-label="Next hook"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

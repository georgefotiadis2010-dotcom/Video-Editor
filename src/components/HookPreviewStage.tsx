"use client";

import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Film,
} from "lucide-react";
import { drawHookOnCanvas } from "@/lib/text-overlay";
import type {
  AspectMode,
  TextStyleConfig,
  VideoMetadata,
} from "@/types/renderer";

interface HookPreviewStageProps {
  video: VideoMetadata | null;
  hooks: string[];
  activeHookIndex: number;
  onChangeHookIndex: (nextIndex: number) => void;
  styleConfig: TextStyleConfig;
  aspectMode: AspectMode;
  muteAudio: boolean;
}

export function HookPreviewStage({
  video,
  hooks,
  activeHookIndex,
  onChangeHookIndex,
  styleConfig,
  aspectMode,
  muteAudio,
}: HookPreviewStageProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [showSafeZone, setShowSafeZone] = useState(true);

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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    let cancelled = false;
    const draw = () => {
      if (cancelled) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      drawHookOnCanvas(ctx, targetWidth, targetHeight, currentHook, styleConfig);
    };

    draw();
    if (document.fonts?.ready) {
      document.fonts.ready.then(draw);
    }

    return () => {
      cancelled = true;
    };
  }, [targetWidth, targetHeight, currentHook, styleConfig]);

  const aspectRatioCss = `${targetWidth} / ${targetHeight}`;

  return (
    <div className="nb-module flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-widest text-[#8B8F9C]">
          Preview
        </span>

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

      {/* Phone Stage */}
      <div className="flex justify-center">
        <div
          className="relative w-full max-w-[260px] overflow-hidden rounded-2xl border border-white/10 bg-black"
          style={{ aspectRatio: aspectRatioCss }}
        >
          {video ? (
            <video
              key={video.url}
              src={video.url}
              autoPlay
              loop
              muted={muteAudio}
              playsInline
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center">
              <Film className="h-5 w-5 text-[#555966]" />
              <p className="font-mono text-[11px] text-[#8B8F9C]">
                No video loaded
              </p>
            </div>
          )}

          {/* WYSIWYG Canvas Overlay */}
          <canvas
            ref={canvasRef}
            className="pointer-events-none absolute inset-0 h-full w-full"
          />

          {/* TikTok / Reels Safe Zone Guide */}
          {showSafeZone && (
            <div className="pointer-events-none absolute inset-0">
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

"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Crop, RotateCcw, Sparkles } from "lucide-react";
import {
  DEFAULT_VIDEO_CROP,
  DEFAULT_VIDEO_FILTER,
  isCropActive,
  isFilterActive,
  VIDEO_FILTER_PRESETS,
} from "@/lib/video-effects";
import type { VideoCropRect, VideoFilterConfig } from "@/types/renderer";

interface VideoEffectsPanelProps {
  videoFilter: VideoFilterConfig;
  onChangeFilter: (next: VideoFilterConfig) => void;
  videoCrop: VideoCropRect;
  onChangeCrop: (next: VideoCropRect) => void;
  disabled?: boolean;
}

export function VideoEffectsPanel({
  videoFilter,
  onChangeFilter,
  videoCrop,
  onChangeCrop,
  disabled = false,
}: VideoEffectsPanelProps) {
  const [showSliders, setShowSliders] = useState(false);
  const filterModified = isFilterActive(videoFilter);
  const cropModified = isCropActive(videoCrop);

  return (
    <div className="mt-4 border-t border-white/10 pt-3.5">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-[#FF4D2E]" />
          <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-[#9A9DA8]">
            Color Grade &amp; Filter
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {cropModified && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChangeCrop({ ...DEFAULT_VIDEO_CROP })}
              className="nb-key inline-flex items-center gap-1 rounded-lg px-2 py-0.5 font-mono text-[10px] font-semibold text-[#FF4D2E]"
              title="Reset corner crop"
            >
              <Crop className="h-2.5 w-2.5" />
              <span>
                Crop {Math.round(videoCrop.width * 100)}×
                {Math.round(videoCrop.height * 100)}% · Reset
              </span>
            </button>
          )}
          {filterModified && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChangeFilter({ ...DEFAULT_VIDEO_FILTER })}
              className="nb-key inline-flex items-center gap-1 rounded-lg px-2 py-0.5 font-mono text-[10px] font-semibold text-[#9A9DA8]"
            >
              <RotateCcw className="h-2.5 w-2.5" />
              <span>Reset</span>
            </button>
          )}
          <button
            type="button"
            disabled={disabled}
            onClick={() => setShowSliders((v) => !v)}
            className="nb-key inline-flex items-center gap-1 rounded-lg px-2 py-0.5 font-mono text-[10px] font-semibold text-[#C4C7D0]"
          >
            <span>Tune</span>
            {showSliders ? (
              <ChevronUp className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
          </button>
        </div>
      </div>

      {/* Preset Cards */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {VIDEO_FILTER_PRESETS.map((preset) => {
          const active = videoFilter.preset === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              disabled={disabled}
              onClick={() => onChangeFilter({ ...preset.config })}
              className={`nb-key flex flex-col items-start gap-1.5 rounded-xl p-2 text-left ${
                active ? "nb-key-active" : ""
              }`}
            >
              <div
                className="h-3.5 w-full rounded-md border border-white/15"
                style={{ background: preset.swatch }}
              />
              <div className="min-w-0 w-full">
                <p className="truncate text-[11px] font-bold leading-tight text-[#F5F5F2]">
                  {preset.label}
                </p>
                <p
                  className={`truncate font-mono text-[9px] uppercase tracking-wider ${
                    active ? "text-white/85" : "text-[#8B8F9C]"
                  }`}
                >
                  {preset.badge}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      {/* Fine-tune Color Sliders */}
      {showSliders && (
        <div className="nb-well mt-3 grid grid-cols-1 gap-3 rounded-xl p-3 sm:grid-cols-2">
          <div>
            <div className="mb-1 flex justify-between text-[11px]">
              <span className="font-mono text-[10px] uppercase tracking-wider text-[#9A9DA8]">
                Contrast
              </span>
              <span className="font-mono font-bold text-[#F5F5F2]">
                {Math.round(videoFilter.contrast * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={60}
              max={160}
              value={Math.round(videoFilter.contrast * 100)}
              disabled={disabled}
              onChange={(e) =>
                onChangeFilter({
                  ...videoFilter,
                  contrast: Number(e.target.value) / 100,
                })
              }
              style={
                {
                  "--attr-min": 60,
                  "--attr-max": 160,
                  "--control-value": Math.round(videoFilter.contrast * 100),
                } as React.CSSProperties
              }
              className="nb-slider"
            />
          </div>

          <div>
            <div className="mb-1 flex justify-between text-[11px]">
              <span className="font-mono text-[10px] uppercase tracking-wider text-[#9A9DA8]">
                Brightness
              </span>
              <span className="font-mono font-bold text-[#F5F5F2]">
                {videoFilter.brightness >= 0 ? "+" : ""}
                {Math.round(videoFilter.brightness * 100)}
              </span>
            </div>
            <input
              type="range"
              min={-30}
              max={30}
              value={Math.round(videoFilter.brightness * 100)}
              disabled={disabled}
              onChange={(e) =>
                onChangeFilter({
                  ...videoFilter,
                  brightness: Number(e.target.value) / 100,
                })
              }
              style={
                {
                  "--attr-min": -30,
                  "--attr-max": 30,
                  "--control-value": Math.round(videoFilter.brightness * 100),
                } as React.CSSProperties
              }
              className="nb-slider"
            />
          </div>

          <div>
            <div className="mb-1 flex justify-between text-[11px]">
              <span className="font-mono text-[10px] uppercase tracking-wider text-[#9A9DA8]">
                Saturation
              </span>
              <span className="font-mono font-bold text-[#F5F5F2]">
                {Math.round(videoFilter.saturation * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={200}
              value={Math.round(videoFilter.saturation * 100)}
              disabled={disabled}
              onChange={(e) =>
                onChangeFilter({
                  ...videoFilter,
                  saturation: Number(e.target.value) / 100,
                })
              }
              style={
                {
                  "--attr-min": 0,
                  "--attr-max": 200,
                  "--control-value": Math.round(videoFilter.saturation * 100),
                } as React.CSSProperties
              }
              className="nb-slider"
            />
          </div>

          <div>
            <div className="mb-1 flex justify-between text-[11px]">
              <span className="font-mono text-[10px] uppercase tracking-wider text-[#9A9DA8]">
                Cool / Warm Tint
              </span>
              <span className="font-mono font-bold text-[#F5F5F2]">
                {videoFilter.temperature > 0 ? "+" : ""}
                {Math.round(videoFilter.temperature * 100)}
              </span>
            </div>
            <input
              type="range"
              min={-100}
              max={100}
              value={Math.round(videoFilter.temperature * 100)}
              disabled={disabled}
              onChange={(e) =>
                onChangeFilter({
                  ...videoFilter,
                  temperature: Number(e.target.value) / 100,
                })
              }
              style={
                {
                  "--attr-min": -100,
                  "--attr-max": 100,
                  "--control-value": Math.round(videoFilter.temperature * 100),
                } as React.CSSProperties
              }
              className="nb-slider"
            />
          </div>

          <div>
            <div className="mb-1 flex justify-between text-[11px]">
              <span className="font-mono text-[10px] uppercase tracking-wider text-[#9A9DA8]">
                Matte Fade
              </span>
              <span className="font-mono font-bold text-[#F5F5F2]">
                {Math.round(videoFilter.fade * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={35}
              value={Math.round(videoFilter.fade * 100)}
              disabled={disabled}
              onChange={(e) =>
                onChangeFilter({
                  ...videoFilter,
                  fade: Number(e.target.value) / 100,
                })
              }
              style={
                {
                  "--attr-min": 0,
                  "--attr-max": 35,
                  "--control-value": Math.round(videoFilter.fade * 100),
                } as React.CSSProperties
              }
              className="nb-slider"
            />
          </div>

          <div>
            <div className="mb-1 flex justify-between text-[11px]">
              <span className="font-mono text-[10px] uppercase tracking-wider text-[#9A9DA8]">
                Vignette
              </span>
              <span className="font-mono font-bold text-[#F5F5F2]">
                {Math.round(videoFilter.vignette * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(videoFilter.vignette * 100)}
              disabled={disabled}
              onChange={(e) =>
                onChangeFilter({
                  ...videoFilter,
                  vignette: Number(e.target.value) / 100,
                })
              }
              style={
                {
                  "--attr-min": 0,
                  "--attr-max": 100,
                  "--control-value": Math.round(videoFilter.vignette * 100),
                } as React.CSSProperties
              }
              className="nb-slider"
            />
          </div>
        </div>
      )}
    </div>
  );
}

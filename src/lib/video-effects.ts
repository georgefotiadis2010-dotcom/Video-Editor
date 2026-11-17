import type {
  AspectMode,
  VideoCropRect,
  VideoFilterConfig,
  VideoFilterPresetId,
} from "@/types/renderer";

export const DEFAULT_VIDEO_CROP: VideoCropRect = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
};

export const DEFAULT_VIDEO_FILTER: VideoFilterConfig = {
  preset: "none",
  brightness: 0,
  contrast: 1,
  saturation: 1,
  temperature: 0,
  fade: 0,
  vignette: 0,
};

export interface VideoFilterPreset {
  id: VideoFilterPresetId;
  label: string;
  badge: string;
  swatch: string;
  config: VideoFilterConfig;
}

export const VIDEO_FILTER_PRESETS: VideoFilterPreset[] = [
  {
    id: "none",
    label: "Original",
    badge: "Raw",
    swatch: "linear-gradient(135deg, #323540 0%, #1b1d24 100%)",
    config: { ...DEFAULT_VIDEO_FILTER },
  },
  {
    id: "midnight-studio",
    label: "Midnight Studio",
    badge: "Moody Teal",
    swatch: "linear-gradient(135deg, #0b2230 0%, #163e4a 55%, #d4a72c 100%)",
    config: {
      preset: "midnight-studio",
      brightness: -0.04,
      contrast: 1.14,
      saturation: 0.92,
      temperature: -0.52,
      fade: 0.11,
      vignette: 0.38,
    },
  },
  {
    id: "warm-film",
    label: "Warm Film",
    badge: "35mm",
    swatch: "linear-gradient(135deg, #2b1d14 0%, #7d4c2a 60%, #e7b878 100%)",
    config: {
      preset: "warm-film",
      brightness: 0.02,
      contrast: 1.08,
      saturation: 1.06,
      temperature: 0.38,
      fade: 0.08,
      vignette: 0.25,
    },
  },
  {
    id: "crisp-pop",
    label: "Crisp Pop",
    badge: "HD",
    swatch: "linear-gradient(135deg, #1d263b 0%, #3a5a8c 55%, #ff6b4a 100%)",
    config: {
      preset: "crisp-pop",
      brightness: 0.03,
      contrast: 1.18,
      saturation: 1.22,
      temperature: 0.05,
      fade: 0,
      vignette: 0.12,
    },
  },
  {
    id: "bw-noir",
    label: "Noir Mono",
    badge: "B&W",
    swatch: "linear-gradient(135deg, #0a0a0c 0%, #4b4e58 60%, #e4e4e7 100%)",
    config: {
      preset: "bw-noir",
      brightness: -0.02,
      contrast: 1.24,
      saturation: 0,
      temperature: 0,
      fade: 0.07,
      vignette: 0.45,
    },
  },
];

export function isCropActive(crop?: VideoCropRect | null): boolean {
  if (!crop) return false;
  return (
    Math.abs(crop.x) > 0.004 ||
    Math.abs(crop.y) > 0.004 ||
    Math.abs(crop.width - 1) > 0.004 ||
    Math.abs(crop.height - 1) > 0.004
  );
}

export function isFilterActive(filter?: VideoFilterConfig | null): boolean {
  if (!filter) return false;
  return (
    Math.abs(filter.brightness) > 0.005 ||
    Math.abs(filter.contrast - 1) > 0.005 ||
    Math.abs(filter.saturation - 1) > 0.005 ||
    Math.abs(filter.temperature) > 0.005 ||
    filter.fade > 0.005 ||
    filter.vignette > 0.005
  );
}

/**
 * Fast GPU-accelerated CSS filter string for live <video> preview.
 * Temperature, matte fade, and vignette are paired with lightweight CSS overlay layers.
 */
export function buildPreviewCssFilter(filter?: VideoFilterConfig): string {
  if (!filter || !isFilterActive(filter)) return "none";
  const brightness = Math.max(0.4, 1 + filter.brightness);
  const contrast = Math.max(0.5, filter.contrast);
  const saturate = Math.max(0, filter.saturation);
  return `brightness(${brightness.toFixed(3)}) contrast(${contrast.toFixed(3)}) saturate(${saturate.toFixed(3)})`;
}

/**
 * Builds the FFmpeg `-vf` filter chain for crop + aspect scaling + color grading.
 */
export function buildFFmpegColorFilters(filter?: VideoFilterConfig): string[] {
  if (!filter || !isFilterActive(filter)) return [];
  const parts: string[] = [];

  if (
    Math.abs(filter.brightness) > 0.005 ||
    Math.abs(filter.contrast - 1) > 0.005 ||
    Math.abs(filter.saturation - 1) > 0.005
  ) {
    parts.push(
      `eq=brightness=${filter.brightness.toFixed(3)}:contrast=${filter.contrast.toFixed(3)}:saturation=${filter.saturation.toFixed(3)}`
    );
  }

  if (Math.abs(filter.temperature) > 0.005) {
    const t = Math.max(-1, Math.min(1, filter.temperature));
    if (t < 0) {
      // Cool teal/cyan shadows & midtones (Midnight Studio look)
      const amt = Math.abs(t);
      const rs = (-0.28 * amt).toFixed(3);
      const gs = (0.04 * amt).toFixed(3);
      const bs = (0.28 * amt).toFixed(3);
      const rm = (-0.12 * amt).toFixed(3);
      const gm = (0.03 * amt).toFixed(3);
      const bm = (0.14 * amt).toFixed(3);
      parts.push(
        `colorbalance=rs=${rs}:gs=${gs}:bs=${bs}:rm=${rm}:gm=${gm}:bm=${bm}`
      );
    } else {
      // Warm filmic highlights & midtones
      const amt = t;
      const rs = (0.18 * amt).toFixed(3);
      const bs = (-0.18 * amt).toFixed(3);
      const rm = (0.14 * amt).toFixed(3);
      const bm = (-0.12 * amt).toFixed(3);
      parts.push(`colorbalance=rs=${rs}:bs=${bs}:rm=${rm}:bm=${bm}`);
    }
  }

  if (filter.fade > 0.005) {
    const lift = Math.min(0.35, Math.max(0.01, filter.fade * 0.55)).toFixed(3);
    parts.push(`curves=all='0/${lift} 1/1'`);
  }

  if (filter.vignette > 0.005) {
    // PI/5 (~0.63) to PI/2.5 (~1.25) gives a clean edge vignette without crushing the center
    const angle = (0.25 + filter.vignette * 0.65).toFixed(3);
    parts.push(`vignette=angle=${angle}`);
  }

  return parts;
}

export function buildFFmpegCropFilter(crop?: VideoCropRect | null): string | null {
  if (!crop || !isCropActive(crop)) return null;
  const x = Math.max(0, Math.min(0.85, crop.x));
  const y = Math.max(0, Math.min(0.85, crop.y));
  const w = Math.max(0.15, Math.min(1 - x, crop.width));
  const h = Math.max(0.15, Math.min(1 - y, crop.height));
  return `crop=max(2\\,trunc(iw*${w.toFixed(4)}/2)*2):max(2\\,trunc(ih*${h.toFixed(4)}/2)*2):trunc(iw*${x.toFixed(4)}/2)*2:trunc(ih*${y.toFixed(4)}/2)*2`;
}

export function buildFFmpegVideoChain({
  aspectMode,
  targetWidth,
  targetHeight,
  crop,
  filter,
  fps,
}: {
  aspectMode: AspectMode;
  targetWidth?: number;
  targetHeight?: number;
  crop?: VideoCropRect | null;
  filter?: VideoFilterConfig | null;
  fps?: number;
}): string {
  const filters: string[] = [];

  const cropExpr = buildFFmpegCropFilter(crop);
  if (cropExpr) {
    filters.push(cropExpr);
  }

  if (aspectMode === "force-9x16") {
    const w = targetWidth ?? 1080;
    const h = targetHeight ?? 1920;
    filters.push(
      `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=fast_bilinear`,
      `crop=${w}:${h}`,
      "setsar=1"
    );
  } else if (targetWidth && targetHeight) {
    filters.push(
      `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease:flags=fast_bilinear`,
      `pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:black`,
      "setsar=1"
    );
  } else {
    filters.push(
      "scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=fast_bilinear",
      "setsar=1"
    );
  }

  filters.push(...buildFFmpegColorFilters(filter ?? undefined));

  if (fps) {
    filters.push(`fps=${fps}`);
  }

  return filters.join(",");
}

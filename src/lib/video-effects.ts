import type {
  AspectMode,
  EditStyleEffect,
  EditStyleId,
  EditStyleMotion,
  EditStylePreset,
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
  {
    id: "vhs-faded",
    label: "VHS Faded",
    badge: "90s Tape",
    swatch: "linear-gradient(135deg, #2a1f2d 0%, #6b4e57 55%, #d6b88d 100%)",
    config: {
      preset: "vhs-faded",
      brightness: 0.01,
      contrast: 0.94,
      saturation: 0.84,
      temperature: 0.28,
      fade: 0.22,
      vignette: 0.42,
    },
  },
  {
    id: "hyperpop-neon",
    label: "Hyperpop Neon",
    badge: "808",
    swatch: "linear-gradient(135deg, #1b0b3b 0%, #9d174d 55%, #22d3ee 100%)",
    config: {
      preset: "hyperpop-neon",
      brightness: 0.04,
      contrast: 1.32,
      saturation: 1.48,
      temperature: -0.22,
      fade: 0,
      vignette: 0.28,
    },
  },
  {
    id: "dreamy-pastel",
    label: "Dreamy Pastel",
    badge: "Bloom",
    swatch: "linear-gradient(135deg, #2c243b 0%, #7c6799 55%, #f3c6d8 100%)",
    config: {
      preset: "dreamy-pastel",
      brightness: 0.05,
      contrast: 0.92,
      saturation: 0.88,
      temperature: 0.16,
      fade: 0.16,
      vignette: 0.22,
    },
  },
];

export const EDIT_STYLE_PRESETS: EditStylePreset[] = [
  {
    id: "pov-vibe",
    label: "POV / Relatable Vibe",
    badge: "2–4s Bars",
    category: "hook",
    description:
      "Moody bar-synced cuts with subtle push-in and persistent top POV hook.",
    swatch: "linear-gradient(135deg, #0b2230 0%, #163e4a 55%, #d4a72c 100%)",
    pacing: "bar-boundary",
    motion: "slow-push",
    effect: "none",
    filterPreset: "midnight-studio",
    suggestedHook: "POV: driving home at 2am...",
    singleClipStrategy: "Alternating digital punch-ins (1.0x → 1.15x) on bar changes",
    multiClipStrategy: "Sequences 3–6 moody B-roll clips on bar boundaries",
  },
  {
    id: "kinetic-lyric",
    label: "Kinetic Lyric Edit",
    badge: "1–2 Beats",
    category: "lyric",
    description:
      "Dimmed backdrop for crisp center lyrics with kick-drum scale bounce.",
    swatch: "linear-gradient(135deg, #12131a 0%, #2a2d3d 55%, #ff4d2e 100%)",
    pacing: "every-2-beats",
    motion: "beat-pulse",
    effect: "dim-backdrop",
    filterPreset: "midnight-studio",
    suggestedHook: "When he says...",
    singleClipStrategy: "Continuous shot with beat-synced zoom pulses & pan shifts",
    multiClipStrategy: "Cuts B-roll every 2 beats behind kinetic lyric captions",
  },
  {
    id: "fast-montage",
    label: "Fast-Cut B-Roll Montage",
    badge: "Every Beat",
    category: "energy",
    description:
      "Rapid 0.25–0.75s transient-locked cuts with crisp pop grade & drop flashes.",
    swatch: "linear-gradient(135deg, #1d263b 0%, #3a5a8c 55%, #ff6b4a 100%)",
    pacing: "every-beat",
    motion: "whip-pan",
    effect: "flash-drop",
    filterPreset: "crisp-pop",
    suggestedHook: "Wait for the drop",
    singleClipStrategy: "Extracts 8–15 micro-slices with 1.1x–1.35x crops & speed ramps",
    multiClipStrategy: "Rapidly cycles all B-roll clips locked to snare/kick hits",
  },
  {
    id: "car-performance",
    label: "Car-Test / Studio Take",
    badge: "Dynamic Zoom",
    category: "performance",
    description:
      "Natural smartphone look with wide → medium → tight punch-ins on drops.",
    swatch: "linear-gradient(135deg, #1f242d 0%, #3d4452 55%, #e4e4e7 100%)",
    pacing: "bar-boundary",
    motion: "punch-zoom",
    effect: "none",
    filterPreset: "crisp-pop",
    suggestedHook: "Testing my unreleased track in the car",
    singleClipStrategy: "Keyframed wide (1.0x) → medium (1.2x) → tight (1.35x) crops",
    multiClipStrategy: "Cuts between performance angles on vocal phrase boundaries",
  },
  {
    id: "hyperpop-glitch",
    label: "Hyperpop / Trap Glitch",
    badge: "808 Flash",
    category: "energy",
    description:
      "Ultra-tight 808 cuts with RGB split, high contrast, and strobe flashes.",
    swatch: "linear-gradient(135deg, #1b0b3b 0%, #9d174d 55%, #22d3ee 100%)",
    pacing: "every-beat",
    motion: "punch-zoom",
    effect: "rgb-glitch",
    filterPreset: "hyperpop-neon",
    suggestedHook: "WAIT FOR IT",
    singleClipStrategy: "Rapid jump-cuts, 1.3x punch-ins, and RGB-split pulses on 808s",
    multiClipStrategy: "Rapid-fire clip switching with glitch transitions & flash frames",
  },
  {
    id: "vhs-lofi",
    label: "VHS / Camcorder Lo-Fi",
    badge: "90s Tape",
    category: "aesthetic",
    description:
      "Warm faded vintage grade with tape noise, lifted blacks, and gentle sway.",
    swatch: "linear-gradient(135deg, #2a1f2d 0%, #6b4e57 55%, #d6b88d 100%)",
    pacing: "balanced",
    motion: "handheld",
    effect: "vhs-tape",
    filterPreset: "vhs-faded",
    suggestedHook: "3AM voice memo",
    singleClipStrategy: "Continuous VHS treatment with occasional tape-skip jump cuts",
    multiClipStrategy: "Stitches clips with organic 1.5–3.5s analog tape cuts",
  },
  {
    id: "storytime-drop",
    label: "Storytime → Beat Drop",
    badge: "Two-Act",
    category: "hook",
    description:
      "Raw ungraded intro hook that snaps to punchy grade + cuts on the drop.",
    swatch: "linear-gradient(135deg, #2b1d14 0%, #7d4c2a 60%, #ff4d2e 100%)",
    pacing: "two-act",
    motion: "punch-zoom",
    effect: "flash-drop",
    filterPreset: "warm-film",
    suggestedHook: "I wrote this after...",
    singleClipStrategy: "Holds 1.0x framing in intro, snap-zooms to 1.2x on beat drop",
    multiClipStrategy: "Act 1 talking/intro clip → hard cut to B-roll montage on drop",
  },
  {
    id: "demo-vs-master",
    label: "Demo vs. Final Master",
    badge: "Before/After",
    category: "hook",
    description:
      "Stripped cool/desaturated demo act snapping into saturated master cuts.",
    swatch: "linear-gradient(135deg, #1f2937 0%, #4b5563 45%, #f59e0b 100%)",
    pacing: "two-act",
    motion: "beat-pulse",
    effect: "flash-drop",
    filterPreset: "crisp-pop",
    suggestedHook: "Voice memo at 2am → Final master",
    singleClipStrategy: "Act 1 wide desaturated shot → Act 2 punchy tight crop",
    multiClipStrategy: "Act 1 raw casual clip → Act 2 polished studio/B-roll cuts",
  },
  {
    id: "split-visualizer",
    label: "Split-Screen / Visualizer",
    badge: "Dual Pane",
    category: "performance",
    description:
      "Dual-pane framing with steady secondary cuts and beat-reactive energy.",
    swatch: "linear-gradient(135deg, #0f172a 0%, #334155 50%, #38bdf8 100%)",
    pacing: "balanced",
    motion: "beat-pulse",
    effect: "split-pane",
    filterPreset: "midnight-studio",
    suggestedHook: "First time hearing the final mix",
    singleClipStrategy: "Top tight subject crop + bottom wide/mirrored detail crop",
    multiClipStrategy: "Top performance/reaction pane + bottom rotating B-roll",
  },
  {
    id: "seamless-loop",
    label: "Seamless Infinite Loop",
    badge: "10–15s Loop",
    category: "aesthetic",
    description:
      "Cohesive continuous motion engineered to bridge tail cleanly back to head.",
    swatch: "linear-gradient(135deg, #1e1b4b 0%, #4338ca 55%, #a5b4fc 100%)",
    pacing: "balanced",
    motion: "slow-push",
    effect: "none",
    filterPreset: "warm-film",
    suggestedHook: "Wait until it loops...",
    singleClipStrategy: "Continuous 10–15s segment with smooth push-in & tail-to-head bridge",
    multiClipStrategy: "Matches exit motion of last clip to entry motion of first clip",
  },
  {
    id: "ghost-slowmo",
    label: "Ghost Lyric / Slow-Mo",
    badge: "Dreamy 0.6x",
    category: "lyric",
    description:
      "Dreamy slow-motion playback with soft halation bloom and pastel/noir grade.",
    swatch: "linear-gradient(135deg, #2c243b 0%, #7c6799 55%, #f3c6d8 100%)",
    pacing: "bar-boundary",
    motion: "slow-mo",
    effect: "halation-bloom",
    filterPreset: "dreamy-pastel",
    suggestedHook: "you still cross my mind...",
    singleClipStrategy: "Smooth 0.6x–0.75x slow-mo with gentle continuous drift",
    multiClipStrategy: "Long 3.5–6s slow-mo B-roll cuts with dreamy bloom",
  },
  {
    id: "raw-acoustic",
    label: "Raw Acoustic / Live",
    badge: "Single Take",
    category: "performance",
    description:
      "Zero heavy VFX; natural lighting with imperceptible 1.0→1.05x creep-in.",
    swatch: "linear-gradient(135deg, #26221e 0%, #574c41 55%, #d6cbbd 100%)",
    pacing: "single-take",
    motion: "slow-push",
    effect: "none",
    filterPreset: "none",
    suggestedHook: "No autotune, just a mic",
    singleClipStrategy: "Single continuous take with gentle 1.0→1.05x slow push-in",
    multiClipStrategy: "Uses 1–2 longest performance takes with minimal cuts",
  },
];

export function getEditStylePreset(id?: EditStyleId | null): EditStylePreset {
  return (
    EDIT_STYLE_PRESETS.find((style) => style.id === id) ?? EDIT_STYLE_PRESETS[0]
  );
}

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

export function buildFFmpegStyleEffectFilters(
  effect?: EditStyleEffect | null,
  motion?: EditStyleMotion | null
): string[] {
  const parts: string[] = [];

  if (effect === "vhs-tape") {
    // Subtle analog tape grain + soft focus
    parts.push("noise=alls=14:allf=t+u", "unsharp=5:5:-0.35:5:5:0.0");
  } else if (effect === "rgb-glitch") {
    // Crisp edge punch + subtle chroma shift for hyperpop/trap energy
    parts.push("chromashift=cbh=3:crh=-3", "unsharp=5:5:0.8:5:5:0.0");
  } else if (effect === "halation-bloom") {
    // Soft dreamy glow
    parts.push("gblur=sigma=0.6");
  } else if (effect === "dim-backdrop") {
    // Slight dim + vignette for high-contrast kinetic lyrics
    parts.push("eq=brightness=-0.08:contrast=1.08", "vignette=angle=0.75");
  } else if (effect === "flash-drop") {
    // Punchy micro-contrast for beat-drop montages
    parts.push("unsharp=5:5:0.5:5:5:0.0");
  }

  if (motion === "slow-mo") {
    parts.push("setpts=1.45*PTS");
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
  effect,
  motion,
  fps,
}: {
  aspectMode: AspectMode;
  targetWidth?: number;
  targetHeight?: number;
  crop?: VideoCropRect | null;
  filter?: VideoFilterConfig | null;
  effect?: EditStyleEffect | null;
  motion?: EditStyleMotion | null;
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
  filters.push(...buildFFmpegStyleEffectFilters(effect, motion));

  if (fps) {
    filters.push(`fps=${fps}`);
  }

  return filters.join(",");
}

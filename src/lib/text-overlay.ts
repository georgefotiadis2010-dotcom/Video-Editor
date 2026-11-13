import type { FontFamilyOption, TextPreset, TextStyleConfig } from "@/types/renderer";

export const DEFAULT_TEXT_STYLE: TextStyleConfig = {
  fontFamily: "inter",
  fontSize: 58,
  yPositionPercent: 24,
  maxWidthPercent: 84,
  textColor: "#FFFFFF",
  pillStyle: "black",
  pillOpacity: 0.84,
  uppercase: false,
  lineHeight: 1.24,
};

export const TEXT_PRESETS: TextPreset[] = [
  {
    id: "tiktok-classic",
    label: "TikTok Classic",
    badge: "Pill",
    config: {
      fontFamily: "inter",
      fontSize: 58,
      textColor: "#FFFFFF",
      pillStyle: "black",
      pillOpacity: 0.85,
      uppercase: false,
    },
  },
  {
    id: "lxg-crimson",
    label: "LXG Crimson",
    badge: "Brand",
    config: {
      fontFamily: "inter",
      fontSize: 60,
      textColor: "#FFFFFF",
      pillStyle: "crimson",
      pillOpacity: 0.94,
      uppercase: true,
    },
  },
  {
    id: "marker-drop",
    label: "LXG Marker",
    badge: "Street",
    config: {
      fontFamily: "marker",
      fontSize: 64,
      textColor: "#FFFFFF",
      pillStyle: "outline",
      pillOpacity: 0.9,
      uppercase: false,
    },
  },
  {
    id: "clean-white",
    label: "Clean White",
    badge: "Light",
    config: {
      fontFamily: "inter",
      fontSize: 56,
      textColor: "#000000",
      pillStyle: "white",
      pillOpacity: 0.95,
      uppercase: false,
    },
  },
];

export const SAMPLE_HOOKS_20 = [
  "POV: you finally found an independent duo that produces everything themselves",
  "Wait for the beat drop at 0:04...",
  "If you like late-night drives through Melbourne, this one is for you",
  "We recorded this chorus in our bedroom at 2am",
  "Name a better twin-brother hook. We'll wait.",
  "Stop scrolling if you miss when pop-rap actually had energy",
  "Nobody talks about how hard it is to mix your own vocals until...",
  "Send this to the friend who always steals the aux cord",
  "Our label told us not to drop this. So we dropped it anyway.",
  "3 seconds into this track and you'll know if it's on your playlist",
  "When the 808 hits right as the streetlights turn on",
  "Rating our unreleased demo from 1 to 10 (be brutal)",
  "This bridge took 47 takes to get right",
  "You weren't supposed to hear this track until Friday",
  "Tell me what city you're listening from in the comments",
  "Why does this sound like summer 2016 and 2026 at the same time?",
  "The exact moment the whole studio went silent",
  "If this hits 1,000 saves we're dropping the full visual tonight",
  "How two brothers in Melbourne turned a laptop into a full studio",
  "Save this sound before it blows up on your FYP",
];

export function resolveCanvasFont(
  option: FontFamilyOption,
  fontSizePx: number
): string {
  switch (option) {
    case "marker":
      return `400 ${fontSizePx}px "Permanent Marker", cursive, sans-serif`;
    case "impact":
      return `900 ${fontSizePx}px Impact, "Arial Black", "Inter", sans-serif`;
    case "inter":
    default:
      return `800 ${fontSizePx}px "Inter", system-ui, -apple-system, sans-serif`;
  }
}

function wrapTextLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const paragraphs = text.split(/\r?\n/);
  const lines: string[] = [];

  for (const para of paragraphs) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    let current = words[0];
    for (let i = 1; i < words.length; i++) {
      const candidate = `${current} ${words[i]}`;
      if (ctx.measureText(candidate).width <= maxWidth) {
        current = candidate;
      } else {
        lines.push(current);
        current = words[i];
      }
    }
    lines.push(current);
  }

  return lines;
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

export function drawHookOnCanvas(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  rawText: string,
  style: TextStyleConfig
) {
  ctx.clearRect(0, 0, width, height);

  const trimmed = rawText.trim();
  if (!trimmed) return;

  const text = style.uppercase ? trimmed.toUpperCase() : trimmed;
  const scaleFactor = width / 1080;
  const fontSizePx = Math.max(16, Math.round(style.fontSize * scaleFactor));
  const lineHeightPx = Math.round(fontSizePx * style.lineHeight);
  const maxWidth = width * (style.maxWidthPercent / 100);

  ctx.font = resolveCanvasFont(style.fontFamily, fontSizePx);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const lines = wrapTextLines(ctx, text, maxWidth);
  if (lines.length === 0) return;

  const totalHeight = lines.length * lineHeightPx;
  const centerY = (height * style.yPositionPercent) / 100;
  const startY = centerY - totalHeight / 2 + lineHeightPx / 2;

  const padX = Math.round(fontSizePx * 0.42);
  const padY = Math.round(fontSizePx * 0.22);
  const radius = Math.round(fontSizePx * 0.28);

  lines.forEach((line, idx) => {
    const lineY = startY + idx * lineHeightPx;
    const metrics = ctx.measureText(line);
    const boxWidth = metrics.width + padX * 2;
    const boxHeight = lineHeightPx + padY * 0.5;
    const boxX = width / 2 - boxWidth / 2;
    const boxY = lineY - boxHeight / 2;

    if (style.pillStyle !== "outline") {
      ctx.save();
      if (style.pillStyle === "crimson") {
        ctx.fillStyle = `rgba(225, 29, 72, ${style.pillOpacity})`;
      } else if (style.pillStyle === "white") {
        ctx.fillStyle = `rgba(255, 255, 255, ${style.pillOpacity})`;
      } else {
        ctx.fillStyle = `rgba(0, 0, 0, ${style.pillOpacity})`;
      }
      ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
      ctx.shadowBlur = Math.round(16 * scaleFactor);
      ctx.shadowOffsetY = Math.round(4 * scaleFactor);
      drawRoundedRect(ctx, boxX, boxY, boxWidth, boxHeight, radius);
      ctx.fill();
      ctx.restore();
    } else {
      ctx.save();
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.92)";
      ctx.lineWidth = Math.max(3, Math.round(fontSizePx * 0.16));
      ctx.shadowColor = "rgba(0, 0, 0, 0.75)";
      ctx.shadowBlur = Math.round(12 * scaleFactor);
      ctx.shadowOffsetY = Math.round(3 * scaleFactor);
      ctx.strokeText(line, width / 2, lineY);
      ctx.restore();
    }

    ctx.save();
    ctx.fillStyle = style.textColor;
    ctx.fillText(line, width / 2, lineY);
    ctx.restore();
  });
}

export async function renderHookOverlayPng(
  width: number,
  height: number,
  hookText: string,
  style: TextStyleConfig
): Promise<Uint8Array> {
  if (typeof document !== "undefined" && document.fonts?.ready) {
    await document.fonts.ready;
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not acquire 2D canvas context for text overlay.");
  }

  drawHookOnCanvas(ctx, width, height, hookText, style);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error("Failed to encode hook overlay PNG."));
    }, "image/png");
  });

  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}

export function slugifyHook(text: string, index: number): string {
  const num = String(index + 1).padStart(2, "0");
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `${num}-${slug || "hook"}.mp4`;
}

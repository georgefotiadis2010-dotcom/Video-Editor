import type {
  BeatCutSegment,
  EditStylePreset,
  SourceClipItem,
} from "@/types/renderer";

export interface BeatCutPlanOptions {
  editStyle?: EditStylePreset | null;
  drops?: number[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildBeatCutPlan(
  cutTimestamps: number[],
  windowStart: number,
  windowEnd: number,
  clips: SourceClipItem[],
  shuffleSeed?: number,
  options?: BeatCutPlanOptions
): BeatCutSegment[] {
  if (clips.length === 0 || windowEnd <= windowStart + 0.25) {
    return [];
  }

  // Build sorted boundary points inside [windowStart, windowEnd]
  const points = [windowStart];
  const sortedCuts = [...cutTimestamps]
    .filter((t) => t > windowStart + 0.22 && t < windowEnd - 0.22)
    .sort((a, b) => a - b);

  for (const t of sortedCuts) {
    if (t - points[points.length - 1] >= 0.22) {
      points.push(t);
    }
  }

  if (windowEnd - points[points.length - 1] < 0.22 && points.length > 1) {
    points[points.length - 1] = windowEnd;
  } else {
    points.push(windowEnd);
  }

  const rng = shuffleSeed !== undefined ? mulberry32(shuffleSeed) : null;

  // Track how far into each clip we've sampled so repeated clips show fresh moments
  const clipUseCount = new Map<string, number>();
  const segments: BeatCutSegment[] = [];

  // Build a base order of clip indices
  let order = clips.map((_, idx) => idx);
  if (rng) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  }

  let prevClipId: string | null = null;
  let cursor = 0;

  for (let i = 0; i < points.length - 1; i++) {
    const startTime = points[i];
    const endTime = points[i + 1];
    const duration = Number((endTime - startTime).toFixed(3));
    if (duration < 0.2) continue;

    // Pick next clip, avoiding back-to-back repeats when multiple clips exist
    let clipIdx = order[cursor % order.length];
    if (clips.length > 1 && clips[clipIdx].id === prevClipId) {
      cursor++;
      clipIdx = order[cursor % order.length];
    }
    cursor++;

    // Re-shuffle order after each full pass through all clips when in shuffle mode
    if (rng && cursor % order.length === 0 && clips.length > 2) {
      order = [...order];
      for (let k = order.length - 1; k > 0; k--) {
        const j = Math.floor(rng() * (k + 1));
        [order[k], order[j]] = [order[j], order[k]];
      }
    }

    const clip = clips[clipIdx];
    prevClipId = clip.id;

    const uses = clipUseCount.get(clip.id) ?? 0;
    clipUseCount.set(clip.id, uses + 1);

    // Choose a smart sourceStart inside the raw clip
    let sourceStart = 0;
    const isSingleClip = clips.length === 1;
    const style = options?.editStyle ?? null;
    const isChronological =
      isSingleClip &&
      (style?.pacing === "single-take" ||
        style?.pacing === "two-act" ||
        style?.id === "car-performance" ||
        style?.id === "raw-acoustic");

    const usableSpan = Math.max(0, clip.duration - duration - 0.15);
    if (usableSpan > 0.3) {
      if (isChronological) {
        // Walk forward chronologically through the single take
        const progress = points.length > 2 ? i / (points.length - 2) : 0;
        sourceStart = Number((0.1 + progress * usableSpan).toFixed(2));
      } else if (rng) {
        sourceStart = Number((0.1 + rng() * usableSpan).toFixed(2));
      } else {
        // Evenly step through the raw video on repeated uses
        const stepOffset = ((uses * 0.37) % 1) * usableSpan;
        sourceStart = Number((0.1 + stepOffset).toFixed(2));
      }
    }

    // Compute per-segment motion & effect based on editStyle and single-clip vs multi-clip
    let zoom = 1;
    let panX = 0;
    let panY = 0;
    let speed = 1;
    let effect = style?.effect ?? "none";
    let transitionFlash = false;

    const totalSegs = Math.max(1, points.length - 1);
    const isDrop =
      options?.drops?.some((d) => Math.abs(d - startTime) < 0.25) ?? false;
    const isActOne =
      style?.pacing === "two-act" && i < Math.max(1, Math.floor(totalSegs * 0.3));

    if (style) {
      if (isActOne) {
        // Act 1 of storytime-drop / demo-vs-master: raw wide framing, no heavy VFX
        zoom = 1;
        effect = "none";
      } else {
        if (style.pacing === "two-act" && i === Math.max(1, Math.floor(totalSegs * 0.3))) {
          transitionFlash = true;
        }

        switch (style.motion) {
          case "punch-zoom": {
            const zoomCycle = isSingleClip ? [1.0, 1.22, 1.12, 1.32] : [1.0, 1.14, 1.06];
            zoom = zoomCycle[i % zoomCycle.length];
            if (isSingleClip && zoom > 1.05) {
              panX = i % 2 === 0 ? 0.25 : -0.25;
              panY = i % 3 === 0 ? -0.15 : 0.1;
            }
            break;
          }
          case "slow-push": {
            const step = (i % 4) * 0.03;
            zoom = Number((1.02 + step).toFixed(2));
            break;
          }
          case "beat-pulse": {
            zoom = i % 2 === 0 ? 1.0 : isSingleClip ? 1.16 : 1.08;
            break;
          }
          case "whip-pan": {
            zoom = 1.14;
            panX = i % 2 === 0 ? -0.45 : 0.45;
            break;
          }
          case "handheld": {
            zoom = isSingleClip ? 1.1 : 1.05;
            panX = ((i % 3) - 1) * 0.2;
            panY = (((i + 1) % 3) - 1) * 0.15;
            break;
          }
          case "slow-mo": {
            speed = 0.65;
            zoom = isSingleClip ? 1.06 + (i % 2) * 0.06 : 1.03;
            break;
          }
          default:
            if (isSingleClip) {
              // Subtle virtual cut reframing even when motion is "none"
              zoom = i % 2 === 0 ? 1.0 : 1.12;
            }
            break;
        }

        if (isDrop || (style.effect === "flash-drop" && i > 0 && i % 4 === 0)) {
          transitionFlash = true;
        }
      }
    } else if (isSingleClip) {
      // Default single-clip virtual cut: subtle alternating punch-in so 1 clip feels dynamic
      zoom = i % 2 === 0 ? 1.0 : 1.12;
      panX = i % 2 === 0 ? 0 : (i % 4 === 1 ? 0.2 : -0.2);
    }

    segments.push({
      index: segments.length,
      startTime,
      endTime,
      duration,
      clipId: clip.id,
      clipName: clip.file.name,
      sourceStart,
      zoom,
      panX,
      panY,
      speed,
      effect,
      transitionFlash,
    });
  }

  return segments;
}

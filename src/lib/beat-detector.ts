import type { AudioAnalysis, BeatDensity } from "@/types/renderer";

const FRAME_DURATION_SEC = 0.02; // 20ms hop (~50 fps energy envelope)
const WAVEFORM_BUCKETS = 300;
const MIN_BPM = 70;
const MAX_BPM = 175;

function mixToMono(buffer: AudioBuffer): Float32Array {
  const { numberOfChannels, length } = buffer;
  if (numberOfChannels === 1) {
    return buffer.getChannelData(0);
  }
  const mono = new Float32Array(length);
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const channelData = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += channelData[i];
    }
  }
  const inv = 1 / numberOfChannels;
  for (let i = 0; i < length; i++) {
    mono[i] *= inv;
  }
  return mono;
}

function computeWaveformPeaks(
  samples: Float32Array,
  buckets: number
): number[] {
  const total = samples.length;
  if (total === 0) return new Array(buckets).fill(0.1);

  const step = Math.max(1, Math.floor(total / buckets));
  const peaks: number[] = [];
  let maxPeak = 0.0001;

  for (let b = 0; b < buckets; b++) {
    const start = b * step;
    const end = Math.min(total, start + step);
    let peak = 0;
    // Stride inside bucket for speed on long tracks
    const innerStride = Math.max(1, Math.floor((end - start) / 128));
    for (let i = start; i < end; i += innerStride) {
      const abs = Math.abs(samples[i]);
      if (abs > peak) peak = abs;
    }
    peaks.push(peak);
    if (peak > maxPeak) maxPeak = peak;
  }

  return peaks.map((p) => Math.max(0.05, Math.min(1, p / maxPeak)));
}

async function extractBassSamples(decoded: AudioBuffer): Promise<Float32Array> {
  try {
    const offline = new OfflineAudioContext(
      1,
      decoded.length,
      decoded.sampleRate
    );
    const source = offline.createBufferSource();
    source.buffer = decoded;

    const filter = offline.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 165;
    filter.Q.value = 0.7;

    source.connect(filter);
    filter.connect(offline.destination);
    source.start(0);

    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
  } catch {
    return mixToMono(decoded);
  }
}

function computeEnergyEnvelope(
  samples: Float32Array,
  sampleRate: number
): Float32Array {
  const hopSamples = Math.max(1, Math.floor(sampleRate * FRAME_DURATION_SEC));
  const frameCount = Math.floor(samples.length / hopSamples);
  const env = new Float32Array(frameCount);

  for (let f = 0; f < frameCount; f++) {
    const start = f * hopSamples;
    const end = start + hopSamples;
    let sumSq = 0;
    for (let i = start; i < end; i++) {
      const s = samples[i];
      sumSq += s * s;
    }
    env[f] = Math.sqrt(sumSq / hopSamples);
  }

  return env;
}

function computeOnsetFlux(energy: Float32Array): Float32Array {
  const flux = new Float32Array(energy.length);
  for (let i = 1; i < energy.length; i++) {
    const diff = energy[i] - energy[i - 1];
    flux[i] = diff > 0 ? diff : 0;
  }
  return flux;
}

function estimateBpm(flux: Float32Array): number {
  const minLag = Math.round(60 / (MAX_BPM * FRAME_DURATION_SEC));
  const maxLag = Math.round(60 / (MIN_BPM * FRAME_DURATION_SEC));
  const n = flux.length;

  let bestLag = Math.round(60 / (120 * FRAME_DURATION_SEC));
  let bestScore = -1;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    const limit = n - lag;
    for (let i = 0; i < limit; i++) {
      sum += flux[i] * flux[i + lag];
    }
    // Slight preference for mid-tempo 100-140 BPM to avoid half/double-time errors
    const bpmCandidate = 60 / (lag * FRAME_DURATION_SEC);
    const tempoPrior =
      bpmCandidate >= 95 && bpmCandidate <= 145 ? 1.12 : 1.0;
    const score = (sum / Math.max(1, limit)) * tempoPrior;

    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  const rawBpm = 60 / (bestLag * FRAME_DURATION_SEC);
  return Math.round(rawBpm);
}

function detectBeatGrid(
  flux: Float32Array,
  energy: Float32Array,
  bpm: number,
  duration: number
): number[] {
  const beatPeriod = 60 / Math.max(MIN_BPM, Math.min(MAX_BPM, bpm));
  const periodFrames = beatPeriod / FRAME_DURATION_SEC;

  // Find best phase offset within the first beat period
  const phaseSteps = Math.max(1, Math.round(periodFrames));
  let bestPhase = 0;
  let bestPhaseScore = -1;

  for (let p = 0; p < phaseSteps; p++) {
    let score = 0;
    for (let k = 0; ; k++) {
      const idx = Math.round(p + k * periodFrames);
      if (idx >= flux.length) break;
      const localMax = Math.max(
        flux[idx],
        flux[Math.max(0, idx - 1)],
        flux[Math.min(flux.length - 1, idx + 1)]
      );
      score += localMax;
    }
    if (score > bestPhaseScore) {
      bestPhaseScore = score;
      bestPhase = p;
    }
  }

  // Generate beats and snap slightly (+/- 40ms) to strongest nearby onset
  const beats: number[] = [];
  const snapRadius = 2; // +/- 40ms
  for (let k = 0; ; k++) {
    const centerIdx = Math.round(bestPhase + k * periodFrames);
    if (centerIdx >= energy.length) break;

    let bestIdx = centerIdx;
    let bestVal = flux[centerIdx];
    for (let offset = -snapRadius; offset <= snapRadius; offset++) {
      const cand = centerIdx + offset;
      if (cand >= 0 && cand < flux.length && flux[cand] > bestVal) {
        bestVal = flux[cand];
        bestIdx = cand;
      }
    }

    const time = Number((bestIdx * FRAME_DURATION_SEC).toFixed(3));
    if (time > 0.05 && time < duration - 0.05) {
      if (beats.length === 0 || time - beats[beats.length - 1] >= 0.22) {
        beats.push(time);
      }
    }
  }

  return beats;
}

function detectDrops(
  fullEnergy: Float32Array,
  bassEnergy: Float32Array,
  beats: number[],
  duration: number
): number[] {
  const drops: number[] = [];
  if (beats.length === 0) return drops;

  // Score each beat by energy surge compared to preceding 2 seconds
  const lookbackFrames = Math.round(2.0 / FRAME_DURATION_SEC);
  const lookaheadFrames = Math.round(1.2 / FRAME_DURATION_SEC);

  const scoredBeats = beats.map((beatTime) => {
    const frame = Math.min(
      fullEnergy.length - 1,
      Math.max(0, Math.round(beatTime / FRAME_DURATION_SEC))
    );

    let preSum = 0;
    let preCount = 0;
    for (let i = Math.max(0, frame - lookbackFrames); i < frame; i++) {
      preSum += fullEnergy[i] * 0.6 + bassEnergy[i] * 0.4;
      preCount++;
    }
    const preAvg = preCount > 0 ? preSum / preCount : 0;

    let postSum = 0;
    let postCount = 0;
    for (
      let i = frame;
      i < Math.min(fullEnergy.length, frame + lookaheadFrames);
      i++
    ) {
      postSum += fullEnergy[i] * 0.5 + bassEnergy[i] * 0.5;
      postCount++;
    }
    const postAvg = postCount > 0 ? postSum / postCount : 0;

    const contrast = postAvg - preAvg * 0.85;
    const score = contrast * 1.4 + postAvg * 0.6;
    return { beatTime, score };
  });

  scoredBeats.sort((a, b) => b.score - a.score);

  // Pick top distinct drops separated by at least 4 seconds
  for (const item of scoredBeats) {
    if (item.beatTime < 0.8 || item.beatTime > duration - 1.5) continue;
    const tooClose = drops.some((d) => Math.abs(d - item.beatTime) < 4.0);
    if (!tooClose) {
      drops.push(item.beatTime);
      if (drops.length >= 6) break;
    }
  }

  drops.sort((a, b) => a - b);
  return drops;
}

function pickRecommendedWindow(
  fullEnergy: Float32Array,
  drops: number[],
  duration: number
): { start: number; end: number } {
  const targetLen = Math.min(14, Math.max(6, duration * 0.85));
  if (duration <= targetLen + 0.5) {
    return { start: 0, end: Number(duration.toFixed(2)) };
  }

  // If we found a strong drop, start ~2.5s before it for buildup -> drop impact
  if (drops.length > 0) {
    // Score each drop window by total energy after the drop
    let bestStart = 0;
    let bestScore = -1;

    for (const drop of drops) {
      const start = Math.max(0, Math.min(duration - targetLen, drop - 2.5));
      const end = Math.min(duration, start + targetLen);
      const startFrame = Math.floor(start / FRAME_DURATION_SEC);
      const endFrame = Math.min(
        fullEnergy.length,
        Math.floor(end / FRAME_DURATION_SEC)
      );
      let energySum = 0;
      for (let i = startFrame; i < endFrame; i++) {
        energySum += fullEnergy[i];
      }
      if (energySum > bestScore) {
        bestScore = energySum;
        bestStart = start;
      }
    }

    return {
      start: Number(bestStart.toFixed(2)),
      end: Number(Math.min(duration, bestStart + targetLen).toFixed(2)),
    };
  }

  // Fallback: highest-energy window
  const windowFrames = Math.floor(targetLen / FRAME_DURATION_SEC);
  let running = 0;
  for (let i = 0; i < Math.min(windowFrames, fullEnergy.length); i++) {
    running += fullEnergy[i];
  }
  let maxSum = running;
  let maxStartFrame = 0;
  for (let i = windowFrames; i < fullEnergy.length; i++) {
    running += fullEnergy[i] - fullEnergy[i - windowFrames];
    if (running > maxSum) {
      maxSum = running;
      maxStartFrame = i - windowFrames + 1;
    }
  }

  const start = Number((maxStartFrame * FRAME_DURATION_SEC).toFixed(2));
  const end = Number(Math.min(duration, start + targetLen).toFixed(2));
  return { start, end };
}

export async function analyzeAudioFile(file: File): Promise<AudioAnalysis> {
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;

  if (!AudioCtx) {
    throw new Error("Web Audio API is not supported in this browser.");
  }

  const arrayBuffer = await file.arrayBuffer();
  const ctx = new AudioCtx();

  try {
    const decoded = await ctx.decodeAudioData(arrayBuffer);
    const duration = decoded.duration;

    const mono = mixToMono(decoded);
    const waveformPeaks = computeWaveformPeaks(mono, WAVEFORM_BUCKETS);
    const fullEnergy = computeEnergyEnvelope(mono, decoded.sampleRate);

    const bassSamples = await extractBassSamples(decoded);
    const bassEnergy = computeEnergyEnvelope(bassSamples, decoded.sampleRate);
    const bassFlux = computeOnsetFlux(bassEnergy);

    const bpm = estimateBpm(bassFlux);
    const beats = detectBeatGrid(bassFlux, bassEnergy, bpm, duration);
    const drops = detectDrops(fullEnergy, bassEnergy, beats, duration);
    const recommended = pickRecommendedWindow(fullEnergy, drops, duration);

    const url = URL.createObjectURL(file);

    return {
      file,
      url,
      duration,
      bpm,
      waveformPeaks,
      beats,
      drops,
      recommendedStart: recommended.start,
      recommendedEnd: recommended.end,
    };
  } finally {
    await ctx.close().catch(() => {});
  }
}

export function selectCutsInWindow(
  beats: number[],
  drops: number[],
  windowStart: number,
  windowEnd: number,
  density: BeatDensity
): number[] {
  const inWindow = beats.filter(
    (b) => b > windowStart + 0.25 && b < windowEnd - 0.25
  );

  if (density === "every-beat") {
    return inWindow;
  }

  if (density === "every-2-beats") {
    return inWindow.filter((_, idx) => idx % 2 === 0);
  }

  // "balanced": keep drops + every 2nd beat around them, tightening near drops
  const selected: number[] = [];
  for (let i = 0; i < inWindow.length; i++) {
    const b = inWindow[i];
    const nearDrop = drops.some((d) => Math.abs(d - b) < 0.25);
    const afterDropBurst = drops.some((d) => b >= d && b <= d + 3.5);
    if (nearDrop || afterDropBurst || i % 2 === 0) {
      if (selected.length === 0 || b - selected[selected.length - 1] >= 0.35) {
        selected.push(b);
      }
    }
  }
  return selected;
}

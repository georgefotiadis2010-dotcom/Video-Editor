"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Flame,
  Pause,
  Play,
  RotateCcw,
  Scissors,
} from "lucide-react";
import type { AudioAnalysis, BeatDensity } from "@/types/renderer";

interface WaveformBeatEditorProps {
  analysis: AudioAnalysis;
  windowStart: number;
  windowEnd: number;
  onChangeWindow: (start: number, end: number) => void;
  activeCuts: number[];
  onToggleCustomCut: (time: number) => void;
  beatDensity: BeatDensity;
  onChangeDensity: (density: BeatDensity) => void;
  onResetAutoBeats: () => void;
  hasCustomBeats: boolean;
}

type DragMode = "none" | "start" | "end" | "move";

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00.0";
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  const whole = Math.floor(rem);
  const tenths = Math.floor((rem - whole) * 10);
  return `${mins}:${String(whole).padStart(2, "0")}.${tenths}`;
}

export function WaveformBeatEditor({
  analysis,
  windowStart,
  windowEnd,
  onChangeWindow,
  activeCuts,
  onToggleCustomCut,
  beatDensity,
  onChangeDensity,
  onResetAutoBeats,
  hasCustomBeats,
}: WaveformBeatEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const dragRef = useRef<{
    mode: DragMode;
    startX: number;
    origStart: number;
    origEnd: number;
    moved: boolean;
  }>({
    mode: "none",
    startX: 0,
    origStart: 0,
    origEnd: 0,
    moved: false,
  });

  const [isPlaying, setIsPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(windowStart);
  const [editBeatsMode, setEditBeatsMode] = useState(false);

  // Sync audio element
  useEffect(() => {
    const audio = new Audio(analysis.url);
    audio.preload = "auto";
    audioRef.current = audio;

    const handleEnded = () => {
      setIsPlaying(false);
    };
    audio.addEventListener("ended", handleEnded);

    return () => {
      audio.pause();
      audio.removeEventListener("ended", handleEnded);
      audioRef.current = null;
    };
  }, [analysis.url]);

  // Animation loop for playhead while playing
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;

    const tick = () => {
      const audio = audioRef.current;
      if (audio) {
        const t = audio.currentTime;
        setPlayhead(t);
        if (t >= windowEnd) {
          audio.currentTime = windowStart;
          setPlayhead(windowStart);
        }
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, windowStart, windowEnd]);

  const togglePlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      if (audio.currentTime < windowStart || audio.currentTime >= windowEnd) {
        audio.currentTime = windowStart;
        setPlayhead(windowStart);
      }
      audio.play().catch(() => {});
      setIsPlaying(true);
    }
  }, [isPlaying, windowStart, windowEnd]);

  const seekTo = useCallback((time: number) => {
    const clamped = Math.max(0, Math.min(analysis.duration, time));
    setPlayhead(clamped);
    if (audioRef.current) {
      audioRef.current.currentTime = clamped;
    }
  }, [analysis.duration]);

  // Draw waveform canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(300, Math.floor(rect.width));
    const height = Math.max(100, Math.floor(rect.height));

    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const dur = Math.max(0.1, analysis.duration);
    const timeToX = (t: number) => (t / dur) * width;

    const winX1 = timeToX(windowStart);
    const winX2 = timeToX(windowEnd);

    // Highlighted window background
    ctx.fillStyle = "rgba(255, 77, 46, 0.12)";
    ctx.fillRect(winX1, 0, Math.max(2, winX2 - winX1), height);

    // Waveform bars
    const peaks = analysis.waveformPeaks;
    const barW = width / peaks.length;
    const midY = height / 2;
    const maxBarH = height * 0.72;

    for (let i = 0; i < peaks.length; i++) {
      const x = i * barW;
      const barTime = (i / peaks.length) * dur;
      const inWindow = barTime >= windowStart && barTime <= windowEnd;
      const h = Math.max(3, peaks[i] * maxBarH);

      ctx.fillStyle = inWindow ? "#F5F5F2" : "rgba(154, 157, 168, 0.25)";
      ctx.fillRect(x, midY - h / 2, Math.max(1.5, barW - 1), h);
    }

    // Drop markers (across whole song)
    for (const drop of analysis.drops) {
      const dx = timeToX(drop);
      ctx.strokeStyle = "rgba(255, 77, 46, 0.68)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(dx, 14);
      ctx.lineTo(dx, height);
      ctx.stroke();
      ctx.setLineDash([]);

      // Small diamond at top
      ctx.fillStyle = "#FF4D2E";
      ctx.beginPath();
      ctx.moveTo(dx, 2);
      ctx.lineTo(dx + 5, 7);
      ctx.lineTo(dx, 12);
      ctx.lineTo(dx - 5, 7);
      ctx.closePath();
      ctx.fill();
    }

    // Active beat cut markers inside window
    for (const cut of activeCuts) {
      const cx = timeToX(cut);
      ctx.strokeStyle = "rgba(255, 176, 32, 0.9)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, 10);
      ctx.lineTo(cx, height - 4);
      ctx.stroke();

      ctx.fillStyle = "#FFB020";
      ctx.beginPath();
      ctx.arc(cx, height - 6, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Window boundary handles
    ctx.strokeStyle = "#FF4D2E";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(winX1, 0);
    ctx.lineTo(winX1, height);
    ctx.moveTo(winX2, 0);
    ctx.lineTo(winX2, height);
    ctx.stroke();

    // Handle grips
    ctx.fillStyle = "#FF4D2E";
    ctx.fillRect(winX1 - 4, height / 2 - 14, 8, 28);
    ctx.fillRect(winX2 - 4, height / 2 - 14, 8, 28);

    // Playhead
    const px = timeToX(playhead);
    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, height);
    ctx.stroke();

    ctx.restore();
  }, [analysis, windowStart, windowEnd, activeCuts, playhead]);

  const getTimeFromClientX = useCallback(
    (clientX: number): number => {
      const canvas = canvasRef.current;
      if (!canvas) return 0;
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return ratio * analysis.duration;
    },
    [analysis.duration]
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const dur = Math.max(0.1, analysis.duration);
    const winX1 = (windowStart / dur) * rect.width;
    const winX2 = (windowEnd / dur) * rect.width;

    const handleTolerance = 12;
    let mode: DragMode = "none";

    if (Math.abs(x - winX1) <= handleTolerance) {
      mode = "start";
    } else if (Math.abs(x - winX2) <= handleTolerance) {
      mode = "end";
    } else if (!editBeatsMode && !e.shiftKey && x > winX1 && x < winX2) {
      mode = "move";
    }

    dragRef.current = {
      mode,
      startX: e.clientX,
      origStart: windowStart,
      origEnd: windowEnd,
      moved: false,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag.mode === "none") return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dx = e.clientX - drag.startX;
    if (Math.abs(dx) > 3) {
      drag.moved = true;
    }

    const dt = (dx / rect.width) * analysis.duration;
    const minWindow = 3.0;

    if (drag.mode === "start") {
      const nextStart = Math.max(
        0,
        Math.min(drag.origEnd - minWindow, drag.origStart + dt)
      );
      onChangeWindow(Number(nextStart.toFixed(2)), drag.origEnd);
    } else if (drag.mode === "end") {
      const nextEnd = Math.min(
        analysis.duration,
        Math.max(drag.origStart + minWindow, drag.origEnd + dt)
      );
      onChangeWindow(drag.origStart, Number(nextEnd.toFixed(2)));
    } else if (drag.mode === "move") {
      const len = drag.origEnd - drag.origStart;
      let nextStart = drag.origStart + dt;
      nextStart = Math.max(0, Math.min(analysis.duration - len, nextStart));
      onChangeWindow(
        Number(nextStart.toFixed(2)),
        Number((nextStart + len).toFixed(2))
      );
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    const wasMoved = drag.moved;
    dragRef.current.mode = "none";

    if (!wasMoved) {
      const clickedTime = Number(getTimeFromClientX(e.clientX).toFixed(2));
      const insideWindow =
        clickedTime > windowStart + 0.15 && clickedTime < windowEnd - 0.15;

      if ((editBeatsMode || e.shiftKey) && insideWindow) {
        onToggleCustomCut(clickedTime);
      } else {
        seekTo(clickedTime);
      }
    }
  };

  const applyWindowDuration = (lenSeconds: number | "full") => {
    if (lenSeconds === "full") {
      onChangeWindow(0, Number(analysis.duration.toFixed(2)));
      seekTo(0);
      return;
    }
    const clampedLen = Math.min(analysis.duration, lenSeconds);
    let nextEnd = windowStart + clampedLen;
    let nextStart = windowStart;
    if (nextEnd > analysis.duration) {
      nextEnd = analysis.duration;
      nextStart = Math.max(0, nextEnd - clampedLen);
    }
    onChangeWindow(Number(nextStart.toFixed(2)), Number(nextEnd.toFixed(2)));
  };

  const selectedDuration = Math.max(0, windowEnd - windowStart);

  return (
    <div className="nb-well flex flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={togglePlayback}
            className="nb-key-primary inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-xs font-bold"
          >
            {isPlaying ? (
              <>
                <Pause className="h-3.5 w-3.5" />
                <span>Pause</span>
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5 fill-current" />
                <span>Preview</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => {
              onChangeWindow(
                analysis.recommendedStart,
                analysis.recommendedEnd
              );
              seekTo(analysis.recommendedStart);
            }}
            className="nb-key inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium"
            title="Jump to the strongest auto-detected beat drop"
          >
            <Flame className="h-3.5 w-3.5 text-[#FF4D2E]" />
            <span>Best Drop</span>
          </button>
        </div>

        <span className="font-mono text-[11px] text-[#8B8F9C]">
          <strong className="text-[#F5F5F2]">{analysis.bpm} BPM</strong> ·{" "}
          {selectedDuration.toFixed(1)}s ·{" "}
          <span className="text-amber-300">{activeCuts.length + 1} cuts</span>
        </span>
      </div>

      {/* Waveform Canvas */}
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        className={`h-20 w-full touch-none rounded-lg border border-white/10 bg-[#050608] ${
          editBeatsMode ? "cursor-crosshair" : "cursor-ew-resize"
        }`}
      />

      {/* Beat Density + Window Presets + Edit Beats */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {(
            [
              { id: "every-beat", label: "Fast" },
              { id: "balanced", label: "Balanced" },
              { id: "every-2-beats", label: "Chill" },
            ] as const
          ).map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => onChangeDensity(opt.id)}
              className={`nb-key rounded-full px-2.5 py-1 text-[11px] font-medium ${
                beatDensity === opt.id ? "nb-key-active" : ""
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {[10, 12, 15, 20].map((sec) => (
            <button
              key={sec}
              type="button"
              onClick={() => applyWindowDuration(sec)}
              className="nb-key rounded-full px-2 py-1 font-mono text-[11px]"
            >
              {sec}s
            </button>
          ))}
          <button
            type="button"
            onClick={() => applyWindowDuration("full")}
            className="nb-key rounded-full px-2 py-1 font-mono text-[11px]"
          >
            Full
          </button>

          <button
            type="button"
            onClick={() => setEditBeatsMode((prev) => !prev)}
            className={`nb-key ml-1 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ${
              editBeatsMode
                ? "!border-amber-300/60 !bg-amber-400 !text-black"
                : ""
            }`}
            title="Click on the waveform inside the window to add or remove beat cuts"
          >
            <Scissors className="h-3 w-3" />
            <span>{editBeatsMode ? "Editing" : "Edit Beats"}</span>
          </button>

          {hasCustomBeats && (
            <button
              type="button"
              onClick={onResetAutoBeats}
              className="nb-key inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px]"
              title="Reset to auto-detected beats"
            >
              <RotateCcw className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {analysis.drops.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
          <span className="text-[#8B8F9C]">Drops:</span>
          {analysis.drops.map((drop, idx) => (
            <button
              key={drop}
              type="button"
              onClick={() => {
                const len = Math.max(6, Math.min(15, selectedDuration || 12));
                const start = Math.max(
                  0,
                  Math.min(analysis.duration - len, drop - 2.0)
                );
                const end = Math.min(analysis.duration, start + len);
                onChangeWindow(Number(start.toFixed(2)), Number(end.toFixed(2)));
                seekTo(start);
              }}
              className="nb-key rounded-full px-2 py-0.5"
            >
              #{idx + 1} · {formatTime(drop)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

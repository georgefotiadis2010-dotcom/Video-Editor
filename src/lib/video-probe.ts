import type { VideoMetadata } from "@/types/renderer";

function captureFrameThumbnail(
  video: HTMLVideoElement
): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) {
        resolve(undefined);
        return;
      }
      const maxDim = 360;
      const scale = Math.min(1, maxDim / Math.max(vw, vh));
      const w = Math.max(2, Math.round(vw * scale));
      const h = Math.max(2, Math.round(vh * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(undefined);
        return;
      }
      ctx.drawImage(video, 0, 0, w, h);
      canvas.toBlob(
        (blob) => {
          resolve(blob ? URL.createObjectURL(blob) : undefined);
        },
        "image/jpeg",
        0.82
      );
    } catch {
      resolve(undefined);
    }
  });
}

export function probeVideoMetadata(file: File): Promise<VideoMetadata> {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const probe = document.createElement("video");
    probe.muted = true;
    probe.playsInline = true;
    probe.preload = "auto";

    let settled = false;
    let timeoutId: number | undefined;

    const cleanup = () => {
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      probe.onloadedmetadata = null;
      probe.onloadeddata = null;
      probe.onseeked = null;
      probe.onerror = null;
      probe.removeAttribute("src");
      probe.load();
    };

    const finish = (result: VideoMetadata) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    timeoutId = window.setTimeout(() => {
      const duration =
        Number.isFinite(probe.duration) && probe.duration > 0
          ? probe.duration
          : 0;
      finish({
        file,
        url: objectUrl,
        width: probe.videoWidth || 1080,
        height: probe.videoHeight || 1920,
        duration,
        sizeBytes: file.size,
        browserPlayable: false,
      });
    }, 2500);

    probe.onloadedmetadata = () => {
      const vw = probe.videoWidth;
      const vh = probe.videoHeight;
      const duration =
        Number.isFinite(probe.duration) && probe.duration > 0
          ? probe.duration
          : 0;

      // Container metadata parsed, but video track cannot be decoded by browser
      if (!vw || !vh) {
        finish({
          file,
          url: objectUrl,
          width: 1080,
          height: 1920,
          duration,
          sizeBytes: file.size,
          browserPlayable: false,
        });
        return;
      }

      const captureAndFinish = async () => {
        const thumbnailUrl = await captureFrameThumbnail(probe);
        finish({
          file,
          url: objectUrl,
          thumbnailUrl,
          width: vw,
          height: vh,
          duration: duration || 1,
          sizeBytes: file.size,
          browserPlayable: true,
        });
      };

      const seekTarget = duration > 0.3 ? Math.min(0.15, duration * 0.1) : 0;
      if (seekTarget > 0) {
        probe.onseeked = () => {
          void captureAndFinish();
        };
        try {
          probe.currentTime = seekTarget;
          return;
        } catch {
          // Fall through to loadeddata
        }
      }

      if (probe.readyState >= 2) {
        void captureAndFinish();
      } else {
        probe.onloadeddata = () => {
          void captureAndFinish();
        };
      }
    };

    probe.onerror = () => {
      // Browser cannot natively decode this container/codec; let FFmpeg.wasm handle thumbnail & preview proxy
      finish({
        file,
        url: objectUrl,
        width: 1080,
        height: 1920,
        duration: 0,
        sizeBytes: file.size,
        browserPlayable: false,
      });
    };

    probe.src = objectUrl;
  });
}

export function revokeVideoMetadataUrls(
  meta:
    | Pick<VideoMetadata, "url" | "previewUrl" | "thumbnailUrl">
    | null
    | undefined
): void {
  if (!meta) return;
  if (meta.url) URL.revokeObjectURL(meta.url);
  if (meta.previewUrl) URL.revokeObjectURL(meta.previewUrl);
  if (meta.thumbnailUrl) URL.revokeObjectURL(meta.thumbnailUrl);
}

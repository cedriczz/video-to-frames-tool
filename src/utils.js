export const DEFAULT_FPS = 24;
export const DEFAULT_QUALITY = 0.82;
export const MIN_QUALITY = 0.2;
export const FRAME_PADDING = 6;
export const TARGET_FRAME_SIZE_BYTES = 150 * 1024;
export const MAX_FRAME_SIZE_BYTES = 200 * 1024;

export function sanitizeBaseName(fileName) {
  const lastDot = fileName.lastIndexOf(".");
  const rawBase = lastDot > 0 ? fileName.slice(0, lastDot) : fileName;

  return (
    rawBase
      .trim()
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "") || "frames"
  );
}

export function formatFrameName(baseName, index) {
  return `${baseName}_${String(index).padStart(FRAME_PADDING, "0")}.jpg`;
}

export function buildArchiveName(baseName, fps) {
  return `${baseName}_${fps}fps_frames.zip`;
}

export function formatDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return "0:00";
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function downloadBlob(blob, fileName) {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = objectUrl;
  link.download = fileName;
  link.click();

  setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 1000);
}

export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

import "./styles.css";

import { extractFramesToZip } from "./extractor.js";
import {
  DEFAULT_FPS,
  downloadBlob,
  formatDuration,
  formatFileSize,
  MAX_FRAME_SIZE_BYTES,
  sanitizeBaseName,
  TARGET_FRAME_SIZE_BYTES,
} from "./utils.js";

const dropzone = document.querySelector("#dropzone");
const videoInput = document.querySelector("#video-input");
const selectButton = document.querySelector("#select-button");
const statusTitle = document.querySelector("#status-title");
const statusChip = document.querySelector("#status-chip");
const metaName = document.querySelector("#meta-name");
const metaResolution = document.querySelector("#meta-resolution");
const metaDuration = document.querySelector("#meta-duration");
const metaFrames = document.querySelector("#meta-frames");
const metaOutput = document.querySelector("#meta-output");
const progressLabel = document.querySelector("#progress-label");
const progressValue = document.querySelector("#progress-value");
const progressBarFill = document.querySelector("#progress-bar-fill");
const progressNote = document.querySelector("#progress-note");

let isProcessing = false;
let activeRunId = 0;

function setProgress(percent) {
  const safePercent = Math.max(0, Math.min(percent, 100));
  progressBarFill.style.width = `${safePercent}%`;
  progressValue.textContent = `${safePercent}%`;
}

function setIdleState() {
  statusTitle.textContent = "等待视频";
  statusChip.textContent = "待处理";
  progressLabel.textContent = "等待开始";
  progressNote.textContent = "拖入视频后会立刻开始抽帧、压缩并打包 ZIP。";
  setProgress(0);
}

function setBusyState(file) {
  statusTitle.textContent = "正在处理视频";
  statusChip.textContent = "处理中";
  metaName.textContent = `${file.name} (${formatFileSize(file.size)})`;
}

function buildResultMessage(result) {
  const { compressionSummary } = result;

  if (compressionSummary.framesOverHardTarget > 0) {
    return `${result.archiveName} 已开始下载。${compressionSummary.framesOverHardTarget} 张复杂帧在不改分辨率时仍高于 ${formatFileSize(compressionSummary.maxFrameBytes)}，已输出当前分辨率下的最小体积。`;
  }

  if (compressionSummary.framesWithinSoftTarget === result.totalFrames) {
    return `${result.archiveName} 已开始下载。所有帧都压到了 ${formatFileSize(compressionSummary.targetFrameBytes)} 以内。`;
  }

  return `${result.archiveName} 已开始下载。少数帧在保持原分辨率时落在 ${formatFileSize(compressionSummary.targetFrameBytes)} 到 ${formatFileSize(compressionSummary.maxFrameBytes)} 之间。`;
}

function setResultState(result) {
  statusTitle.textContent = "处理完成";
  statusChip.textContent = "已下载";
  progressLabel.textContent = "ZIP 已生成";
  progressNote.textContent = buildResultMessage(result);
  setProgress(100);
}

function setErrorState(message) {
  statusTitle.textContent = "处理失败";
  statusChip.textContent = "失败";
  progressLabel.textContent = "未完成";
  progressNote.textContent = message;
}

function updateMetaPreview(file) {
  const baseName = sanitizeBaseName(file.name);

  metaName.textContent = `${file.name} (${formatFileSize(file.size)})`;
  metaResolution.textContent = "读取中";
  metaDuration.textContent = "读取中";
  metaFrames.textContent = "计算中";
  metaOutput.textContent = `${baseName}_${DEFAULT_FPS}fps_frames.zip`;
}

function updateProgress(progress) {
  if (progress.phase === "loading") {
    progressLabel.textContent = "读取视频元数据";
    progressNote.textContent = "浏览器正在本地加载视频信息。";
    setProgress(progress.percent ?? 2);
    return;
  }

  if (progress.width && progress.height) {
    metaResolution.textContent = `${progress.width} × ${progress.height}`;
  }

  if (Number.isFinite(progress.duration)) {
    metaDuration.textContent = formatDuration(progress.duration);
  }

  if (Number.isFinite(progress.totalFrames)) {
    metaFrames.textContent = `${progress.totalFrames} 张`;
  }

  if (progress.archiveName) {
    metaOutput.textContent = progress.archiveName;
  }

  if (progress.phase === "extracting") {
    progressLabel.textContent = `正在抽帧 ${progress.processedFrames}/${progress.totalFrames}`;

    if ((progress.framesOverHardTarget ?? 0) > 0) {
      progressNote.textContent = `当前帧 ${formatFileSize(progress.currentFrameBytes)}，部分复杂帧已超过 ${formatFileSize(progress.maxFrameBytes ?? MAX_FRAME_SIZE_BYTES)}。`;
    } else if ((progress.currentFrameBytes ?? 0) > (progress.targetFrameBytes ?? TARGET_FRAME_SIZE_BYTES)) {
      progressNote.textContent = `当前帧 ${formatFileSize(progress.currentFrameBytes)}，速度优先，允许落在 ${formatFileSize(progress.targetFrameBytes ?? TARGET_FRAME_SIZE_BYTES)} 到 ${formatFileSize(progress.maxFrameBytes ?? MAX_FRAME_SIZE_BYTES)} 之间。`;
    } else {
      progressNote.textContent = `当前帧 ${formatFileSize(progress.currentFrameBytes)}，目标 ${formatFileSize(progress.targetFrameBytes ?? TARGET_FRAME_SIZE_BYTES)}。`;
    }

    setProgress(progress.percent ?? 0);
    return;
  }

  if (progress.phase === "zipping") {
    progressLabel.textContent = "正在打包 ZIP";
    progressNote.textContent = "已完成抽帧和压缩，正在快速生成可下载压缩包。";
    setProgress(progress.percent ?? 100);
  }
}

function isVideoFile(file) {
  return file.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|ogg|ogv)$/i.test(file.name);
}

async function handleFile(file) {
  if (!file || isProcessing) {
    return;
  }

  if (!isVideoFile(file)) {
    setErrorState("请选择视频文件。推荐使用 MP4(H.264) 或 WebM。");
    return;
  }

  isProcessing = true;
  activeRunId += 1;
  const runId = activeRunId;

  updateMetaPreview(file);
  setBusyState(file);
  selectButton.disabled = true;
  videoInput.disabled = true;
  dropzone.classList.add("is-processing");

  try {
    const result = await extractFramesToZip({
      file,
      fps: DEFAULT_FPS,
      targetFrameBytes: TARGET_FRAME_SIZE_BYTES,
      maxFrameBytes: MAX_FRAME_SIZE_BYTES,
      onProgress: (progress) => {
        if (runId !== activeRunId) {
          return;
        }

        updateProgress(progress);
      },
    });

    if (runId !== activeRunId) {
      return;
    }

    downloadBlob(result.archiveBlob, result.archiveName);
    metaResolution.textContent = `${result.width} × ${result.height}`;
    metaDuration.textContent = formatDuration(result.duration);
    metaFrames.textContent = `${result.totalFrames} 张`;
    metaOutput.textContent = result.archiveName;
    setResultState(result);
  } catch (error) {
    console.error(error);
    setErrorState(error instanceof Error ? error.message : "处理过程中出现未知错误。");
  } finally {
    isProcessing = false;
    selectButton.disabled = false;
    videoInput.disabled = false;
    dropzone.classList.remove("is-processing");
    videoInput.value = "";
  }
}

function extractFromFileList(fileList) {
  const [file] = Array.from(fileList ?? []);

  if (file) {
    void handleFile(file);
  }
}

selectButton.addEventListener("click", () => {
  if (!isProcessing) {
    videoInput.click();
  }
});

videoInput.addEventListener("change", (event) => {
  extractFromFileList(event.currentTarget.files);
});

dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();

  if (!isProcessing) {
    dropzone.classList.add("is-dragover");
  }
});

dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("is-dragover");
});

dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("is-dragover");

  if (isProcessing) {
    return;
  }

  extractFromFileList(event.dataTransfer.files);
});

dropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();

    if (!isProcessing) {
      videoInput.click();
    }
  }
});

setIdleState();

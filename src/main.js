import "./styles.css";

import { extractFramesToZip } from "./extractor.js";
import {
  DEFAULT_COMPRESSION_PRESET_ID,
  DEFAULT_FPS,
  downloadBlob,
  formatDuration,
  formatFileSize,
  getCompressionPreset,
  sanitizeBaseName,
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
const metaCompression = document.querySelector("#meta-compression");
const metaOutput = document.querySelector("#meta-output");
const progressLabel = document.querySelector("#progress-label");
const progressValue = document.querySelector("#progress-value");
const progressBarFill = document.querySelector("#progress-bar-fill");
const progressNote = document.querySelector("#progress-note");
const compressionPresetInputs = Array.from(
  document.querySelectorAll('input[name="compression-preset"]'),
);

let isProcessing = false;
let activeRunId = 0;

function getSelectedCompressionPreset() {
  const selectedInput = compressionPresetInputs.find((input) => input.checked);
  return getCompressionPreset(selectedInput?.value ?? DEFAULT_COMPRESSION_PRESET_ID);
}

function setCompressionInputsDisabled(disabled) {
  for (const input of compressionPresetInputs) {
    input.disabled = disabled;
  }
}

function setProgress(percent) {
  const safePercent = Math.max(0, Math.min(percent, 100));
  progressBarFill.style.width = `${safePercent}%`;
  progressValue.textContent = `${safePercent}%`;
}

function formatCompressionMode(preset) {
  if (preset.unbounded) {
    return "不压缩（高质量 JPG）";
  }

  if (preset.maxFrameBytes && preset.maxFrameBytes !== preset.targetFrameBytes) {
    return `${preset.label}（上限 ${formatFileSize(preset.maxFrameBytes)}）`;
  }

  return preset.label;
}

function setIdleState() {
  const preset = getSelectedCompressionPreset();

  statusTitle.textContent = "等待视频";
  statusChip.textContent = "待处理";
  progressLabel.textContent = "等待开始";
  progressNote.textContent = `拖入视频后会立刻开始抽帧并导出 ZIP，当前压缩档位：${formatCompressionMode(preset)}。`;
  metaCompression.textContent = formatCompressionMode(preset);
  setProgress(0);
}

function setBusyState(file, preset) {
  statusTitle.textContent = "正在处理视频";
  statusChip.textContent = "处理中";
  metaName.textContent = `${file.name} (${formatFileSize(file.size)})`;
  metaCompression.textContent = formatCompressionMode(preset);
}

function buildResultMessage(result) {
  const preset = result.compressionPreset ?? getSelectedCompressionPreset();
  const { compressionSummary } = result;

  if (preset.unbounded) {
    return `${result.archiveName} 已开始下载。当前使用高质量 JPG 直出，不做体积限制。`;
  }

  if (compressionSummary.framesOverHardTarget > 0) {
    return `${result.archiveName} 已开始下载。${compressionSummary.framesOverHardTarget} 张复杂帧在不改分辨率时仍高于 ${formatFileSize(compressionSummary.maxFrameBytes)}，已输出当前分辨率下的最小体积。`;
  }

  if (compressionSummary.framesWithinSoftTarget === result.totalFrames) {
    return `${result.archiveName} 已开始下载。所有帧都控制在 ${formatFileSize(compressionSummary.targetFrameBytes)} 以内。`;
  }

  return `${result.archiveName} 已开始下载。少数帧保持在 ${formatFileSize(compressionSummary.targetFrameBytes)} 到 ${formatFileSize(compressionSummary.maxFrameBytes)} 之间。`;
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

function updateMetaPreview(file, preset) {
  const baseName = sanitizeBaseName(file.name);

  metaName.textContent = `${file.name} (${formatFileSize(file.size)})`;
  metaResolution.textContent = "读取中";
  metaDuration.textContent = "读取中";
  metaFrames.textContent = "计算中";
  metaCompression.textContent = formatCompressionMode(preset);
  metaOutput.textContent = `${baseName}_${DEFAULT_FPS}fps_frames.zip`;
}

function updateProgress(progress, preset) {
  if (progress.phase === "loading") {
    progressLabel.textContent = "读取视频元数据";
    progressNote.textContent = `浏览器正在本地加载视频信息，当前压缩档位：${formatCompressionMode(preset)}。`;
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

  metaCompression.textContent = formatCompressionMode(preset);

  if (progress.phase === "extracting") {
    progressLabel.textContent = `正在抽帧 ${progress.processedFrames}/${progress.totalFrames}`;

    if (preset.unbounded) {
      progressNote.textContent = `当前帧 ${formatFileSize(progress.currentFrameBytes)}，正在按高质量 JPG 直出。`;
    } else if ((progress.framesOverHardTarget ?? 0) > 0) {
      progressNote.textContent = `当前帧 ${formatFileSize(progress.currentFrameBytes)}，部分复杂帧仍高于 ${formatFileSize(progress.maxFrameBytes)}。`;
    } else if (
      Number.isFinite(progress.targetFrameBytes) &&
      Number.isFinite(progress.maxFrameBytes) &&
      progress.maxFrameBytes > progress.targetFrameBytes &&
      (progress.currentFrameBytes ?? 0) > progress.targetFrameBytes
    ) {
      progressNote.textContent = `当前帧 ${formatFileSize(progress.currentFrameBytes)}，会优先落在 ${formatFileSize(progress.targetFrameBytes)} 到 ${formatFileSize(progress.maxFrameBytes)} 之间。`;
    } else if (Number.isFinite(progress.targetFrameBytes)) {
      progressNote.textContent = `当前帧 ${formatFileSize(progress.currentFrameBytes)}，目标 ${formatFileSize(progress.targetFrameBytes)}。`;
    } else {
      progressNote.textContent = `当前帧 ${formatFileSize(progress.currentFrameBytes)}。`;
    }

    setProgress(progress.percent ?? 0);
    return;
  }

  if (progress.phase === "zipping") {
    progressLabel.textContent = "正在打包 ZIP";
    progressNote.textContent = "抽帧已完成，正在生成可下载的 ZIP 包。";
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
  const preset = getSelectedCompressionPreset();

  updateMetaPreview(file, preset);
  setBusyState(file, preset);
  setCompressionInputsDisabled(true);
  selectButton.disabled = true;
  videoInput.disabled = true;
  dropzone.classList.add("is-processing");

  try {
    const result = await extractFramesToZip({
      file,
      fps: DEFAULT_FPS,
      compressionPreset: preset,
      onProgress: (progress) => {
        if (runId !== activeRunId) {
          return;
        }

        updateProgress(progress, preset);
      },
    });

    if (runId !== activeRunId) {
      return;
    }

    downloadBlob(result.archiveBlob, result.archiveName);
    metaResolution.textContent = `${result.width} × ${result.height}`;
    metaDuration.textContent = formatDuration(result.duration);
    metaFrames.textContent = `${result.totalFrames} 张`;
    metaCompression.textContent = formatCompressionMode(result.compressionPreset ?? preset);
    metaOutput.textContent = result.archiveName;
    setResultState(result);
  } catch (error) {
    console.error(error);
    setErrorState(error instanceof Error ? error.message : "处理过程中出现未知错误。");
  } finally {
    isProcessing = false;
    setCompressionInputsDisabled(false);
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

for (const input of compressionPresetInputs) {
  input.addEventListener("change", () => {
    if (!isProcessing) {
      setIdleState();
    }
  });
}

setIdleState();

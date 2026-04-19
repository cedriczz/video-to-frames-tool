import JSZip from "jszip";

import {
  buildArchiveName,
  DEFAULT_COMPRESSION_PRESET_ID,
  DEFAULT_FPS,
  DEFAULT_QUALITY,
  formatFrameName,
  getCompressionPreset,
  MIN_QUALITY,
  sanitizeBaseName,
} from "./utils.js";

const SEEK_EPSILON = 0.001;
const EVENT_TIMEOUT_MS = 15000;
const HARD_LIMIT_SEARCH_STEPS = 3;
const QUALITY_EPSILON = 0.01;
const FAST_PLAYBACK_RATE = 16;
const QUEUE_HIGH_WATER_MARK = 2;

function waitForEvent(
  target,
  eventName,
  {
    errorEvents = ["error"],
    timeoutMs = EVENT_TIMEOUT_MS,
    timeoutMessage = "视频处理超时，请优先尝试 MP4(H.264) 或 WebM。",
  } = {},
) {
  return new Promise((resolve, reject) => {
    let timeoutId;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      target.removeEventListener(eventName, onSuccess);

      for (const errorEvent of errorEvents) {
        target.removeEventListener(errorEvent, onError);
      }
    };

    const onSuccess = () => {
      cleanup();
      resolve();
    };

    const onError = () => {
      cleanup();
      reject(new Error("浏览器无法解码这个视频文件，请优先尝试 MP4(H.264) 或 WebM。"));
    };

    const onTimeout = () => {
      cleanup();
      reject(new Error(timeoutMessage));
    };

    target.addEventListener(eventName, onSuccess, { once: true });

    for (const errorEvent of errorEvents) {
      target.addEventListener(errorEvent, onError, { once: true });
    }

    timeoutId = setTimeout(onTimeout, timeoutMs);
  });
}

function createHiddenVideo(file) {
  const video = document.createElement("video");

  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.crossOrigin = "anonymous";
  video.src = URL.createObjectURL(file);

  return video;
}

function createRenderSurface(width, height) {
  if (typeof OffscreenCanvas === "function") {
    const surface = new OffscreenCanvas(width, height);
    const context = surface.getContext("2d", {
      alpha: false,
      desynchronized: true,
    });

    return { surface, context };
  }

  const surface = document.createElement("canvas");
  surface.width = width;
  surface.height = height;

  const context = surface.getContext("2d", {
    alpha: false,
    desynchronized: true,
  });

  return { surface, context };
}

async function surfaceToBlob(surface, quality) {
  if ("convertToBlob" in surface) {
    return surface.convertToBlob({
      type: "image/jpeg",
      quality,
    });
  }

  return new Promise((resolve, reject) => {
    surface.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("当前浏览器无法导出 JPG 帧。"));
          return;
        }

        resolve(blob);
      },
      "image/jpeg",
      quality,
    );
  });
}

function clampQuality(value, minQuality, maxQuality) {
  return Number(Math.min(maxQuality, Math.max(minQuality, value)).toFixed(3));
}

async function waitForLoadedData(video) {
  if (video.readyState >= 2) {
    return;
  }

  await waitForEvent(video, "loadeddata", {
    timeoutMessage: "视频首帧加载超时，请尝试更常见的编码格式。",
  });
}

async function ensureFrameReady() {
  await new Promise((resolve) => {
    let settled = false;
    const raf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (callback) => setTimeout(callback, 16);

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      resolve();
    };

    const timeoutId = setTimeout(finish, 80);

    raf(() => {
      raf(() => {
        clearTimeout(timeoutId);
        finish();
      });
    });
  });
}

async function seekVideo(video, timeInSeconds) {
  const maxSafeTime = Math.max(0, video.duration - SEEK_EPSILON);
  const targetTime = Math.min(Math.max(timeInSeconds, 0), maxSafeTime);

  if (Math.abs(video.currentTime - targetTime) < 0.00001 && video.readyState >= 2) {
    await ensureFrameReady();
    return;
  }

  const seekPromise = waitForEvent(video, "seeked", {
    timeoutMessage: "视频跳帧超时，当前文件可能不适合在浏览器里直接抽帧。",
  });

  video.currentTime = targetTime;
  await seekPromise;
  await ensureFrameReady();
}

async function compressSurfaceToTarget(
  surface,
  compressionState,
  {
    targetBytes,
    maxBytes,
    maxQuality,
    minQuality,
  },
) {
  let quality = clampQuality(
    compressionState.nextQuality ?? maxQuality,
    minQuality,
    maxQuality,
  );
  let blob = await surfaceToBlob(surface, quality);

  if (blob.size <= targetBytes) {
    compressionState.nextQuality =
      blob.size < targetBytes * 0.72
        ? clampQuality(quality + 0.025, minQuality, maxQuality)
        : quality;

    return {
      blob,
      quality,
      withinSoftTarget: true,
      withinHardTarget: true,
    };
  }

  if (blob.size <= maxBytes) {
    compressionState.nextQuality = clampQuality(quality - 0.035, minQuality, maxQuality);

    return {
      blob,
      quality,
      withinSoftTarget: false,
      withinHardTarget: true,
    };
  }

  let low = minQuality;
  let high = quality;
  let bestBlob = await surfaceToBlob(surface, minQuality);
  let bestQuality = minQuality;

  if (bestBlob.size > maxBytes) {
    compressionState.nextQuality = minQuality;

    return {
      blob: bestBlob,
      quality: minQuality,
      withinSoftTarget: false,
      withinHardTarget: false,
    };
  }

  for (let step = 0; step < HARD_LIMIT_SEARCH_STEPS; step += 1) {
    if (high - low <= QUALITY_EPSILON) {
      break;
    }

    const mid = clampQuality((low + high) / 2, minQuality, maxQuality);
    const midBlob = await surfaceToBlob(surface, mid);

    if (midBlob.size <= maxBytes) {
      bestBlob = midBlob;
      bestQuality = mid;
      low = mid;
      continue;
    }

    high = mid;
  }

  compressionState.nextQuality = clampQuality(bestQuality - 0.02, minQuality, maxQuality);

  return {
    blob: bestBlob,
    quality: bestQuality,
    withinSoftTarget: bestBlob.size <= targetBytes,
    withinHardTarget: true,
  };
}

async function exportSurface(surface, compressionState, compressionPreset) {
  const maxQuality = compressionPreset.quality ?? DEFAULT_QUALITY;
  const minQuality = compressionPreset.minQuality ?? MIN_QUALITY;

  if (compressionPreset.unbounded) {
    const quality = clampQuality(
      compressionState.nextQuality ?? maxQuality,
      minQuality,
      maxQuality,
    );
    const blob = await surfaceToBlob(surface, quality);

    compressionState.nextQuality = quality;

    return {
      blob,
      quality,
      withinSoftTarget: true,
      withinHardTarget: true,
    };
  }

  return compressSurfaceToTarget(surface, compressionState, {
    targetBytes: compressionPreset.targetFrameBytes,
    maxBytes: compressionPreset.maxFrameBytes,
    maxQuality,
    minQuality,
  });
}

function shouldReportProgress(processedFrames, totalFrames) {
  return (
    processedFrames === totalFrames ||
    processedFrames === 1 ||
    processedFrames % 4 === 0
  );
}

function createCompressionSummary(compressionPreset) {
  return {
    presetId: compressionPreset.id,
    presetLabel: compressionPreset.label,
    unbounded: compressionPreset.unbounded,
    targetFrameBytes: compressionPreset.targetFrameBytes,
    maxFrameBytes: compressionPreset.maxFrameBytes,
    framesWithinSoftTarget: 0,
    framesWithinHardTarget: 0,
    framesOverHardTarget: 0,
    largestFrameBytes: 0,
    lowestQualityUsed: compressionPreset.quality ?? DEFAULT_QUALITY,
    averageQuality: compressionPreset.quality ?? DEFAULT_QUALITY,
  };
}

function updateCompressionSummary(summary, compressionResult, frameBlob) {
  summary.largestFrameBytes = Math.max(summary.largestFrameBytes, frameBlob.size);
  summary.lowestQualityUsed = Math.min(summary.lowestQualityUsed, compressionResult.quality);

  if (summary.unbounded) {
    summary.framesWithinSoftTarget += 1;
    summary.framesWithinHardTarget += 1;
    return;
  }

  if (compressionResult.withinSoftTarget) {
    summary.framesWithinSoftTarget += 1;
  }

  if (compressionResult.withinHardTarget) {
    summary.framesWithinHardTarget += 1;
  } else {
    summary.framesOverHardTarget += 1;
  }
}

function buildProgressPayload({
  compressionPreset,
  compressionSummary,
  video,
  width,
  height,
  totalFrames,
  processedFrames,
  archiveName,
  currentFrameBytes,
  phase,
  percent,
}) {
  return {
    phase,
    duration: video.duration,
    width,
    height,
    totalFrames,
    processedFrames,
    percent,
    archiveName,
    compressionPresetId: compressionPreset.id,
    compressionPresetLabel: compressionPreset.label,
    compressionUnbounded: compressionPreset.unbounded,
    targetFrameBytes: compressionPreset.targetFrameBytes,
    maxFrameBytes: compressionPreset.maxFrameBytes,
    currentFrameBytes,
    framesOverHardTarget: compressionSummary.framesOverHardTarget,
  };
}

async function extractFramesWithSeekingFallback({
  video,
  baseName,
  totalFrames,
  fps,
  width,
  height,
  archiveName,
  archiveRoot,
  zip,
  compressionPreset,
  compressionSummary,
  onProgress,
}) {
  const { surface, context } = createRenderSurface(width, height);

  if (!context) {
    throw new Error("当前浏览器无法初始化 Canvas。");
  }

  const compressionState = {
    nextQuality: compressionPreset.quality ?? DEFAULT_QUALITY,
  };
  let totalQuality = 0;

  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
    const targetTime = frameIndex / fps;

    await seekVideo(video, targetTime);
    context.drawImage(video, 0, 0, width, height);

    const compressionResult = await exportSurface(
      surface,
      compressionState,
      compressionPreset,
    );
    const frameBlob = compressionResult.blob;
    const processedFrames = frameIndex + 1;
    const frameName = formatFrameName(baseName, processedFrames);

    zip.file(`${archiveRoot}${frameName}`, frameBlob, { binary: true });
    totalQuality += compressionResult.quality;
    updateCompressionSummary(compressionSummary, compressionResult, frameBlob);

    if (shouldReportProgress(processedFrames, totalFrames)) {
      onProgress(
        buildProgressPayload({
          compressionPreset,
          compressionSummary,
          video,
          width,
          height,
          totalFrames,
          processedFrames,
          archiveName,
          currentFrameBytes: frameBlob.size,
          phase: "extracting",
          percent: Math.round((processedFrames / totalFrames) * 100),
        }),
      );
    }
  }

  compressionSummary.averageQuality = totalQuality / totalFrames;
}

async function extractFramesWithPlaybackSampling({
  video,
  baseName,
  totalFrames,
  fps,
  width,
  height,
  archiveName,
  archiveRoot,
  zip,
  compressionPreset,
  compressionSummary,
  onProgress,
}) {
  const interval = 1 / fps;
  const tolerance = interval / 2;
  const { surface: encodeSurface, context: encodeContext } = createRenderSurface(width, height);
  const compressionState = {
    nextQuality: compressionPreset.quality ?? DEFAULT_QUALITY,
  };
  const queue = [];
  let totalQuality = 0;
  let enqueuedFrames = 0;
  let processedFrames = 0;
  let processingQueuePromise = null;
  let pausedForBackpressure = false;
  let settled = false;

  if (!encodeContext) {
    throw new Error("当前浏览器无法初始化 Canvas。");
  }

  let resolveDone;
  let rejectDone;
  const donePromise = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  async function resolveIfComplete() {
    if (settled || processedFrames < totalFrames) {
      return;
    }

    compressionSummary.averageQuality = totalQuality / totalFrames;
    settled = true;
    resolveDone();
  }

  async function resumePlaybackIfNeeded() {
    if (
      !pausedForBackpressure ||
      queue.length >= QUEUE_HIGH_WATER_MARK ||
      enqueuedFrames >= totalFrames
    ) {
      return;
    }

    pausedForBackpressure = false;
    video.requestVideoFrameCallback(onVideoFrame);
    await video.play();
  }

  async function processQueue() {
    if (processingQueuePromise) {
      return processingQueuePromise;
    }

    processingQueuePromise = (async () => {
      try {
        while (queue.length > 0) {
          const task = queue.shift();

          for (let repeatIndex = 0; repeatIndex < task.repeatCount; repeatIndex += 1) {
            encodeContext.drawImage(task.imageBitmap, 0, 0, width, height);

            const compressionResult = await exportSurface(
              encodeSurface,
              compressionState,
              compressionPreset,
            );
            const frameBlob = compressionResult.blob;
            const frameName = formatFrameName(baseName, processedFrames + 1);

            zip.file(`${archiveRoot}${frameName}`, frameBlob, { binary: true });
            totalQuality += compressionResult.quality;
            updateCompressionSummary(compressionSummary, compressionResult, frameBlob);
            processedFrames += 1;

            if (shouldReportProgress(processedFrames, totalFrames)) {
              onProgress(
                buildProgressPayload({
                  compressionPreset,
                  compressionSummary,
                  video,
                  width,
                  height,
                  totalFrames,
                  processedFrames,
                  archiveName,
                  currentFrameBytes: frameBlob.size,
                  phase: "extracting",
                  percent: Math.round((processedFrames / totalFrames) * 100),
                }),
              );
            }
          }

          task.imageBitmap.close();
          await resumePlaybackIfNeeded();
        }

        await resolveIfComplete();
      } catch (error) {
        if (!settled) {
          settled = true;
          rejectDone(error);
        }
      } finally {
        processingQueuePromise = null;
      }
    })();

    return processingQueuePromise;
  }

  async function enqueueSnapshot(repeatCount) {
    const imageBitmap = await createImageBitmap(video);

    queue.push({
      imageBitmap,
      repeatCount,
    });

    void processQueue();
  }

  async function finalizeWithLastFrame() {
    video.pause();

    if (enqueuedFrames < totalFrames) {
      const remainingFrames = totalFrames - enqueuedFrames;

      enqueuedFrames = totalFrames;
      await enqueueSnapshot(remainingFrames);
      return;
    }

    await resolveIfComplete();
  }

  async function onVideoFrame(_now, metadata) {
    try {
      const mediaTime = metadata.mediaTime ?? video.currentTime;
      let crossedTargets = 0;

      while (
        enqueuedFrames < totalFrames &&
        mediaTime + tolerance >= enqueuedFrames / fps
      ) {
        crossedTargets += 1;
        enqueuedFrames += 1;
      }

      if (crossedTargets > 0) {
        await enqueueSnapshot(crossedTargets);
      }

      if (enqueuedFrames >= totalFrames || video.ended) {
        await finalizeWithLastFrame();
        return;
      }

      if (queue.length >= QUEUE_HIGH_WATER_MARK) {
        pausedForBackpressure = true;
        video.pause();
        return;
      }

      video.requestVideoFrameCallback(onVideoFrame);
    } catch (error) {
      if (!settled) {
        settled = true;
        rejectDone(error);
      }
    }
  }

  video.addEventListener(
    "ended",
    () => {
      if (!settled) {
        void finalizeWithLastFrame();
      }
    },
    { once: true },
  );

  video.playbackRate = FAST_PLAYBACK_RATE;
  video.defaultPlaybackRate = FAST_PLAYBACK_RATE;
  video.requestVideoFrameCallback(onVideoFrame);
  await video.play();
  await donePromise;

  if (processingQueuePromise) {
    await processingQueuePromise;
  }
}

export async function extractFramesToZip({
  file,
  fps = DEFAULT_FPS,
  compressionPreset = DEFAULT_COMPRESSION_PRESET_ID,
  onProgress = () => {},
}) {
  const resolvedCompressionPreset =
    typeof compressionPreset === "string"
      ? getCompressionPreset(compressionPreset)
      : getCompressionPreset(compressionPreset?.id);
  const video = createHiddenVideo(file);
  const baseName = sanitizeBaseName(file.name);

  try {
    onProgress({
      phase: "loading",
      percent: 2,
      compressionPresetId: resolvedCompressionPreset.id,
      compressionPresetLabel: resolvedCompressionPreset.label,
      compressionUnbounded: resolvedCompressionPreset.unbounded,
      targetFrameBytes: resolvedCompressionPreset.targetFrameBytes,
      maxFrameBytes: resolvedCompressionPreset.maxFrameBytes,
    });

    await waitForEvent(video, "loadedmetadata", {
      timeoutMessage: "视频元数据读取超时，请尝试 MP4(H.264) 或 WebM。",
    });

    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error("这个视频看起来没有有效时长，无法抽帧。");
    }

    await waitForLoadedData(video);
    await ensureFrameReady();

    const width = video.videoWidth;
    const height = video.videoHeight;

    if (!width || !height) {
      throw new Error("浏览器没有拿到视频尺寸，无法继续处理。");
    }

    const totalFrames = Math.max(1, Math.ceil(video.duration * fps));
    const archiveName = buildArchiveName(baseName, fps);
    const archiveRoot = `${baseName}_${fps}fps_frames/`;

    onProgress(
      buildProgressPayload({
        compressionPreset: resolvedCompressionPreset,
        compressionSummary: createCompressionSummary(resolvedCompressionPreset),
        video,
        width,
        height,
        totalFrames,
        processedFrames: 0,
        archiveName,
        currentFrameBytes: 0,
        phase: "extracting",
        percent: 0,
      }),
    );

    let zip = new JSZip();
    let compressionSummary = createCompressionSummary(resolvedCompressionPreset);

    try {
      if (
        typeof video.requestVideoFrameCallback === "function" &&
        typeof createImageBitmap === "function"
      ) {
        await extractFramesWithPlaybackSampling({
          video,
          baseName,
          totalFrames,
          fps,
          width,
          height,
          archiveName,
          archiveRoot,
          zip,
          compressionPreset: resolvedCompressionPreset,
          compressionSummary,
          onProgress,
        });
      } else {
        await extractFramesWithSeekingFallback({
          video,
          baseName,
          totalFrames,
          fps,
          width,
          height,
          archiveName,
          archiveRoot,
          zip,
          compressionPreset: resolvedCompressionPreset,
          compressionSummary,
          onProgress,
        });
      }
    } catch (error) {
      const canRetryWithSeek =
        typeof video.requestVideoFrameCallback === "function" &&
        typeof createImageBitmap === "function";

      if (!canRetryWithSeek) {
        throw error;
      }

      video.pause();
      video.currentTime = 0;
      await waitForLoadedData(video);
      await ensureFrameReady();

      zip = new JSZip();
      compressionSummary = createCompressionSummary(resolvedCompressionPreset);

      await extractFramesWithSeekingFallback({
        video,
        baseName,
        totalFrames,
        fps,
        width,
        height,
        archiveName,
        archiveRoot,
        zip,
        compressionPreset: resolvedCompressionPreset,
        compressionSummary,
        onProgress,
      });
    }

    onProgress(
      buildProgressPayload({
        compressionPreset: resolvedCompressionPreset,
        compressionSummary,
        video,
        width,
        height,
        totalFrames,
        processedFrames: totalFrames,
        archiveName,
        currentFrameBytes: compressionSummary.largestFrameBytes,
        phase: "zipping",
        percent: 100,
      }),
    );

    const zipBlob = await zip.generateAsync(
      {
        type: "blob",
        compression: "STORE",
        streamFiles: true,
      },
      (metadata) => {
        onProgress(
          buildProgressPayload({
            compressionPreset: resolvedCompressionPreset,
            compressionSummary,
            video,
            width,
            height,
            totalFrames,
            processedFrames: totalFrames,
            archiveName,
            currentFrameBytes: compressionSummary.largestFrameBytes,
            phase: "zipping",
            percent: Math.round(metadata.percent),
          }),
        );
      },
    );

    return {
      archiveBlob: zipBlob,
      archiveName,
      archiveRoot,
      duration: video.duration,
      width,
      height,
      totalFrames,
      compressionSummary,
      compressionPreset: resolvedCompressionPreset,
    };
  } finally {
    URL.revokeObjectURL(video.src);
    video.remove();
  }
}

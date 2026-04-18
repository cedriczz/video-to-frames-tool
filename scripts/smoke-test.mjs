import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import JSZip from "jszip";
import { chromium } from "playwright";

const PORT = 4173;
const ROOT_DIR = process.cwd();
const SAMPLE_NAME = "sample-smoke.mp4";
const SAMPLE_PATH = path.join(ROOT_DIR, SAMPLE_NAME);
const TARGET_FRAME_SIZE_BYTES = 150 * 1024;
const MAX_FRAME_SIZE_BYTES = 200 * 1024;
const MAX_PROCESSING_MS = 30000;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createSampleVideo() {
  await new Promise((resolve, reject) => {
    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=duration=5:size=1280x720:rate=30",
        "-pix_fmt",
        "yuv420p",
        SAMPLE_PATH,
      ],
      { cwd: ROOT_DIR, stdio: "ignore" },
    );

    ffmpeg.once("error", () => {
      reject(new Error("没有找到 ffmpeg，无法运行浏览器烟雾测试。"));
    });
    ffmpeg.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`ffmpeg 生成测试视频失败，退出码 ${code}。`));
    });
  });
}

async function startDevServer() {
  const viteEntry = path.join(ROOT_DIR, "node_modules", "vite", "bin", "vite.js");
  const server = spawn(
    process.execPath,
    [viteEntry, "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
    {
      cwd: ROOT_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let combinedOutput = "";

  server.stdout.on("data", (chunk) => {
    combinedOutput += chunk.toString();
  });

  server.stderr.on("data", (chunk) => {
    combinedOutput += chunk.toString();
  });

  for (let index = 0; index < 30; index += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Vite 启动失败：\n${combinedOutput}`);
    }

    try {
      const response = await fetch(`http://127.0.0.1:${PORT}`);

      if (response.ok) {
        return { server, combinedOutputRef: () => combinedOutput };
      }
    } catch {}

    await wait(500);
  }

  server.kill();
  throw new Error(`Vite 启动超时：\n${combinedOutput}`);
}

async function inspectZipFrameSizes(savePath) {
  const zipBuffer = await fs.readFile(savePath);
  const zip = await JSZip.loadAsync(zipBuffer);
  const frameEntries = Object.values(zip.files).filter(
    (entry) => !entry.dir && entry.name.endsWith(".jpg"),
  );

  if (frameEntries.length === 0) {
    throw new Error("烟雾测试失败，ZIP 内没有找到导出的 JPG 帧。");
  }

  const frameBuffers = await Promise.all(
    frameEntries.map((entry) => entry.async("uint8array")),
  );
  const frameSizes = frameBuffers.map((buffer) => buffer.byteLength);
  const maxFrameBytes = Math.max(...frameSizes);
  const framesOverHardTarget = frameSizes.filter((size) => size > MAX_FRAME_SIZE_BYTES).length;
  const framesWithinSoftTarget = frameSizes.filter((size) => size <= TARGET_FRAME_SIZE_BYTES).length;

  if (framesOverHardTarget > 0) {
    throw new Error(
      `烟雾测试失败，仍有 ${framesOverHardTarget} 张帧图超过 ${MAX_FRAME_SIZE_BYTES} B。`,
    );
  }

  return {
    frameCount: frameEntries.length,
    maxFrameBytes,
    framesWithinSoftTarget,
  };
}

async function runSmokeTest() {
  await createSampleVideo();
  const { server, combinedOutputRef } = await startDevServer();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ acceptDownloads: true });
  const downloadDir = await fs.mkdtemp(path.join(os.tmpdir(), "video-frames-smoke-"));
  const startedAt = performance.now();

  try {
    page.on("pageerror", (error) => {
      console.error("PAGE ERROR:", error.message);
    });

    await page.goto(`http://127.0.0.1:${PORT}`, { waitUntil: "networkidle" });
    await page.locator("#video-input").setInputFiles(SAMPLE_NAME);

    const download = await page.waitForEvent("download", {
      timeout: MAX_PROCESSING_MS + 10000,
    });
    const suggestedName = download.suggestedFilename();
    const savePath = path.join(downloadDir, suggestedName);

    await download.saveAs(savePath);

    const elapsedMs = Math.round(performance.now() - startedAt);
    const statusTitle = await page.locator("#status-title").textContent();
    const progressLabel = await page.locator("#progress-label").textContent();
    const progressValue = await page.locator("#progress-value").textContent();

    if (statusTitle?.trim() !== "处理完成") {
      throw new Error(`烟雾测试失败，页面未进入完成状态：${statusTitle}`);
    }

    if (progressLabel?.trim() !== "ZIP 已生成" || progressValue?.trim() !== "100%") {
      throw new Error(`烟雾测试失败，进度状态异常：${progressLabel} / ${progressValue}`);
    }

    if (elapsedMs > MAX_PROCESSING_MS) {
      throw new Error(`烟雾测试失败，总处理时长 ${elapsedMs} ms，超过 ${MAX_PROCESSING_MS} ms。`);
    }

    const zipStats = await inspectZipFrameSizes(savePath);

    console.log(
      `Smoke test passed: ${suggestedName}, ${zipStats.frameCount} frames, max ${zipStats.maxFrameBytes} B, ${zipStats.framesWithinSoftTarget} frames <= 150 KB, elapsed ${elapsedMs} ms`,
    );
  } finally {
    await browser.close();
    server.kill();
    await wait(500);
    await fs.rm(downloadDir, { recursive: true, force: true });
    await fs.rm(SAMPLE_PATH, { force: true });

    if (combinedOutputRef().trim()) {
      console.log(combinedOutputRef().trim());
    }
  }
}

runSmokeTest().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

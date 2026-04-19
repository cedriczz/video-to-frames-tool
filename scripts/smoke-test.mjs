import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import JSZip from "jszip";
import { chromium } from "playwright";

const ROOT_DIR = process.cwd();
const SAMPLE_NAME = "sample-smoke.mp4";
const SAMPLE_PATH = path.join(ROOT_DIR, SAMPLE_NAME);
const MAX_PROCESSING_MS = 30000;
const SIZE_TOLERANCE_BYTES = 1024;
let activePort = 4173;
const PRESET_CASES = [
  {
    id: "150k",
    label: "150K",
    hardMaxBytes: 200 * 1024,
  },
  {
    id: "500k",
    label: "500K",
    hardMaxBytes: 500 * 1024,
  },
  {
    id: "none",
    label: "不压缩",
    hardMaxBytes: null,
  },
];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("无法分配测试端口。")));
        return;
      }

      const { port } = address;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }

        resolve(port);
      });
    });
  });
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
        "-vf",
        "noise=alls=18:allf=t+u",
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

async function startDevServer(port) {
  const viteEntry = path.join(ROOT_DIR, "node_modules", "vite", "bin", "vite.js");
  const server = spawn(
    process.execPath,
    [viteEntry, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
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
      const response = await fetch(`http://127.0.0.1:${port}`);

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
  const totalFrameBytes = frameSizes.reduce((sum, size) => sum + size, 0);
  const averageFrameBytes = Math.round(totalFrameBytes / frameSizes.length);

  return {
    frameCount: frameEntries.length,
    maxFrameBytes,
    averageFrameBytes,
  };
}

async function runExportCase(browser, downloadDir, presetCase) {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const startedAt = performance.now();

  try {
    page.on("pageerror", (error) => {
      console.error(`[${presetCase.label}] PAGE ERROR:`, error.message);
    });

    await page.goto(`http://127.0.0.1:${activePort}`, { waitUntil: "networkidle" });
    await page
      .locator(`input[name="compression-preset"][value="${presetCase.id}"]`)
      .check({ force: true });
    await page.locator("#video-input").setInputFiles(SAMPLE_NAME);

    const download = await page.waitForEvent("download", {
      timeout: MAX_PROCESSING_MS + 10000,
    });
    const suggestedName = download.suggestedFilename();
    const savePath = path.join(downloadDir, `${presetCase.id}-${suggestedName}`);

    await download.saveAs(savePath);

    const elapsedMs = Math.round(performance.now() - startedAt);
    const statusTitle = await page.locator("#status-title").textContent();
    const progressLabel = await page.locator("#progress-label").textContent();
    const progressValue = await page.locator("#progress-value").textContent();
    const compressionMeta = await page.locator("#meta-compression").textContent();

    if (statusTitle?.trim() !== "处理完成") {
      throw new Error(`[${presetCase.label}] 页面未进入完成状态：${statusTitle}`);
    }

    if (progressLabel?.trim() !== "ZIP 已生成" || progressValue?.trim() !== "100%") {
      throw new Error(`[${presetCase.label}] 进度状态异常：${progressLabel} / ${progressValue}`);
    }

    if (elapsedMs > MAX_PROCESSING_MS) {
      throw new Error(
        `[${presetCase.label}] 总处理时长 ${elapsedMs} ms，超过 ${MAX_PROCESSING_MS} ms。`,
      );
    }

    const zipStats = await inspectZipFrameSizes(savePath);

    if (presetCase.hardMaxBytes && zipStats.maxFrameBytes > presetCase.hardMaxBytes) {
      throw new Error(
        `[${presetCase.label}] 存在帧图超过 ${presetCase.hardMaxBytes} B，最大 ${zipStats.maxFrameBytes} B。`,
      );
    }

    return {
      presetCase,
      elapsedMs,
      compressionMeta: compressionMeta?.trim() ?? "",
      zipStats,
    };
  } finally {
    await context.close();
  }
}

function assertCompressionOrdering(resultsById) {
  const average150 = resultsById["150k"].zipStats.averageFrameBytes;
  const average500 = resultsById["500k"].zipStats.averageFrameBytes;
  const averageNone = resultsById.none.zipStats.averageFrameBytes;

  if (average500 + SIZE_TOLERANCE_BYTES < average150) {
    throw new Error(
      `500K 档平均帧大小 ${average500} B 反而小于 150K 档 ${average150} B。`,
    );
  }

  if (averageNone + SIZE_TOLERANCE_BYTES < average500) {
    throw new Error(
      `不压缩档平均帧大小 ${averageNone} B 反而小于 500K 档 ${average500} B。`,
    );
  }
}

async function runSmokeTest() {
  await createSampleVideo();
  activePort = await getAvailablePort();
  const { server, combinedOutputRef } = await startDevServer(activePort);
  const browser = await chromium.launch({ headless: true });
  const downloadDir = await fs.mkdtemp(path.join(os.tmpdir(), "video-frames-smoke-"));

  try {
    const results = [];

    for (const presetCase of PRESET_CASES) {
      const result = await runExportCase(browser, downloadDir, presetCase);
      results.push(result);
    }

    const resultsById = Object.fromEntries(results.map((result) => [result.presetCase.id, result]));

    assertCompressionOrdering(resultsById);

    console.log(
      [
        "Smoke test passed:",
        ...results.map(
          (result) =>
            `${result.presetCase.label} max ${result.zipStats.maxFrameBytes} B, avg ${result.zipStats.averageFrameBytes} B, elapsed ${result.elapsedMs} ms`,
        ),
      ].join(" "),
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

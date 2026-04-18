# Video To Frames Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a pure-browser local tool that converts a dropped video into fixed-24-FPS JPG sequence frames and downloads them as a ZIP.

**Architecture:** Use a small Vite-powered vanilla frontend. Browser-native `video` + `canvas` handle decoding and frame capture, while `JSZip` packages the generated JPG files into a downloadable ZIP with deterministic sequential naming.

**Tech Stack:** Vite, vanilla JavaScript, HTML5 video, Canvas API, JSZip, CSS

---

### Task 1: Scaffold The Browser App

**Files:**
- Create: `package.json`
- Create: `index.html`
- Create: `src/main.js`
- Create: `src/styles.css`
- Create: `README.md`

- [ ] **Step 1: Create package scripts**

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  }
}
```

- [ ] **Step 2: Build the single-page shell**

```html
<main class="app-card">
  <section class="hero">...</section>
  <section class="tool-grid">...</section>
</main>
```

- [ ] **Step 3: Add the core status UI**

```js
const statusTitle = document.querySelector("#status-title");
const progressBarFill = document.querySelector("#progress-bar-fill");
```

- [ ] **Step 4: Add responsive styling**

```css
.tool-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.08fr) minmax(320px, 0.92fr);
}
```

- [ ] **Step 5: Verify the page loads**

Run: `npm run dev`
Expected: Vite starts and the page renders with a drag-and-drop area.

### Task 2: Implement File Intake And Progress State

**Files:**
- Modify: `src/main.js`
- Modify: `src/styles.css`

- [ ] **Step 1: Wire drag-and-drop and file selection**

```js
dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  extractFromFileList(event.dataTransfer.files);
});
```

- [ ] **Step 2: Validate the selected file**

```js
function isVideoFile(file) {
  return file.type.startsWith("video/") || /\.(mp4|mov|m4v|webm)$/i.test(file.name);
}
```

- [ ] **Step 3: Reflect file metadata placeholders**

```js
metaOutput.textContent = `${baseName}_24fps_frames.zip`;
```

- [ ] **Step 4: Add busy and error states**

```js
function setErrorState(message) {
  statusTitle.textContent = "处理失败";
  progressNote.textContent = message;
}
```

- [ ] **Step 5: Verify UI transitions**

Run: `npm run dev`
Expected: Selecting a file updates the metadata cards and progress area immediately.

### Task 3: Implement 24 FPS Extraction And ZIP Packaging

**Files:**
- Create: `src/extractor.js`
- Create: `src/utils.js`
- Modify: `src/main.js`

- [ ] **Step 1: Add naming and download helpers**

```js
export function formatFrameName(baseName, index) {
  return `${baseName}_${String(index).padStart(6, "0")}.jpg`;
}
```

- [ ] **Step 2: Build a hidden video loader**

```js
function createHiddenVideo(file) {
  const video = document.createElement("video");
  video.src = URL.createObjectURL(file);
  return video;
}
```

- [ ] **Step 3: Seek the video on 1/24 second intervals**

```js
for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
  const targetTime = frameIndex / fps;
  await seekVideo(video, targetTime);
}
```

- [ ] **Step 4: Draw each frame to canvas and append to ZIP**

```js
context.drawImage(video, 0, 0, width, height);
zip.file(`${archiveRoot}${frameName}`, frameBlob, { binary: true });
```

- [ ] **Step 5: Generate the ZIP blob and trigger download**

```js
const zipBlob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
downloadBlob(zipBlob, archiveName);
```

### Task 4: Add Launch Convenience And Basic Documentation

**Files:**
- Create: `start.bat`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-04-18-video-to-frames-design.md`

- [ ] **Step 1: Add a one-click Windows launcher**

```bat
if not exist node_modules (
  call npm install
)
call npm run dev -- --host 127.0.0.1 --open
```

- [ ] **Step 2: Document the usage flow**

```md
1. 打开网页
2. 把视频拖进页面
3. 等待 ZIP 自动下载
```

- [ ] **Step 3: Document format and browser boundaries**

```md
- 推荐浏览器：Chrome / Edge
- 推荐格式：MP4(H.264)、WebM
```

- [ ] **Step 4: Build the production bundle**

```bash
npm run build
```

- [ ] **Step 5: Smoke test the built output**

Run: `npm run preview`
Expected: The built app opens, accepts a video, and reaches the download step.

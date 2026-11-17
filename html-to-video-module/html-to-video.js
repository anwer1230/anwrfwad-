// html-to-video.js
import { readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createRenderJob, executeRenderJob } from "@hyperframes/producer";

const PRESET_RESOLUTIONS = new Map([
  ["1920x1080", "landscape"],
  ["1080x1920", "portrait"],
  ["1080x1080", "square"],
  ["3840x2160", "landscape-4k"],
  ["2160x3840", "portrait-4k"],
  ["2160x2160", "square-4k"],
  ["2560x1440", "landscape-1440p"],
  ["1440x2560", "portrait-1440p"],
  ["1440x1440", "square-1440p"],
  ["1280x720", "landscape-720p"],
  ["720x1280", "portrait-720p"],
  ["720x720", "square-720p"],
  ["854x480", "landscape-480p"],
  ["480x854", "portrait-480p"],
  ["480x480", "square-480p"],
]);

/**
 * يهيئ كود HTML ليتوافق مع محرك @hyperframes/producer مع ضمان:
 * - إزالة هوامش body الافتراضية
 * - تطابق أبعاد العرض والارتفاع بدقة (data-width / data-height)
 * - تحديد مدة التكوين (data-duration) عند غيابها
 * - انتظار جاهزية الصفحة والخطوط (document.fonts.ready)
 */
export function prepareHtmlComposition(
  rawHtml,
  {
    width = 1920,
    height = 1080,
    durationSeconds = 5,
    removeMargins = true,
    waitForFonts = true,
  } = {}
) {
  let html = String(rawHtml || "");
  if (!html.trim()) {
    throw new Error("محتوى HTML فارغ.");
  }

  // ضمان أبعاد زوجية لتوافق ترميز H.264/VP9 (yuv420p)
  const evenWidth = Math.max(64, Math.round(Number(width) || 1920) & ~1 || 1920);
  const evenHeight = Math.max(64, Math.round(Number(height) || 1080) & ~1 || 1080);
  const safeDuration = Math.max(0.5, Number(durationSeconds) || 5);

  if (!/<html[\s>]/i.test(html)) {
    html = `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8" /></head><body>${html}</body></html>`;
  }

  // حقن CSS لمنع الهوامش البيضاء ومطابقة منفذ العرض بدقة
  const resetCss = removeMargins
    ? `<style id="hf-studio-reset">html,body{margin:0 !important;padding:0 !important;width:100% !important;height:100% !important;overflow:hidden !important;}</style>`
    : "";

  const fontReadyScript = waitForFonts
    ? `<script id="hf-studio-fonts-ready">(function(){try{if(document.fonts&&document.fonts.ready){document.fonts.ready.catch(function(){});}}catch(e){}})();</script>`
    : "";

  if (/<\/head>/i.test(html)) {
    html = html.replace(/<\/head>/i, `${resetCss}${fontReadyScript}</head>`);
  } else if (/<body[\s>]/i.test(html)) {
    html = html.replace(/<body([^>]*)>/i, `<head><meta charset="UTF-8" />${resetCss}${fontReadyScript}</head><body$1>`);
  } else {
    html = `${resetCss}${fontReadyScript}${html}`;
  }

  // إذا كان HTML يحتوي مسبقاً على data-composition-id نحدّث أبعاده إذا لم تكن محددة
  if (/data-composition-id\s*=/i.test(html)) {
    if (!/data-width\s*=/i.test(html)) {
      html = html.replace(
        /data-composition-id=(["'][^"']*["'])/i,
        `data-composition-id=$1 data-width="${evenWidth}" data-height="${evenHeight}"`
      );
    }
    if (!/data-duration\s*=/i.test(html)) {
      html = html.replace(
        /data-composition-id=(["'][^"']*["'])/i,
        `data-composition-id=$1 data-duration="${safeDuration}"`
      );
    }
    return html;
  }

  // حقن سمات التكوين مباشرة على body أو تغليف المحتوى عند عدم وجود body
  if (/<body([^>]*)>/i.test(html)) {
    html = html.replace(/<body([^>]*)>/i, (full, attrs) => {
      const cleanAttrs = attrs || "";
      const hasStart = /data-start\s*=/i.test(cleanAttrs);
      const startAttr = hasStart ? "" : ' data-start="0"';
      return `<body${cleanAttrs} data-composition-id="studio-root"${startAttr} data-duration="${safeDuration}" data-width="${evenWidth}" data-height="${evenHeight}">`;
    });
  } else {
    html = `<div data-composition-id="studio-root" data-start="0" data-duration="${safeDuration}" data-width="${evenWidth}" data-height="${evenHeight}" style="width:100vw;height:100vh;margin:0;padding:0;overflow:hidden;">${html}</div>`;
  }

  return html;
}

/**
 * يحوّل ملف HTML إلى فيديو MP4 (أو WebM / MOV / GIF / PNG Sequence) بأبعاد ومعدل إطارات دقيق.
 *
 * @param {Object} options
 * @param {string} options.inputPath - مسار ملف HTML المراد تحويله
 * @param {string} options.outputPath - مسار ملف الفيديو الناتج (مثلاً "./output.mp4")
 * @param {number} [options.width=1920] - عرض الفيديو بالبكسل
 * @param {number} [options.height=1080] - ارتفاع الفيديو بالبكسل
 * @param {number} [options.fps=30] - معدل الإطارات في الثانية
 * @param {number} [options.duration=5] - مدة الفيديو بالثواني (تُستخدم إذا لم يحدد HTML مدة صريحة)
 * @param {number} [options.deviceScaleFactor=1] - معامل التكبير (مثل 2 لإخراج 4K من تخطيط 1080p)
 * @param {string} [options.quality="standard"] - جودة الترميز ("draft", "standard", "high")
 * @param {string} [options.format="mp4"] - صيغة الإخراج ("mp4", "webm", "mov", "gif", "png-sequence")
 * @param {string} [options.videoFrameFormat="auto"] - تنسيق استخراج الإطارات ("auto", "jpg", "png")
 * @param {boolean} [options.removeMargins=true] - إزالة هوامش body الافتراضية تلقائياً
 * @param {Function} [options.onProgress] - دالة تُستدعى مع نسبة التقدم (0-100) والرسالة
 * @returns {Promise<Object>} نتيجة العملية (المسار، المدة، الأبعاد، عدد الإطارات، الحجم)
 */
export async function renderHtmlToVideo({
  inputPath,
  outputPath,
  width = 1920,
  height = 1080,
  fps = 30,
  duration = 5,
  deviceScaleFactor = 1,
  quality = "standard",
  format = "mp4",
  videoFrameFormat = "auto",
  removeMargins = true,
  onProgress,
}) {
  if (!inputPath || !outputPath) {
    throw new Error("يجب تحديد مسار الإدخال (inputPath) ومسار الإخراج (outputPath).");
  }

  const absInputPath = resolve(inputPath);
  const absOutputPath = resolve(outputPath);
  const projectDir = dirname(absInputPath);
  const entryName = basename(absInputPath);

  const dpr = Math.max(1, Math.min(3, Math.round(Number(deviceScaleFactor) || 1)));
  const targetWidth = Math.max(64, Math.round(Number(width) || 1920) & ~1 || 1920);
  const targetHeight = Math.max(64, Math.round(Number(height) || 1080) & ~1 || 1080);
  const layoutWidth = dpr > 1 ? Math.max(64, Math.round(targetWidth / dpr) & ~1 || targetWidth) : targetWidth;
  const layoutHeight = dpr > 1 ? Math.max(64, Math.round(targetHeight / dpr) & ~1 || targetHeight) : targetHeight;

  const rawHtml = await readFile(absInputPath, "utf-8");
  const preparedHtml = prepareHtmlComposition(rawHtml, {
    width: layoutWidth,
    height: layoutHeight,
    durationSeconds: duration,
    removeMargins,
    waitForFonts: true,
  });

  // نكتب نسخة مهيأة مؤقتاً بجانب الملف الأصلي للحفاظ على المسارات النسبية داخل projectDir
  const workEntryName = `.hf-prepared-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${entryName}`;
  const workEntryPath = join(projectDir, workEntryName);

  await mkdir(dirname(absOutputPath), { recursive: true });
  await writeFile(workEntryPath, preparedHtml, "utf-8");

  const validQuality = ["draft", "standard", "high"].includes(quality) ? quality : "standard";
  const validFormat = ["mp4", "webm", "mov", "gif", "png-sequence"].includes(format) ? format : "mp4";
  const validFrameFmt = ["auto", "jpg", "png"].includes(videoFrameFormat) ? videoFrameFormat : "auto";
  const safeFps = Math.max(1, Math.min(60, Math.round(Number(fps) || 30)));

  // تفعيل outputResolution تلقائياً عند مطابقة دقة 4K / 1440p / DPR مضاعف
  const targetPresetKey = `${targetWidth}x${targetHeight}`;
  const outputResolution = dpr > 1 ? PRESET_RESOLUTIONS.get(targetPresetKey) : undefined;

  const jobConfig = {
    fps: safeFps,
    quality: validQuality,
    format: validFormat,
    videoFrameFormat: validFrameFmt,
    entryFile: workEntryName,
    strictness: "best-effort",
    workers: 1,
    ...(outputResolution ? { outputResolution } : {}),
  };

  const startedAt = Date.now();
  try {
    const job = createRenderJob(jobConfig);

    await executeRenderJob(job, projectDir, absOutputPath, (currentJob, message) => {
      if (onProgress) {
        const rawProgress = typeof currentJob?.progress === "number" ? currentJob.progress : 0;
        const percent = rawProgress <= 1 ? Math.round(rawProgress * 100) : Math.min(100, Math.round(rawProgress));
        onProgress(percent, message || currentJob?.currentStage || "");
      }
    });

    let fileSize = 0;
    try {
      const st = await stat(absOutputPath);
      fileSize = st.size || 0;
    } catch {
      fileSize = 0;
    }

    const elapsedMs = Date.now() - startedAt;
    return {
      success: true,
      outputPath: absOutputPath,
      width: job.perfSummary?.resolution?.width || targetWidth,
      height: job.perfSummary?.resolution?.height || targetHeight,
      fps: safeFps,
      format: validFormat,
      quality: validQuality,
      duration: elapsedMs,
      compositionDurationSeconds: job.duration || job.perfSummary?.compositionDurationSeconds || duration,
      frameCount: job.totalFrames || job.framesRendered || job.perfSummary?.totalFrames || null,
      fileSize,
      stages: job.perfSummary?.stages || {},
    };
  } finally {
    await rm(workEntryPath, { force: true }).catch(() => {});
  }
}

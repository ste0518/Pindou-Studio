"use client";
/* eslint-disable @next/next/no-img-element -- The source preview uses a local Blob URL, which the image optimizer cannot load. */

import { ChangeEvent, DragEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Bead, MARD_221_PALETTE, rgbToOklab } from "./palette";

type Cell = Bead | null;
type EditorTool = "brush" | "eraser" | "eyedropper";
type BackgroundMode = "keep" | "transparent" | "colour" | "ai";
type BackgroundRemovalResult = { data: Uint8ClampedArray; width: number; height: number };
type BackgroundSegmenter = (image: HTMLCanvasElement) => Promise<BackgroundRemovalResult[]>;
const PALETTE = MARD_221_PALETTE;
const DRAFT_KEY = "pindou-workshop-draft-v1";
const MIN_GRID_SIDE = 8;
const MAX_GRID_SIDE = 160;
const DEFAULT_DETAIL = 64;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const paletteOrder = (code: string) => PALETTE.findIndex((bead) => bead.code === code);

function dimensionsForAspect(aspect: number, longSide: number) {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const longest = Math.max(MIN_GRID_SIDE, Math.min(MAX_GRID_SIDE, Math.round(longSide)));
  if (safeAspect >= 1) {
    return { columns: longest, rows: Math.max(MIN_GRID_SIDE, Math.min(MAX_GRID_SIDE, Math.round(longest / safeAspect))) };
  }
  return { columns: Math.max(MIN_GRID_SIDE, Math.min(MAX_GRID_SIDE, Math.round(longest * safeAspect))), rows: longest };
}

function aspectLabel(aspect: number) {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  let numerator = 1;
  let denominator = 1;
  let difference = Infinity;
  for (let divisor = 1; divisor <= 12; divisor += 1) {
    const candidate = Math.max(1, Math.round(safeAspect * divisor));
    const delta = Math.abs(candidate / divisor - safeAspect);
    if (delta < difference) {
      numerator = candidate;
      denominator = divisor;
      difference = delta;
    }
  }
  const greatestCommonDivisor = (first: number, second: number): number => second ? greatestCommonDivisor(second, first % second) : first;
  const divisor = greatestCommonDivisor(numerator, denominator);
  return `${numerator / divisor} : ${denominator / divisor}`;
}

async function readExifOrientation(file: File) {
  if (file.type !== "image/jpeg") return 1;
  try {
    const view = new DataView(await file.slice(0, 128 * 1024).arrayBuffer());
    if (view.byteLength < 4 || view.getUint16(0, false) !== 0xffd8) return 1;
    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      const marker = view.getUint16(offset, false);
      offset += 2;
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
      const length = view.getUint16(offset, false);
      if (length < 2 || offset + length > view.byteLength) break;
      const segmentStart = offset + 2;
      if (marker === 0xffe1 && segmentStart + 14 <= view.byteLength && view.getUint32(segmentStart, false) === 0x45786966) {
        const tiffStart = segmentStart + 6;
        const littleEndian = view.getUint16(tiffStart, false) === 0x4949;
        if (view.getUint16(tiffStart + 2, littleEndian) !== 0x002a) return 1;
        const directoryStart = tiffStart + view.getUint32(tiffStart + 4, littleEndian);
        const entries = view.getUint16(directoryStart, littleEndian);
        for (let index = 0; index < entries; index += 1) {
          const entry = directoryStart + 2 + index * 12;
          if (entry + 12 > view.byteLength) break;
          if (view.getUint16(entry, littleEndian) === 0x0112) return view.getUint16(entry + 8, littleEndian);
        }
      }
      offset += length;
    }
  } catch {
    // If metadata is absent or malformed, browsers can still read the photo normally.
  }
  return 1;
}

function drawExifOrientedImage(context: CanvasRenderingContext2D, image: HTMLImageElement, orientation: number) {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  switch (orientation) {
    case 2: context.setTransform(-1, 0, 0, 1, width, 0); break;
    case 3: context.setTransform(-1, 0, 0, -1, width, height); break;
    case 4: context.setTransform(1, 0, 0, -1, 0, height); break;
    case 5: context.setTransform(0, 1, 1, 0, 0, 0); break;
    case 6: context.setTransform(0, 1, -1, 0, height, 0); break;
    case 7: context.setTransform(0, -1, -1, 0, height, width); break;
    case 8: context.setTransform(0, -1, 1, 0, 0, width); break;
    default: context.setTransform(1, 0, 0, 1, 0, 0);
  }
  context.drawImage(image, 0, 0);
}

function closestBead(red: number, green: number, blue: number, options: Bead[]) {
  const source = rgbToOklab(red, green, blue);
  return options.reduce((best, bead) => {
    const bestDistance = (source[0] - best.oklab[0]) ** 2 + (source[1] - best.oklab[1]) ** 2 + (source[2] - best.oklab[2]) ** 2;
    const distance = (source[0] - bead.oklab[0]) ** 2 + (source[1] - bead.oklab[1]) ** 2 + (source[2] - bead.oklab[2]) ** 2;
    return distance < bestDistance ? bead : best;
  });
}

function connectedBackgroundMask(data: Uint8ClampedArray, width: number, height: number, tolerance: number, subjectProtection: number) {
  const references = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]
    .map(([x, y]) => (x + y * width) * 4)
    .filter((index) => data[index + 3] > 24)
    .map((index) => rgbToOklab(data[index], data[index + 1], data[index + 2]));
  const mask = new Uint8Array(width * height);
  const checked = new Uint8Array(width * height);
  const queue: number[] = [];
  const labs = Array.from({ length: width * height }, (_, pixel) => {
    const index = pixel * 4;
    return rgbToOklab(data[index], data[index + 1], data[index + 2]);
  });
  const referenceDistance = (pixel: number) => Math.min(...references.map((reference) => {
    const colour = labs[pixel];
    return Math.hypot(colour[0] - reference[0], colour[1] - reference[1], colour[2] - reference[2]);
  }));
  const isProtectedCore = (pixel: number) => {
    const column = pixel % width;
    const row = Math.floor(pixel / width);
    const radius = 0.12 + Math.max(0, Math.min(100, subjectProtection)) * 0.0037;
    const horizontal = (column - (width - 1) / 2) / ((width - 1) / 2 || 1);
    const vertical = (row - (height - 1) / 2) / ((height - 1) / 2 || 1);
    return (horizontal / radius) ** 2 + (vertical / radius) ** 2 <= 1;
  };
  const isTransparent = (pixel: number) => data[pixel * 4 + 3] <= 24;
  const canRemove = (pixel: number) => {
    if (isTransparent(pixel)) return true;
    const distance = referenceDistance(pixel);
    if (distance > tolerance) return false;
    // Keep the likely subject core unless it is unmistakably the same as the border background.
    return !isProtectedCore(pixel) || distance <= tolerance * 0.42;
  };
  const canFlow = (from: number, to: number) => {
    if (!canRemove(to)) return false;
    if (isTransparent(from) || isTransparent(to)) return true;
    const first = labs[from];
    const second = labs[to];
    const localDifference = Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2]);
    // A foreground edge normally causes a colour jump; do not allow the mask to cross it.
    return localDifference <= Math.max(0.02, tolerance * 0.68) || referenceDistance(to) <= tolerance * 0.3;
  };
  for (let column = 0; column < width; column += 1) { queue.push(column, column + (height - 1) * width); }
  for (let row = 1; row < height - 1; row += 1) { queue.push(row * width, row * width + width - 1); }
  while (queue.length) {
    const pixel = queue.pop()!;
    if (checked[pixel]) continue;
    checked[pixel] = 1;
    if (!canRemove(pixel)) continue;
    mask[pixel] = 1;
    const column = pixel % width;
    const row = Math.floor(pixel / width);
    if (column > 0 && canFlow(pixel, pixel - 1)) queue.push(pixel - 1);
    if (column < width - 1 && canFlow(pixel, pixel + 1)) queue.push(pixel + 1);
    if (row > 0 && canFlow(pixel, pixel - width)) queue.push(pixel - width);
    if (row < height - 1 && canFlow(pixel, pixel + width)) queue.push(pixel + width);
  }
  return mask;
}

function alphaCoverage(canvas: HTMLCanvasElement, threshold = 96) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return 1;
  const alpha = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let visible = 0;
  for (let index = 3; index < alpha.length; index += 4) {
    if (alpha[index] >= threshold) visible += 1;
  }
  return visible / (canvas.width * canvas.height);
}

function sharpenTransparency(canvas: HTMLCanvasElement, low = 72, high = 184) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return;
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 3; index < imageData.data.length; index += 4) {
    const alpha = imageData.data[index];
    if (alpha <= low) imageData.data[index] = 0;
    else if (alpha >= high) imageData.data[index] = 255;
    else imageData.data[index] = Math.round(((alpha - low) / (high - low)) * 255);
  }
  context.putImageData(imageData, 0, 0);
}

type IconName = "upload" | "brush" | "eraser" | "eyedropper" | "undo" | "redo" | "sparkle" | "arrow";

type TemplateCategory = "全部" | "人物" | "动物" | "植物" | "日常";
type BeadTemplate = {
  id: string;
  category: Exclude<TemplateCategory, "全部">;
  name: string;
  description: string;
  detail: number;
  colours: number;
  difficulty: string;
  duration: string;
  seed: number;
};

const BEAD_TEMPLATES: BeadTemplate[] = [
  { id: "pet-portrait", category: "动物", name: "毛茸茸肖像", description: "适合猫狗正面照，保留眼神与毛色层次。", detail: 56, colours: 24, difficulty: "入门", duration: "约 2 小时", seed: 7 },
  { id: "flower-postcard", category: "植物", name: "花园明信片", description: "把一束花或绿植做成明亮的小尺寸装饰。", detail: 48, colours: 24, difficulty: "入门", duration: "约 1.5 小时", seed: 21 },
  { id: "portrait-frame", category: "人物", name: "人像纪念框", description: "适合半身照，推荐先用背景处理突出主体。", detail: 72, colours: 36, difficulty: "进阶", duration: "约 4 小时", seed: 43 },
  { id: "food-icon", category: "日常", name: "美食小图标", description: "甜点、咖啡与餐盘照片都能做成可爱摆件。", detail: 40, colours: 12, difficulty: "入门", duration: "约 1 小时", seed: 61 },
  { id: "wildlife-poster", category: "动物", name: "自然观察卡", description: "适合轮廓清楚的鸟类、昆虫或小动物照片。", detail: 80, colours: 36, difficulty: "进阶", duration: "约 5 小时", seed: 83 },
  { id: "travel-memory", category: "日常", name: "旅行记忆卡", description: "将地标、街景和旅行合照制作成收藏图纸。", detail: 64, colours: 36, difficulty: "进阶", duration: "约 3 小时", seed: 101 },
];

function ToolIcon({ name }: { name: IconName }) {
  const shapes: Record<IconName, ReactNode> = {
    upload: <><path d="M12 15V3m0 0-4 4m4-4 4 4" /><path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" /></>,
    brush: <><path d="m14.5 4.5 5 5" /><path d="m3 21 4.8-1.1L19.5 8.2a2.1 2.1 0 0 0-3-3L4.8 16.9 3 21Z" /><path d="M10 7.5 16.5 14" /></>,
    eraser: <><path d="m7 20-4-4a2 2 0 0 1 0-2.8l7.5-7.5a2 2 0 0 1 2.8 0l6 6a2 2 0 0 1 0 2.8L14 20H7Z" /><path d="m11 18 4-4" /></>,
    eyedropper: <><path d="m14.8 4.2 5 5" /><path d="m16.2 2.8 5 5-10 10-4.2 1.2 1.2-4.2 10-10a2 2 0 0 1 2.8 0Z" /><path d="M5 21h7" /></>,
    undo: <><path d="M9 7 4 12l5 5" /><path d="M4 12h10a6 6 0 0 1 6 6" /></>,
    redo: <><path d="m15 7 5 5-5 5" /><path d="M20 12H10a6 6 0 0 0-6 6" /></>,
    sparkle: <><path d="m12 3 1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6L12 3Z" /><path d="m19 17 .7 2.3L22 20l-2.3.7L19 23l-.7-2.3L16 20l2.3-.7L19 17Z" /></>,
    arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
  };
  return <span className="tool-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{shapes[name]}</svg></span>;
}

export default function Home() {
  const [projectName, setProjectName] = useState("未命名图纸");
  const [columns, setColumns] = useState(48);
  const [rows, setRows] = useState(48);
  const [detail, setDetail] = useState(DEFAULT_DETAIL);
  const [sourceAspect, setSourceAspect] = useState(1);
  const [exifOrientation, setExifOrientation] = useState(1);
  const [maxColors, setMaxColors] = useState(36);
  const [activeView, setActiveView] = useState<"pattern" | "source">("pattern");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [cells, setCells] = useState<Cell[]>([]);
  const [history, setHistory] = useState<Cell[][]>([]);
  const [future, setFuture] = useState<Cell[][]>([]);
  const [tool, setTool] = useState<EditorTool>("brush");
  const [selectedCode, setSelectedCode] = useState("A1");
  const [exportMessage, setExportMessage] = useState("");
  const [isExporting, setIsExporting] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [cropZoom, setCropZoom] = useState(100);
  const [cropOffsetX, setCropOffsetX] = useState(0);
  const [cropOffsetY, setCropOffsetY] = useState(0);
  const [backgroundMode, setBackgroundMode] = useState<BackgroundMode>("keep");
  const [backgroundCode, setBackgroundCode] = useState("H1");
  const [backgroundTolerance, setBackgroundTolerance] = useState(18);
  const [subjectProtection, setSubjectProtection] = useState(68);
  const [aiStatus, setAiStatus] = useState("");
  const [aiError, setAiError] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [lockedCodes, setLockedCodes] = useState<string[]>([]);
  const [generatedSignature, setGeneratedSignature] = useState("");
  const [generatedColumns, setGeneratedColumns] = useState(48);
  const [generatedRows, setGeneratedRows] = useState(48);
  const [draftMessage, setDraftMessage] = useState("");
  const [isLanding, setIsLanding] = useState(true);
  const [jumpRow, setJumpRow] = useState(1);
  const [jumpColumn, setJumpColumn] = useState(1);
  const [isDragging, setIsDragging] = useState(false);
  const [templateFilter, setTemplateFilter] = useState<TemplateCategory>("全部");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState("");
  const [focusedCell, setFocusedCell] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const cellsRef = useRef<Cell[]>([]);
  const isPainting = useRef(false);
  const aiSegmenter = useRef<BackgroundSegmenter | null>(null);
  const draftMessageTimer = useRef<number | undefined>(undefined);
  const exportMessageTimer = useRef<number | undefined>(undefined);
  const selectedTemplate = BEAD_TEMPLATES.find((template) => template.id === selectedTemplateId);
  const filteredTemplates = templateFilter === "全部" ? BEAD_TEMPLATES : BEAD_TEMPLATES.filter((template) => template.category === templateFilter);

  const counts = useMemo(() => {
    const map = new Map<string, { bead: Bead; count: number }>();
    cells.forEach((bead) => {
      if (!bead) return;
      const existing = map.get(bead.code);
      map.set(bead.code, { bead, count: (existing?.count ?? 0) + 1 });
    });
    return [...map.values()].sort((a, b) => paletteOrder(a.bead.code) - paletteOrder(b.bead.code));
  }, [cells]);

  const recipeSignature = useMemo(() => JSON.stringify({ columns, rows, maxColors, rotation, cropZoom, cropOffsetX, cropOffsetY, backgroundMode, backgroundCode, backgroundTolerance, subjectProtection, lockedCodes: [...lockedCodes].sort() }), [backgroundCode, backgroundMode, backgroundTolerance, columns, cropOffsetX, cropOffsetY, cropZoom, lockedCodes, maxColors, rotation, rows, subjectProtection]);
  const requiresRegeneration = Boolean(cells.length && generatedSignature !== recipeSignature);
  const displayAspect = rotation % 180 === 0 ? sourceAspect : 1 / sourceAspect;

  const applyDetail = (nextDetail: number, nextSourceAspect = sourceAspect, nextRotation = rotation) => {
    const rotatedAspect = nextRotation % 180 === 0 ? nextSourceAspect : 1 / nextSourceAspect;
    const planned = dimensionsForAspect(rotatedAspect, nextDetail);
    setDetail(nextDetail);
    setColumns(planned.columns);
    setRows(planned.rows);
  };

  const removeBackgroundWithAI = async (source: HTMLCanvasElement) => {
    setAiError("");
    if (!aiSegmenter.current) {
      setAiStatus("正在准备 AI 人像分割模型…");
      const { pipeline } = await import("@huggingface/transformers");
      aiSegmenter.current = await pipeline("background-removal", "Xenova/modnet", {
        progress_callback: (progress: { status?: string; progress?: number }) => {
          const percentage = Number.isFinite(progress.progress) ? ` ${Math.round(progress.progress!)}%` : "";
          setAiStatus(progress.status === "ready" ? "AI 模型已就绪，正在识别人物…" : `正在下载 AI 模型${percentage}`);
        },
      }) as unknown as BackgroundSegmenter;
    }
    setAiStatus("正在识别人物、头发和衣物轮廓…");
    const [result] = await aiSegmenter.current(source);
    const output = document.createElement("canvas");
    output.width = result.width;
    output.height = result.height;
    const outputContext = output.getContext("2d");
    if (!outputContext) throw new Error("无法创建 AI 图像画布");
    outputContext.putImageData(new ImageData(new Uint8ClampedArray(result.data), result.width, result.height), 0, 0);
    return output;
  };

  const showDraftMessage = (message: string) => {
    if (draftMessageTimer.current) window.clearTimeout(draftMessageTimer.current);
    setDraftMessage(message);
    if (message) draftMessageTimer.current = window.setTimeout(() => setDraftMessage(""), 3500);
  };

  const showExportMessage = (message: string) => {
    if (exportMessageTimer.current) window.clearTimeout(exportMessageTimer.current);
    setExportMessage(message);
    if (message) exportMessageTimer.current = window.setTimeout(() => setExportMessage(""), 3500);
  };

  const handleFile = (file?: File) => {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setUploadError("请选择 JPG、PNG 或 WebP 图片。");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setUploadError("图片超过 15 MB，请压缩后再试。");
      return;
    }
    if (cellsRef.current.length && !window.confirm("更换图片会清空当前图纸和未保存的编辑。是否继续？")) return;
    void (async () => {
      const orientation = await readExifOrientation(file);
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        const orientationSwapsSides = [5, 6, 7, 8].includes(orientation);
        const nextSourceAspect = orientationSwapsSides ? image.naturalHeight / image.naturalWidth : image.naturalWidth / image.naturalHeight;
        if (imageUrl) URL.revokeObjectURL(imageUrl);
        setSourceAspect(nextSourceAspect);
        setExifOrientation(orientation);
        applyDetail(selectedTemplate?.detail ?? DEFAULT_DETAIL, nextSourceAspect, 0);
        setImageUrl(url);
        cellsRef.current = [];
        setCells([]);
        setHistory([]);
        setFuture([]);
        setRotation(0);
        setCropZoom(100);
        setCropOffsetX(0);
        setCropOffsetY(0);
        setAiStatus("");
        setAiError("");
        setUploadError("");
        showDraftMessage("");
        setGeneratedSignature("");
        setGeneratedColumns(dimensionsForAspect(nextSourceAspect, selectedTemplate?.detail ?? DEFAULT_DETAIL).columns);
        setGeneratedRows(dimensionsForAspect(nextSourceAspect, selectedTemplate?.detail ?? DEFAULT_DETAIL).rows);
        setActiveView("source");
        setIsLanding(false);
        window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        setUploadError("这张图片无法读取，请换一张 JPG、PNG 或 WebP 图片。");
      };
      image.src = url;
    })();
  };

  const selectFile = (event: ChangeEvent<HTMLInputElement>) => {
    handleFile(event.target.files?.[0]);
    event.target.value = "";
  };

  const startFromTemplate = (template: BeadTemplate) => {
    setSelectedTemplateId(template.id);
    setProjectName(template.name);
    setMaxColors(template.colours);
    setDetail(template.detail);
    fileInput.current?.click();
  };

  const commitCells = (next: Cell[]) => {
    const current = cellsRef.current;
    if (current.length === next.length && current.every((bead, index) => bead === next[index])) return;
    setHistory((previous) => [...previous.slice(-49), current]);
    setFuture([]);
    cellsRef.current = next;
    setCells(next);
  };

  const undo = () => {
    const previous = history.at(-1);
    if (!previous) return;
    setFuture((next) => [cellsRef.current, ...next].slice(0, 50));
    cellsRef.current = previous;
    setCells(previous);
    setHistory((current) => current.slice(0, -1));
  };

  const redo = () => {
    const next = future[0];
    if (!next) return;
    setHistory((previous) => [...previous.slice(-49), cellsRef.current]);
    cellsRef.current = next;
    setCells(next);
    setFuture((current) => current.slice(1));
  };

  const editCell = (index: number) => {
    const current = cellsRef.current;
    const cell = current[index];
    if (tool === "eyedropper") {
      if (cell) { setSelectedCode(cell.code); setTool("brush"); }
      return;
    }
    const replacement = tool === "eraser" ? null : PALETTE.find((bead) => bead.code === selectedCode) ?? PALETTE[0];
    if (cell === replacement) return;
    const next = [...current];
    next[index] = replacement;
    commitCells(next);
  };

  const toggleLockedColour = () => {
    setLockedCodes((current) => current.includes(selectedCode) ? current.filter((code) => code !== selectedCode) : [...current, selectedCode]);
  };

  const saveDraft = () => {
    if (!cells.length) { showDraftMessage("请先生成图纸"); return; }
    const draft = { projectName, columns, rows, detail, sourceAspect, generatedColumns, generatedRows, maxColors, rotation, cropZoom, cropOffsetX, cropOffsetY, backgroundMode, backgroundCode, backgroundTolerance, subjectProtection, lockedCodes, cells: cells.map((bead) => bead?.code ?? null), generatedSignature };
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    showDraftMessage("草稿已保存在本机");
  };

  const jumpToGrid = () => {
    const stage = stageRef.current;
    if (!stage) return;
    const targetTop = Math.max(0, ((Math.min(generatedRows, Math.max(1, jumpRow)) - 1) / generatedRows) * stage.scrollHeight - stage.clientHeight / 3);
    const targetLeft = Math.max(0, ((Math.min(generatedColumns, Math.max(1, jumpColumn)) - 1) / generatedColumns) * stage.scrollWidth - stage.clientWidth / 3);
    stage.scrollTo({ top: targetTop, left: targetLeft, behavior: "smooth" });
  };

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      if (event.shiftKey) redo(); else undo();
    };
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  });

  useEffect(() => {
    const restoreTimer = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem(DRAFT_KEY);
        if (!saved) return;
        const draft = JSON.parse(saved) as { projectName: string; columns: number; rows: number; detail?: number; sourceAspect?: number; generatedColumns?: number; generatedRows?: number; maxColors: number; rotation: number; cropZoom: number; cropOffsetX: number; cropOffsetY: number; backgroundMode: BackgroundMode; backgroundCode: string; backgroundTolerance: number; subjectProtection?: number; lockedCodes: string[]; cells: Array<string | null>; generatedSignature?: string };
        const restoredCells = draft.cells.map((code) => code ? PALETTE.find((bead) => bead.code === code) ?? null : null);
        if (!restoredCells.length) return;
        let restoredGeneratedColumns = draft.generatedColumns ?? draft.columns;
        let restoredGeneratedRows = draft.generatedRows ?? draft.rows;
        if (restoredGeneratedColumns * restoredGeneratedRows !== restoredCells.length) {
          const squareSide = Math.sqrt(restoredCells.length);
          if (Number.isInteger(squareSide)) {
            restoredGeneratedColumns = squareSide;
            restoredGeneratedRows = squareSide;
          } else if (restoredCells.length % draft.rows === 0) {
            restoredGeneratedColumns = restoredCells.length / draft.rows;
            restoredGeneratedRows = draft.rows;
          }
        }
        // A recovered draft has no source image. Show the exact saved drawing as the current
        // state instead of presenting a disabled "regenerate" action with mismatched settings.
        const restoredSignature = JSON.stringify({ columns: restoredGeneratedColumns, rows: restoredGeneratedRows, maxColors: draft.maxColors, rotation: 0, cropZoom: 100, cropOffsetX: 0, cropOffsetY: 0, backgroundMode: draft.backgroundMode, backgroundCode: draft.backgroundCode, backgroundTolerance: draft.backgroundTolerance, subjectProtection: draft.subjectProtection ?? 68, lockedCodes: [...draft.lockedCodes].sort() });
        setProjectName(draft.projectName); setColumns(restoredGeneratedColumns); setRows(restoredGeneratedRows); setDetail(Math.max(restoredGeneratedColumns, restoredGeneratedRows)); setSourceAspect(restoredGeneratedColumns / restoredGeneratedRows); setGeneratedColumns(restoredGeneratedColumns); setGeneratedRows(restoredGeneratedRows); setMaxColors(draft.maxColors); setRotation(0); setCropZoom(100); setCropOffsetX(0); setCropOffsetY(0); setBackgroundMode(draft.backgroundMode); setBackgroundCode(draft.backgroundCode); setBackgroundTolerance(draft.backgroundTolerance); setSubjectProtection(draft.subjectProtection ?? 68); setLockedCodes(draft.lockedCodes); cellsRef.current = restoredCells; setCells(restoredCells); setGeneratedSignature(restoredSignature); showDraftMessage("已恢复本机草稿；请重新上传原图后再改图纸设置。"); setIsLanding(false);
      } catch { window.localStorage.removeItem(DRAFT_KEY); }
    }, 0);
    return () => window.clearTimeout(restoreTimer);
  }, []);

  const generate = () => {
    if (!imageUrl || isGenerating) return;
    if (history.length && !window.confirm("重新生成会覆盖你手动修改过的格子。是否继续？")) return;
    setIsGenerating(true);
    setAiError("");
    const image = new Image();
    image.onload = async () => {
      try {
      const exifSwapsSides = [5, 6, 7, 8].includes(exifOrientation);
      const normalized = document.createElement("canvas");
      normalized.width = exifSwapsSides ? image.naturalHeight : image.naturalWidth;
      normalized.height = exifSwapsSides ? image.naturalWidth : image.naturalHeight;
      const normalizedContext = normalized.getContext("2d");
      if (!normalizedContext) return;
      drawExifOrientedImage(normalizedContext, image, exifOrientation);

      const prepared = document.createElement("canvas");
      const rotated = rotation % 180 !== 0;
      prepared.width = rotated ? normalized.height : normalized.width;
      prepared.height = rotated ? normalized.width : normalized.height;
      const preparedContext = prepared.getContext("2d");
      if (!preparedContext) return;
      preparedContext.translate(prepared.width / 2, prepared.height / 2);
      preparedContext.rotate((rotation * Math.PI) / 180);
      preparedContext.drawImage(normalized, -normalized.width / 2, -normalized.height / 2);

      const canvas = document.createElement("canvas");
      canvas.width = columns;
      canvas.height = rows;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;
      const cropRatio = cropZoom / 100;
      const cropWidth = prepared.width / cropRatio;
      const cropHeight = prepared.height / cropRatio;
      const availableX = prepared.width - cropWidth;
      const availableY = prepared.height - cropHeight;
      const sourceX = Math.max(0, Math.min(availableX, availableX / 2 + (cropOffsetX / 100) * (availableX / 2)));
      const sourceY = Math.max(0, Math.min(availableY, availableY / 2 + (cropOffsetY / 100) * (availableY / 2)));
      if (backgroundMode !== "keep") {
        // Detect the background before reducing the image to a small bead grid.
        // At this resolution, a subject edge has enough information to act as a barrier.
        const analysisScale = Math.max(4, Math.min(10, Math.floor(800 / Math.max(columns, rows)) || 4));
        const analysisWidth = columns * analysisScale;
        const analysisHeight = rows * analysisScale;
        const analysisCanvas = document.createElement("canvas");
        analysisCanvas.width = analysisWidth;
        analysisCanvas.height = analysisHeight;
        const analysisContext = analysisCanvas.getContext("2d", { willReadFrequently: true });
        if (!analysisContext) return;
        analysisContext.drawImage(prepared, sourceX, sourceY, cropWidth, cropHeight, 0, 0, analysisWidth, analysisHeight);
        if (backgroundMode === "ai") {
          try {
            const aiOutput = await removeBackgroundWithAI(analysisCanvas);
            const coverage = alphaCoverage(aiOutput);
            // Close-up portraits can legitimately fill almost the whole frame, so only reject
            // truly empty or unchanged masks. This avoids silently discarding good results.
            if (coverage < 0.005 || coverage > 0.995) {
              setAiError("AI 没有识别出可分离的背景，已保留原图。请换用背景更清楚的人像，或使用“快速删除”。");
              setAiStatus("AI 结果不适用，已保留原图");
            } else {
              sharpenTransparency(aiOutput);
              setAiStatus(`AI 人像分割完成 · 保留主体约 ${Math.round(alphaCoverage(aiOutput) * 100)}%`);
              analysisContext.clearRect(0, 0, analysisWidth, analysisHeight);
              analysisContext.drawImage(aiOutput, 0, 0, analysisWidth, analysisHeight);
            }
          } catch (error) {
            setAiError("AI 人像分割暂时不可用，已改用“快速删除”（非 AI）生成图纸。请检查网络后重试。");
            setAiStatus("AI 未成功加载 · 当前使用快速删除");
            const analysisImageData = analysisContext.getImageData(0, 0, analysisWidth, analysisHeight);
            const analysisData = analysisImageData.data;
            const backgroundMask = connectedBackgroundMask(analysisData, analysisWidth, analysisHeight, backgroundTolerance / 500, subjectProtection);
            backgroundMask.forEach((isBackground, pixel) => {
              if (isBackground) analysisData[pixel * 4 + 3] = 0;
            });
            analysisContext.putImageData(analysisImageData, 0, 0);
            console.warn("AI background removal failed", error);
          }
        } else {
          const analysisImageData = analysisContext.getImageData(0, 0, analysisWidth, analysisHeight);
          const analysisData = analysisImageData.data;
          const backgroundMask = connectedBackgroundMask(analysisData, analysisWidth, analysisHeight, backgroundTolerance / 500, subjectProtection);
          const replacement = PALETTE.find((bead) => bead.code === backgroundCode) ?? PALETTE[0];
          backgroundMask.forEach((isBackground, pixel) => {
            if (!isBackground) return;
            const index = pixel * 4;
            if (backgroundMode === "transparent") analysisData[index + 3] = 0;
            else { analysisData[index] = replacement.rgb[0]; analysisData[index + 1] = replacement.rgb[1]; analysisData[index + 2] = replacement.rgb[2]; analysisData[index + 3] = 255; }
          });
          analysisContext.putImageData(analysisImageData, 0, 0);
        }
        context.imageSmoothingEnabled = true;
        context.drawImage(analysisCanvas, 0, 0, columns, rows);
      } else {
        context.imageSmoothingEnabled = false;
        context.drawImage(prepared, sourceX, sourceY, cropWidth, cropHeight, 0, 0, columns, rows);
      }
      const imageData = context.getImageData(0, 0, columns, rows);
      const data = imageData.data;
      const initialMatches: Cell[] = [];
      for (let pixel = 0; pixel < data.length; pixel += 4) {
        initialMatches.push(data[pixel + 3] < 24 ? null : closestBead(data[pixel], data[pixel + 1], data[pixel + 2], PALETTE));
      }
      const preliminaryCounts = new Map<string, number>();
      initialMatches.forEach((bead) => bead && preliminaryCounts.set(bead.code, (preliminaryCounts.get(bead.code) ?? 0) + 1));
      const locked = PALETTE.filter((bead) => lockedCodes.includes(bead.code));
      const remainingSlots = Math.max(0, Math.max(2, maxColors) - locked.length);
      const candidates = maxColors === PALETTE.length ? PALETTE : [...locked, ...[...preliminaryCounts.entries()]
        .filter(([code]) => !lockedCodes.includes(code))
        .sort(([, first], [, second]) => second - first)
        .slice(0, remainingSlots)
        .map(([code]) => PALETTE.find((bead) => bead.code === code)!)]
        .sort((first, second) => paletteOrder(first.code) - paletteOrder(second.code));
      const allMatches = initialMatches.map((bead, index) => bead ? closestBead(data[index * 4], data[index * 4 + 1], data[index * 4 + 2], candidates) : null);
      cellsRef.current = allMatches;
      setCells(allMatches);
      setHistory([]);
      setFuture([]);
      setActiveView("pattern");
      setGeneratedColumns(columns);
      setGeneratedRows(rows);
      setGeneratedSignature(recipeSignature);
      setJumpRow(1);
      setJumpColumn(1);
      window.setTimeout(() => stageRef.current?.scrollTo({ top: 0, left: 0 }), 0);
      } catch (error) {
        setAiError(error instanceof Error ? `生成失败：${error.message}` : "生成失败，请更换图片后重试。");
      } finally {
        setIsGenerating(false);
      }
    };
    image.onerror = () => {
      setAiError("图片读取失败，请重新上传后再试。");
      setIsGenerating(false);
    };
    image.src = imageUrl;
  };

  const nonEmpty = cells.filter(Boolean).length;
  const estimatedMinutes = Math.max(15, Math.ceil(nonEmpty / 140) * 5);
  const previewCellSize = Math.min(14, Math.max(4, 760 / Math.max(generatedColumns, generatedRows)));
  const gridStyle = { gridTemplateColumns: `repeat(${generatedColumns}, minmax(0, 1fr))`, gridAutoRows: "1fr", aspectRatio: `${generatedColumns} / ${generatedRows}` };
  const previewBaseWidth = Math.max(120, Math.round(generatedColumns * previewCellSize));
  const previewBaseHeight = Math.round(previewBaseWidth * generatedRows / generatedColumns);
  const previewWidth = Math.round(previewBaseWidth * zoom / 100);
  const cellFontSize = Math.max(2.5, Math.min(9, (previewWidth / generatedColumns) * 0.54));
  const sourcePreviewWidth = Math.round(Math.min(760, Math.max(120, 475 * displayAspect)));
  const selectedBead = PALETTE.find((bead) => bead.code === selectedCode) ?? PALETTE[0];

  const fitGridToStage = () => {
    const stageWidth = stageRef.current?.clientWidth ?? previewBaseWidth + 82;
    const stageHeight = stageRef.current?.clientHeight ?? previewBaseHeight + 82;
    // Rulers and the canvas padding need room too; fit both wide and tall drawings.
    const availableScale = Math.min((stageWidth - 82) / previewBaseWidth, (stageHeight - 82) / previewBaseHeight);
    const fitted = Math.floor(Math.min(100, Math.max(25, availableScale * 100)) / 5) * 5;
    setZoom(fitted || 25);
    window.requestAnimationFrame(() => stageRef.current?.scrollTo({ top: 0, left: 0, behavior: "smooth" }));
  };

  const moveGridFocus = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex = index;
    if (event.key === "ArrowLeft") nextIndex = Math.max(0, index - 1);
    else if (event.key === "ArrowRight") nextIndex = Math.min(cells.length - 1, index + 1);
    else if (event.key === "ArrowUp") nextIndex = Math.max(0, index - generatedColumns);
    else if (event.key === "ArrowDown") nextIndex = Math.min(cells.length - 1, index + generatedColumns);
    else if (event.key === "Home") nextIndex = Math.floor(index / generatedColumns) * generatedColumns;
    else if (event.key === "End") nextIndex = Math.min(cells.length - 1, Math.floor(index / generatedColumns) * generatedColumns + generatedColumns - 1);
    else return;
    event.preventDefault();
    setFocusedCell(nextIndex);
    window.requestAnimationFrame(() => document.getElementById(`bead-cell-${nextIndex}`)?.focus());
  };

  const goToLanding = () => {
    setIsLanding(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const enterStudio = () => {
    setIsLanding(false);
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  };

  const exportPng = () => {
    if (!cells.length || isExporting) return;
    setIsExporting(true);
    showExportMessage("正在准备 PNG…");
    const cellSize = Math.max(20, Math.min(42, Math.floor(3200 / Math.max(generatedColumns, generatedRows))));
    const pagePadding = 90;
    const rulerSize = 48;
    const headerHeight = 160;
    const gridWidth = generatedColumns * cellSize;
    const gridHeight = generatedRows * cellSize;
    const legendColumns = Math.min(5, Math.max(2, Math.floor((gridWidth + rulerSize) / 440)));
    const legendRows = Math.ceil(counts.length / legendColumns);
    const legendHeight = 38 + legendRows * 68;
    const outputWidth = gridWidth + rulerSize + pagePadding * 2;
    const outputHeight = headerHeight + rulerSize + gridHeight + rulerSize + legendHeight + 68;
    const canvas = document.createElement("canvas");
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      setIsExporting(false);
      showExportMessage("无法创建 PNG，请刷新后重试。");
      return;
    }

    const gridX = pagePadding + rulerSize;
    const gridY = headerHeight + rulerSize;
    const readableText = (bead: Bead) => (bead.rgb[0] * 0.299 + bead.rgb[1] * 0.587 + bead.rgb[2] * 0.114 > 155 ? "#162018" : "#ffffff");
    const drawText = (text: string, x: number, y: number, font: string, color = "#202326", align: CanvasTextAlign = "left") => {
      context.font = font;
      context.fillStyle = color;
      context.textAlign = align;
      context.textBaseline = "middle";
      context.fillText(text, x, y);
    };

    context.fillStyle = "#fbfcf8";
    context.fillRect(0, 0, outputWidth, outputHeight);
    context.fillStyle = "#c9ef43";
    context.fillRect(pagePadding, 48, 12, 56);
    drawText(projectName || "未命名图纸", pagePadding + 28, 66, "700 36px Arial, PingFang SC, Microsoft YaHei");
    drawText("MARD 221 标准版拼豆色卡", pagePadding + 28, 101, "600 16px Arial, PingFang SC, Microsoft YaHei", "#5e665f");
    const details = `${generatedColumns} × ${generatedRows} 格   ·   ${counts.length} 种颜色   ·   ${nonEmpty.toLocaleString()} 颗豆`;
    drawText(details, outputWidth - pagePadding, 78, "700 16px Arial, PingFang SC, Microsoft YaHei", "#29302b", "right");
    drawText("每 5 格辅助线 · 每 10 格分区线 · 空白区域不计入用量", outputWidth - pagePadding, 105, "13px Arial, PingFang SC, Microsoft YaHei", "#747976", "right");

    cells.forEach((bead, index) => {
      const column = index % generatedColumns;
      const row = Math.floor(index / generatedColumns);
      const x = gridX + column * cellSize;
      const y = gridY + row * cellSize;
      context.fillStyle = bead?.hex ?? "#ffffff";
      context.fillRect(x, y, cellSize, cellSize);
    });

    for (let column = 0; column <= generatedColumns; column += 1) {
      context.beginPath();
      context.strokeStyle = column % 10 === 0 ? "#4d5950" : column % 5 === 0 ? "#7c877e" : "#d6dbd3";
      context.lineWidth = column % 10 === 0 ? 2 : column % 5 === 0 ? 1.25 : 0.55;
      context.moveTo(gridX + column * cellSize, gridY);
      context.lineTo(gridX + column * cellSize, gridY + gridHeight);
      context.stroke();
    }
    for (let row = 0; row <= generatedRows; row += 1) {
      context.beginPath();
      context.strokeStyle = row % 10 === 0 ? "#4d5950" : row % 5 === 0 ? "#7c877e" : "#d6dbd3";
      context.lineWidth = row % 10 === 0 ? 2 : row % 5 === 0 ? 1.25 : 0.55;
      context.moveTo(gridX, gridY + row * cellSize);
      context.lineTo(gridX + gridWidth, gridY + row * cellSize);
      context.stroke();
    }
    if (cellSize >= 18) {
      cells.forEach((bead, index) => {
        if (!bead) return;
        const column = index % generatedColumns;
        const row = Math.floor(index / generatedColumns);
        drawText(bead.code, gridX + column * cellSize + cellSize / 2, gridY + row * cellSize + cellSize / 2, `700 ${Math.max(8, Math.floor(cellSize * 0.32))}px Arial`, readableText(bead), "center");
      });
    }
    for (let column = 0; column < generatedColumns; column += 5) {
      const x = gridX + column * cellSize + cellSize / 2;
      drawText(String(column + 1), x, gridY - 20, "700 12px Arial", "#4e5951", "center");
      drawText(String(column + 1), x, gridY + gridHeight + 21, "700 12px Arial", "#4e5951", "center");
    }
    for (let row = 0; row < generatedRows; row += 5) {
      const y = gridY + row * cellSize + cellSize / 2;
      drawText(String(row + 1), gridX - 18, y, "700 12px Arial", "#4e5951", "center");
      drawText(String(row + 1), gridX + gridWidth + 18, y, "700 12px Arial", "#4e5951", "center");
    }

    const legendY = gridY + gridHeight + rulerSize + 28;
    drawText("色号用量清单", pagePadding, legendY, "700 21px Arial, PingFang SC, Microsoft YaHei");
    drawText("按 MARD 221 色卡顺序排列", outputWidth - pagePadding, legendY, "13px Arial, PingFang SC, Microsoft YaHei", "#747976", "right");
    const legendCardWidth = (outputWidth - pagePadding * 2 - (legendColumns - 1) * 12) / legendColumns;
    counts.forEach(({ bead, count }, index) => {
      const column = index % legendColumns;
      const row = Math.floor(index / legendColumns);
      const x = pagePadding + column * (legendCardWidth + 12);
      const y = legendY + 24 + row * 68;
      context.fillStyle = "#ffffff";
      context.strokeStyle = "#dfe4dc";
      context.lineWidth = 1;
      context.fillRect(x, y, legendCardWidth, 56);
      context.strokeRect(x, y, legendCardWidth, 56);
      context.fillStyle = bead.hex;
      context.fillRect(x + 10, y + 12, 32, 32);
      context.strokeStyle = "#00000022";
      context.strokeRect(x + 10, y + 12, 32, 32);
      drawText(bead.code, x + 53, y + 21, "700 14px Arial");
      drawText(bead.name, x + 53, y + 39, "11px Arial, PingFang SC, Microsoft YaHei", "#747976");
      drawText(`×${count}`, x + legendCardWidth - 12, y + 28, "700 15px Arial", "#202326", "right");
    });
    drawText("拼豆工坊 · 本图纸在浏览器本地生成", pagePadding, outputHeight - 29, "12px Arial, PingFang SC, Microsoft YaHei", "#747976");
    drawText("MARD 221", outputWidth - pagePadding, outputHeight - 29, "700 12px Arial", "#747976", "right");

    canvas.toBlob((blob) => {
      if (!blob) {
        setIsExporting(false);
        showExportMessage("PNG 生成失败，请减少图纸尺寸后重试。");
        return;
      }
      const link = document.createElement("a");
      const safeName = (projectName || "拼豆图纸").replace(/[\\/:*?\"<>|]/g, "-");
      const objectUrl = URL.createObjectURL(blob);
      link.href = objectUrl;
      link.download = `${safeName}-${generatedColumns}x${generatedRows}-MARD221.png`;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      setIsExporting(false);
      showExportMessage("PNG 已开始下载");
    }, "image/png");
  };

  return (
    <main className="app-shell" id="top">
      <header className="topbar">
        <button className="brand" onClick={goToLanding} aria-label="返回拼豆工坊首页"><span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /><i /><b>拼</b></span><span className="brand-copy"><strong>拼豆工坊</strong><small>本地拼豆图纸工作台</small></span></button>
        <nav className="main-nav" aria-label="主导航">{isLanding ? <><a className="active" href="#hero-upload">开始创作</a><a href="#inspiration-gallery">灵感</a><a href="#template-market">模板</a><a href="#colour-system">色卡</a></> : <><a className="active" href="#workspace">工作台</a><a href="#materials">用量清单</a></>}</nav>
        {isLanding ? <div className="top-actions landing-actions"><button className="nav-cta" onClick={() => fileInput.current?.click()}>上传图片 <ToolIcon name="arrow" /></button></div> : <><div className="project-field"><span>项目名称</span><input value={projectName} onChange={(event) => setProjectName(event.target.value)} aria-label="项目名称" /></div><div className="top-actions"><button className="quiet-button" onClick={saveDraft} aria-live="polite">{draftMessage || "保存草稿"}</button><button className="primary-button" onClick={exportPng} disabled={!cells.length || isExporting} aria-live="polite">{exportMessage || "导出 PNG"}</button></div></>}
      </header>
      <input ref={fileInput} className="global-file-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={selectFile} />
      {uploadError && <p className="upload-error" role="alert">{uploadError}</p>}

      {isLanding ? <><section className="landing-page" aria-labelledby="landing-title">
        <div className="landing-mesh" aria-hidden="true"><span /><span /><span /></div>
        <div className="landing-grid">
          <div className="landing-copy">
            <p className="hero-kicker"><ToolIcon name="sparkle" /> LOCAL BEAD STUDIO · 拼豆图纸生成器</p>
            <h1 id="landing-title">把照片变成<br /><em>可制作的<span>拼豆图纸</span></em></h1>
            <p className="hero-description">上传一张图片，匹配 MARD 221 色号，得到可编辑、可导出的拼豆施工图。</p>
            <div className="hero-actions">
              <button className="hero-cta" onClick={() => fileInput.current?.click()}><ToolIcon name="upload" />上传图片</button>
              <button className="hero-secondary" onClick={() => document.getElementById("inspiration-gallery")?.scrollIntoView({ behavior: "smooth" })}>浏览创作灵感 <ToolIcon name="arrow" /></button>
            </div>
            <div className="hero-note-row"><p className="hero-privacy">无需注册，图片始终留在你的设备上处理</p>{cells.length > 0 && <button className="hero-draft-link" onClick={enterStudio}>继续编辑草稿 <ToolIcon name="arrow" /></button>}</div>
            <div className="hero-metrics" id="how-it-works">
              <div><strong>221 种</strong><span>专业色彩体系</span></div><div><strong>本地处理</strong><span>原图不离开设备</span></div><div><strong>高清导出</strong><span>施工图纸即刻呈现</span></div>
            </div>
          </div>
          <div className="hero-visual">
            <div className="visual-glow glow-one" aria-hidden="true" /><div className="visual-glow glow-two" aria-hidden="true" />
            <div className="hero-preview-card" aria-hidden="true"><div className="preview-card-top"><span>图纸创作预览</span><i>色彩已就绪</i></div><div className="mini-pattern">{Array.from({ length: 100 }, (_, index) => <i key={index} style={{ backgroundColor: PALETTE[(index * 13 + Math.floor(index / 10) * 7) % PALETTE.length].hex }} />)}</div><div className="preview-card-footer"><span><b />MARD 221 色彩体系</span><strong>98 × 112</strong></div></div>
            <div className="hero-palette-card" id="colour-system"><span><b /> MARD 221</span><strong>专业色彩体系</strong><small>每一种颜色，都有真实可制作的归属。</small><div>{PALETTE.slice(18, 30).map((bead) => <i key={bead.code} style={{ backgroundColor: bead.hex }} />)}</div></div>
            <button id="hero-upload" className={`hero-upload-card ${isDragging ? "dragging" : ""}`} onClick={() => fileInput.current?.click()} onDragOver={(event: DragEvent) => { event.preventDefault(); setIsDragging(true); }} onDragLeave={() => setIsDragging(false)} onDrop={(event: DragEvent) => { event.preventDefault(); setIsDragging(false); handleFile(event.dataTransfer.files[0]); }}><span className="upload-orbit"><ToolIcon name="upload" /></span><strong>上传一张参考图片</strong><small>上传 · 调整 · 生成图纸</small></button>
          </div>
        </div>
      </section>

      <section className="landing-discovery" aria-label="模板与灵感">
        <section className="inspiration-gallery" id="inspiration-gallery" aria-labelledby="inspiration-title">
          <div className="discovery-heading"><div><p className="eyebrow">灵感画廊</p><h2 id="inspiration-title">把日常收藏成<br />可完成的小作品</h2></div><p>从宠物、花草到旅行瞬间，先找一个适合的构图，再上传自己的照片开始制作。</p></div>
          <div className="inspiration-grid">
            {BEAD_TEMPLATES.slice(0, 4).map((template) => <article className={`inspiration-card inspiration-${template.category}`} key={template.id}><div className="inspiration-mosaic" aria-hidden="true">{Array.from({ length: 36 }, (_, index) => <i key={index} style={{ backgroundColor: PALETTE[(template.seed + index * 11 + Math.floor(index / 6) * 5) % PALETTE.length].hex }} />)}</div><div><span>{template.category}灵感</span><h3>{template.name}</h3><p>{template.description}</p></div></article>)}
          </div>
        </section>

        <section className="template-market" id="template-market" aria-labelledby="template-title">
          <div className="discovery-heading"><div><p className="eyebrow">模板市场</p><h2 id="template-title">从合适的规格开始，<br />第一次就更好拼</h2></div><p>模板会预设推荐的图纸细节和用色数；选择后上传自己的照片即可应用，所有处理仍在本地完成。</p></div>
          <div className="template-filters" role="group" aria-label="筛选模板类别">{(["全部", "人物", "动物", "植物", "日常"] as TemplateCategory[]).map((category) => <button key={category} className={templateFilter === category ? "active" : ""} onClick={() => setTemplateFilter(category)} aria-pressed={templateFilter === category}>{category}</button>)}</div>
          <div className="template-grid">{filteredTemplates.map((template) => <article className={`template-card ${selectedTemplateId === template.id ? "selected" : ""}`} key={template.id}><div className="template-mosaic" aria-hidden="true">{Array.from({ length: 64 }, (_, index) => <i key={index} style={{ backgroundColor: PALETTE[(template.seed + index * 9 + Math.floor(index / 8) * 13) % PALETTE.length].hex }} />)}</div><div className="template-meta"><span>{template.category}</span><span>{template.difficulty}</span></div><h3>{template.name}</h3><p>{template.description}</p><div className="template-details"><span>{template.detail} 格细节</span><span>{template.colours} 色</span><span>{template.duration}</span></div><button onClick={() => startFromTemplate(template)}>用此模板创作 <ToolIcon name="arrow" /></button></article>)}</div>
        </section>
      </section></> : <section className={`workspace ${cells.length ? "has-pattern" : "awaiting-pattern"}`} id="workspace">
        <aside className="settings-panel">
          <div className="settings-intro"><span>第 2 步 · 设置图纸</span><h2>先确定规格，<br />再生成图纸</h2><p>图像和图纸都只在浏览器本地处理。</p><div className="settings-capabilities"><span>本地色彩匹配</span><span>MARD 221</span><span>精准网格</span></div></div>
          {cells.length > 0 && <div className="studio-summary" aria-label="图纸摘要"><div><span>当前图纸</span><strong>{generatedColumns} × {generatedRows}</strong><small>{requiresRegeneration ? "设置待重新生成" : "已是最新尺寸"}</small></div><div><span>色彩系统</span><strong>MARD 221</strong><small>{counts.length} 色已匹配</small></div><div><span>制作统计</span><strong>{nonEmpty.toLocaleString()} 颗</strong><small>拼豆总数量</small></div><div><span>预计时长</span><strong>约 {estimatedMinutes} 分钟</strong><small>按当前图纸估算</small></div></div>}
          <div className="section-heading"><span>图纸设置</span></div>
          <div
            className={`upload-box ${isDragging ? "dragging" : ""}`}
            onClick={() => fileInput.current?.click()}
            onDragOver={(event: DragEvent) => { event.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(event: DragEvent) => { event.preventDefault(); setIsDragging(false); handleFile(event.dataTransfer.files[0]); }}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); fileInput.current?.click(); } }}
          >
            <ToolIcon name="upload" /><strong>{imageUrl ? "更换图片" : "上传参考图片"}</strong><span>JPG、PNG、WebP · 本地处理</span>
          </div>

          <label className="control-label">图纸比例 <span>{columns} × {rows}</span></label>
          <div className="ratio-locked" role="status">
            <div className="ratio-size"><strong>{columns}</strong><i>×</i><strong>{rows}</strong></div>
            <div><b>已锁定原图比例</b><small>{aspectLabel(displayAspect)} · 尺寸将始终同步缩放</small></div>
          </div>
          <label className="control-label detail-label">细节密度 <span>长边 {detail} 格</span></label>
          <div className="slider-row"><span>粗糙</span><input type="range" min="16" max={MAX_GRID_SIDE} value={detail} onChange={(event) => applyDetail(Number(event.target.value))} aria-label="细节密度，向右更精细" /><span>精细</span></div>
          <p className="ratio-help">拖动细节密度会同时调整长和宽，比例始终与图片保持一致。</p>
          {requiresRegeneration && <div className="pending-generation" role="status"><span>待更新</span><p>当前画布仍保持 {generatedColumns} × {generatedRows}。按下重新生成后，才会应用 {columns} × {rows} 的新设置。</p></div>}

          <label className="control-label">最多使用颜色 <span>{maxColors} 色</span></label>
          <div className="colour-options">{[12, 24, 36, 60, 221].map((number) => <button key={number} onClick={() => setMaxColors(number)} className={maxColors === number ? "selected" : ""}>{number === 221 ? "完整" : number}</button>)}</div>

          <div className="generation-actions">
            {requiresRegeneration && <p className="pending-generation" role="status"><span>设置已更新</span>预览仍是旧图纸；重新生成后才会应用新设置。</p>}
            <button className="generate-button" onClick={generate} disabled={!imageUrl || isGenerating}><ToolIcon name="sparkle" /> {isGenerating ? (backgroundMode === "ai" ? "AI 正在识别人像…" : "正在生成图纸…") : requiresRegeneration ? "重新生成图纸" : cells.length ? "按当前设置重新生成" : "生成拼豆图纸"}</button>
            {!imageUrl && <p className="generation-help">先上传图片，即可使用推荐设置生成图纸。</p>}
          </div>

          {imageUrl && <details className="advanced-settings"><summary>高级调整 <span>裁剪、旋转与背景</span></summary><div className="advanced-settings-content"><div className="crop-section"><label className="control-label">裁剪与旋转 <span>实时预览</span></label><div className="rotation-row"><button onClick={() => setRotation((value) => { const next = (value + 270) % 360; applyDetail(detail, sourceAspect, next); return next; })} title="向左旋转 90 度">↶ 向左</button><span>{rotation === 0 ? "原始方向" : `已旋转 ${rotation}°`}</span><button onClick={() => setRotation((value) => { const next = (value + 90) % 360; applyDetail(detail, sourceAspect, next); return next; })} title="向右旋转 90 度">向右 ↷</button></div><label className="crop-slider"><span>放大取景</span><output>{cropZoom}%</output><input type="range" min="100" max="240" value={cropZoom} onChange={(event) => setCropZoom(Number(event.target.value))} /></label><label className="crop-slider"><span>横向移动</span><output>{cropOffsetX}</output><input type="range" min="-100" max="100" value={cropOffsetX} onChange={(event) => setCropOffsetX(Number(event.target.value))} /></label><label className="crop-slider"><span>纵向移动</span><output>{cropOffsetY}</output><input type="range" min="-100" max="100" value={cropOffsetY} onChange={(event) => setCropOffsetY(Number(event.target.value))} /></label><button className="reset-crop" onClick={() => { setRotation(0); applyDetail(detail, sourceAspect, 0); setCropZoom(100); setCropOffsetX(0); setCropOffsetY(0); }}>恢复原图</button></div>

          <div className="background-section"><label className="control-label">背景处理 <span>{backgroundMode === "keep" ? "保留" : backgroundMode === "ai" ? "AI 人像分割" : backgroundMode === "transparent" ? "快速主体保护" : `替换为 ${backgroundCode}`}</span></label><div className="background-options"><button onClick={() => setBackgroundMode("keep")} className={backgroundMode === "keep" ? "selected" : ""}>保留</button><button onClick={() => setBackgroundMode("transparent")} className={backgroundMode === "transparent" ? "selected" : ""}>快速删除</button><button onClick={() => setBackgroundMode("ai")} className={backgroundMode === "ai" ? "selected ai-selected" : ""}>AI 人像</button><button onClick={() => setBackgroundMode("colour")} className={backgroundMode === "colour" ? "selected" : ""}>指定色号</button></div>{backgroundMode === "ai" ? <div className="ai-removal-note" role="status"><strong>AI 人像分割</strong><span>{aiStatus || "适合单个、轮廓清楚的人像。首次使用会下载模型，图片不会上传；宠物、花草或物品请使用“快速删除”。"}</span></div> : backgroundMode !== "keep" && <><label className="crop-slider"><span>主体保护</span><output>{subjectProtection}%</output><input type="range" min="0" max="100" value={subjectProtection} onChange={(event) => setSubjectProtection(Number(event.target.value))} aria-label="主体保护强度，数值越高越不容易擦到人物" /></label><label className="crop-slider"><span>识别范围</span><output>{backgroundTolerance}</output><input type="range" min="8" max="55" value={backgroundTolerance} onChange={(event) => setBackgroundTolerance(Number(event.target.value))} aria-label="背景识别范围，数值越高删除越多" /></label>{backgroundMode === "colour" && <label className="background-colour"><span>背景色号</span><select value={backgroundCode} onChange={(event) => setBackgroundCode(event.target.value)}>{PALETTE.map((bead) => <option key={bead.code} value={bead.code}>{bead.code} · {bead.name}</option>)}</select></label>}<p>快速模式从画面边缘开始保守识别，并保护中央主体。人物仍被擦到时提高“主体保护”；背景残留时再提高“识别范围”。</p></>}</div></div></details>}
          {aiError && <p className="ai-removal-error" role="alert">{aiError}</p>}

          <div className="notice"><span>i</span><p>图纸会从 MARD 221 色卡中匹配颜色；你的图片和草稿都只保存在当前设备。</p></div>
          {lockedCodes.length > maxColors && <p className="lock-warning">已锁定 {lockedCodes.length} 色，会超过当前颜色上限。</p>}
        </aside>

        <aside className="tool-rail" aria-label="图纸编辑工具">
          <span className="tool-rail-label">创作</span>
          <button className={tool === "brush" ? "active" : ""} onClick={() => setTool("brush")} disabled={!cells.length} title="绘制：替换单个格子" aria-label="绘制"><ToolIcon name="brush" /><span>绘制</span></button>
          <button className={tool === "eraser" ? "active" : ""} onClick={() => setTool("eraser")} disabled={!cells.length} title="删除：清除单个格子" aria-label="删除"><ToolIcon name="eraser" /><span>删除</span></button>
          <button className={tool === "eyedropper" ? "active" : ""} onClick={() => setTool("eyedropper")} disabled={!cells.length} title="取色：读取格子的色号" aria-label="取色"><ToolIcon name="eyedropper" /><span>取色</span></button>
          <i aria-hidden="true" />
          <button onClick={undo} disabled={!history.length} title="撤销（⌘/Ctrl + Z）" aria-label="撤销"><ToolIcon name="undo" /><span>撤销</span></button>
          <button onClick={redo} disabled={!future.length} title="重做（⌘/Ctrl + Shift + Z）" aria-label="重做"><ToolIcon name="redo" /><span>重做</span></button>
        </aside>

        <div className="workbench-column">
        <section className="preview-panel">
          <div className="preview-toolbar"><div><div className="eyebrow">{cells.length ? "第 3 步 · 校对与编辑" : "第 3 步 · 预览结果"}</div><h1>{projectName || "未命名图纸"}</h1><p>{cells.length ? `${generatedColumns} × ${generatedRows} 格 · ${counts.length} 种颜色 · ${nonEmpty.toLocaleString()} 颗豆${requiresRegeneration ? " · 设置已更新，等待重新生成" : ""}` : imageUrl ? "已载入原图；确认设置后即可生成图纸。" : "先在右侧上传图片并设定图纸规格。"}</p></div><div className="view-switch"><button className={activeView === "pattern" ? "active" : ""} onClick={() => setActiveView("pattern")}>图纸</button><button className={activeView === "source" ? "active" : ""} onClick={() => setActiveView("source")} disabled={!imageUrl} title={!imageUrl ? "原图未随草稿保存，请重新上传图片后查看" : "查看原图"}>原图</button></div></div>
          {cells.length > 0 && !imageUrl && <p className="source-unavailable" role="status">原图未随本机草稿保存。重新上传图片后，可查看原图并重新生成图纸。</p>}
          {cells.length > 0 && <><div className="editor-toolbar colour-strip"><label className="colour-picker"><i style={{ backgroundColor: selectedBead.hex }} /><span>当前色号</span><select value={selectedCode} onChange={(event) => { setSelectedCode(event.target.value); setTool("brush"); }} aria-label="选择拼豆色号">{PALETTE.map((bead) => <option key={bead.code} value={bead.code}>{bead.code} · {bead.name}</option>)}</select></label><button className={`lock-colour ${lockedCodes.includes(selectedCode) ? "locked" : ""}`} onClick={toggleLockedColour}>{lockedCodes.includes(selectedCode) ? `已锁定 ${selectedCode}` : `锁定 ${selectedCode}`}</button><span className="edit-hint">点击或拖拽网格进行修改；键盘可用方向键移动焦点</span></div><div className="grid-navigator"><span>定位到</span><label>行<input type="number" inputMode="numeric" min="1" max={generatedRows} value={jumpRow} onChange={(event) => setJumpRow(Number(event.target.value))} /></label><label>列<input type="number" inputMode="numeric" min="1" max={generatedColumns} value={jumpColumn} onChange={(event) => setJumpColumn(Number(event.target.value))} /></label><button onClick={jumpToGrid}>跳转</button><button onClick={() => { setJumpRow(1); setJumpColumn(1); stageRef.current?.scrollTo({ top: 0, left: 0, behavior: "smooth" }); }}>回到左上</button><span className="colour-summary">实际使用：{counts.slice(0, 8).map(({ bead }) => bead.code).join("、")}{counts.length > 8 ? ` 等 ${counts.length} 色` : ""}</span></div><p className="sr-only" id="grid-keyboard-help">使用方向键在图纸中移动焦点，按 Enter 或空格键按当前工具编辑该格。</p></>}
          <div className="drafting-surface"><div className="canvas-stage" ref={stageRef}>
            {activeView === "source" && imageUrl ? <div className="source-crop-frame" style={{ width: `${sourcePreviewWidth}px`, aspectRatio: `${columns} / ${rows}` }}>{/* Local Blob URLs are intentionally rendered directly; they never leave the device. */}<img className="source-image" src={imageUrl} alt="上传的参考图片" style={{ transform: `translate(${(-cropOffsetX * (cropZoom - 100)) / 100}%, ${(-cropOffsetY * (cropZoom - 100)) / 100}%) rotate(${rotation}deg) scale(${cropZoom / 100})` }} /><div className="crop-frame-label">当前取景将用于生成图纸</div></div> : cells.length ? (
              <div className="pattern-wrap" style={{ width: previewWidth }}><div className="grid-ruler top-ruler">{Array.from({ length: Math.ceil(generatedColumns / 5) }, (_, index) => <span key={index}>{index * 5 + 1}</span>)}</div><div className="grid-ruler side-ruler">{Array.from({ length: Math.ceil(generatedRows / 5) }, (_, index) => <span key={index}>{index * 5 + 1}</span>)}</div><div className={`bead-grid editing-${tool}`} style={gridStyle} onPointerUp={() => { isPainting.current = false; }} onPointerLeave={() => { isPainting.current = false; }}>{cells.map((bead, index) => <button id={`bead-cell-${index}`} tabIndex={index === focusedCell ? 0 : -1} title={bead?.code ?? "透明区域"} aria-describedby="grid-keyboard-help" aria-label={`${bead?.code ?? "透明区域"}，${tool === "brush" ? "点击替换" : tool === "eraser" ? "点击删除" : "点击读取色号"}`} className={`bead-cell ${bead ? "" : "empty"} ${index % generatedColumns === 0 ? "major-left" : ""} ${Math.floor(index / generatedColumns) % 5 === 0 ? "major-top" : ""}`} key={index} style={{ backgroundColor: bead?.hex, fontSize: `${cellFontSize}px` }} onFocus={() => setFocusedCell(index)} onKeyDown={(event) => moveGridFocus(event, index)} onPointerDown={(event) => { event.preventDefault(); isPainting.current = true; editCell(index); }} onPointerEnter={() => { if (isPainting.current && tool !== "eyedropper") editCell(index); }} onClick={(event) => { if (event.detail === 0) editCell(index); }}>{bead?.code}</button>)}</div></div>
            ) : <div className="empty-state"><div className="empty-tiles"><i /><i /><i /><i /></div><h2>把照片变成可施工的拼豆图纸</h2><p>先上传图片，再选择网格尺寸与颜色数量。</p><button className="outline-button" onClick={() => fileInput.current?.click()}>选择图片</button></div>}
          </div>
          <div className="preview-footer"><span><b>10</b> 格分区线</span><span><b>5</b> 格辅助线</span><span>色号显示：开启</span><div className="zoom-controls" role="group" aria-label="图纸缩放"><button onClick={() => setZoom((value) => Math.max(25, value - 25))} disabled={zoom <= 25} aria-label="缩小图纸">−</button><input type="range" min="25" max="300" step="5" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} aria-label="图纸缩放比例" /><output aria-live="polite">{zoom}%</output><button onClick={() => setZoom((value) => Math.min(300, value + 25))} disabled={zoom >= 300} aria-label="放大图纸">＋</button><button className="fit-button" onClick={fitGridToStage}>适配视图</button></div></div></div>
        </section>
        <section className="stats-section" id="materials"><div className="stats-heading"><div><div className="eyebrow">用量统计</div><h2>需要准备的拼豆</h2></div><div className="stat-total"><span>总计</span><strong>{nonEmpty.toLocaleString()}</strong><em>颗</em></div></div>{counts.length ? <div className="legend-grid">{counts.map(({ bead, count }) => <div className="legend-card" key={bead.code}><i style={{ backgroundColor: bead.hex }} /><div><strong>{bead.code}</strong><span>{bead.name}</span></div><b>×{count}</b></div>)}</div> : <div className="legend-placeholder">生成图纸后，这里会自动列出每个色号及所需数量。</div>}</section>
        </div>
      </section>}
    </main>
  );
}

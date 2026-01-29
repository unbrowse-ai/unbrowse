/**
 * Browser-Use TypeScript Port - Screenshot Service
 *
 * Advanced screenshot processing for vision-capable LLMs.
 * Annotates screenshots with numbered element markers,
 * bounding boxes, and coordinate labels.
 *
 * Features:
 * - Element annotation with numbered labels
 * - Bounding box visualization
 * - Coordinate markers
 * - Screenshot resizing for LLM optimization
 * - Visual change detection
 */

import type { Page } from "playwright";
import type { InteractiveElement } from "./types.js";

/**
 * Screenshot annotation options
 */
export interface AnnotationOptions {
  /** Draw numbered labels on elements */
  drawLabels?: boolean;
  /** Draw bounding boxes around elements */
  drawBoxes?: boolean;
  /** Label font size (default: 12) */
  fontSize?: number;
  /** Label background color (default: red) */
  labelColor?: string;
  /** Label text color (default: white) */
  labelTextColor?: string;
  /** Box border color (default: red) */
  boxColor?: string;
  /** Box border width (default: 2) */
  boxWidth?: number;
  /** Only annotate new elements (marked with isNew) */
  newElementsOnly?: boolean;
  /** Maximum elements to annotate (default: 50) */
  maxElements?: number;
  /** Resize screenshot width for LLM (default: null = no resize) */
  resizeWidth?: number;
}

/**
 * Annotated screenshot result
 */
export interface AnnotatedScreenshot {
  /** Base64 encoded image data URL */
  imageDataUrl: string;
  /** Original dimensions */
  originalSize: { width: number; height: number };
  /** Final dimensions (after resize) */
  finalSize: { width: number; height: number };
  /** Number of elements annotated */
  elementCount: number;
  /** Element positions in the (possibly resized) image */
  elementPositions: Array<{
    index: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}

/**
 * Screenshot Service - Handles screenshot capture and annotation
 */
export class ScreenshotService {
  private page: Page;
  private defaultOptions: AnnotationOptions = {
    drawLabels: true,
    drawBoxes: true,
    fontSize: 12,
    labelColor: "#ff0000",
    labelTextColor: "#ffffff",
    boxColor: "#ff0000",
    boxWidth: 2,
    newElementsOnly: false,
    maxElements: 50,
    resizeWidth: undefined,
  };

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Take a screenshot with element annotations
   */
  async captureAnnotated(
    elements: InteractiveElement[],
    options: AnnotationOptions = {}
  ): Promise<AnnotatedScreenshot> {
    const opts = { ...this.defaultOptions, ...options };

    // Filter elements to annotate
    let elementsToAnnotate = elements;
    if (opts.newElementsOnly) {
      elementsToAnnotate = elements.filter(e => e.isNew);
    }
    elementsToAnnotate = elementsToAnnotate.slice(0, opts.maxElements);

    // Get viewport dimensions
    const viewport = await this.page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
    }));

    // Inject annotation overlay into page
    await this.page.evaluate(
      ({ elements, opts }) => {
        // Remove any existing annotations
        document.querySelectorAll("[data-bu-annotation]").forEach(el => el.remove());

        // Create annotation container
        const container = document.createElement("div");
        container.setAttribute("data-bu-annotation", "container");
        container.style.cssText = `
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          pointer-events: none;
          z-index: 2147483647;
        `;
        document.body.appendChild(container);

        for (const el of elements) {
          if (!el.boundingBox) continue;
          const { x, y, width, height } = el.boundingBox;

          // Skip elements outside viewport
          if (x + width < 0 || y + height < 0) continue;
          if (x > window.innerWidth || y > window.innerHeight) continue;

          // Draw bounding box
          if (opts.drawBoxes) {
            const box = document.createElement("div");
            box.setAttribute("data-bu-annotation", "box");
            box.style.cssText = `
              position: fixed;
              left: ${x}px;
              top: ${y}px;
              width: ${width}px;
              height: ${height}px;
              border: ${opts.boxWidth}px solid ${opts.boxColor};
              box-sizing: border-box;
              pointer-events: none;
            `;
            container.appendChild(box);
          }

          // Draw label
          if (opts.drawLabels) {
            const label = document.createElement("div");
            label.setAttribute("data-bu-annotation", "label");
            label.textContent = String(el.index);
            label.style.cssText = `
              position: fixed;
              left: ${Math.max(0, x - 2)}px;
              top: ${Math.max(0, y - opts.fontSize - 4)}px;
              background: ${opts.labelColor};
              color: ${opts.labelTextColor};
              font-size: ${opts.fontSize}px;
              font-family: Arial, sans-serif;
              font-weight: bold;
              padding: 1px 4px;
              border-radius: 3px;
              pointer-events: none;
              line-height: 1.2;
              min-width: 16px;
              text-align: center;
            `;
            container.appendChild(label);
          }
        }
      },
      {
        elements: elementsToAnnotate.map(e => ({
          index: e.index,
          boundingBox: e.boundingBox,
        })),
        opts,
      }
    );

    // Take screenshot
    const screenshotBuffer = await this.page.screenshot({
      type: "png",
      fullPage: false,
    });

    // Remove annotations from page
    await this.page.evaluate(() => {
      document.querySelectorAll("[data-bu-annotation]").forEach(el => el.remove());
    });

    // Calculate element positions (accounting for potential resize)
    const scale = opts.resizeWidth ? opts.resizeWidth / viewport.width : 1;
    const elementPositions = elementsToAnnotate
      .filter(e => e.boundingBox)
      .map(e => ({
        index: e.index,
        x: Math.round(e.boundingBox!.x * scale),
        y: Math.round(e.boundingBox!.y * scale),
        width: Math.round(e.boundingBox!.width * scale),
        height: Math.round(e.boundingBox!.height * scale),
      }));

    // Resize if needed (using canvas in browser)
    let finalBuffer = screenshotBuffer;
    let finalWidth = viewport.width;
    let finalHeight = viewport.height;

    if (opts.resizeWidth && opts.resizeWidth !== viewport.width) {
      const resized = await this.resizeImage(
        screenshotBuffer,
        opts.resizeWidth,
        Math.round(viewport.height * scale)
      );
      finalBuffer = resized.buffer;
      finalWidth = resized.width;
      finalHeight = resized.height;
    }

    const base64 = finalBuffer.toString("base64");

    return {
      imageDataUrl: `data:image/png;base64,${base64}`,
      originalSize: { width: viewport.width, height: viewport.height },
      finalSize: { width: finalWidth, height: finalHeight },
      elementCount: elementsToAnnotate.length,
      elementPositions,
    };
  }

  /**
   * Take a simple screenshot without annotations
   */
  async capture(fullPage = false): Promise<string> {
    const buffer = await this.page.screenshot({
      type: "png",
      fullPage,
    });
    return `data:image/png;base64,${buffer.toString("base64")}`;
  }

  /**
   * Capture screenshot with coordinate grid overlay
   */
  async captureWithGrid(gridSize = 100): Promise<string> {
    // Inject grid overlay
    await this.page.evaluate((size) => {
      const container = document.createElement("div");
      container.setAttribute("data-bu-annotation", "grid");
      container.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 2147483647;
      `;

      const width = window.innerWidth;
      const height = window.innerHeight;

      // Vertical lines
      for (let x = 0; x <= width; x += size) {
        const line = document.createElement("div");
        line.style.cssText = `
          position: fixed;
          left: ${x}px;
          top: 0;
          width: 1px;
          height: 100%;
          background: rgba(255, 0, 0, 0.3);
        `;
        container.appendChild(line);

        // Label
        const label = document.createElement("div");
        label.textContent = String(x);
        label.style.cssText = `
          position: fixed;
          left: ${x + 2}px;
          top: 2px;
          font-size: 10px;
          color: red;
          font-family: monospace;
        `;
        container.appendChild(label);
      }

      // Horizontal lines
      for (let y = 0; y <= height; y += size) {
        const line = document.createElement("div");
        line.style.cssText = `
          position: fixed;
          left: 0;
          top: ${y}px;
          width: 100%;
          height: 1px;
          background: rgba(255, 0, 0, 0.3);
        `;
        container.appendChild(line);

        // Label
        const label = document.createElement("div");
        label.textContent = String(y);
        label.style.cssText = `
          position: fixed;
          left: 2px;
          top: ${y + 2}px;
          font-size: 10px;
          color: red;
          font-family: monospace;
        `;
        container.appendChild(label);
      }

      document.body.appendChild(container);
    }, gridSize);

    // Capture
    const buffer = await this.page.screenshot({ type: "png" });

    // Remove grid
    await this.page.evaluate(() => {
      document.querySelectorAll("[data-bu-annotation='grid']").forEach(el => el.remove());
    });

    return `data:image/png;base64,${buffer.toString("base64")}`;
  }

  /**
   * Compare two screenshots and highlight differences
   */
  async compareScreenshots(
    before: string,
    after: string
  ): Promise<{ hasDifferences: boolean; diffPercentage: number }> {
    // Extract base64 data
    const beforeData = before.replace(/^data:image\/\w+;base64,/, "");
    const afterData = after.replace(/^data:image\/\w+;base64,/, "");

    // Compare in browser using canvas
    const result = await this.page.evaluate(
      async ({ beforeData, afterData }) => {
        const loadImage = (base64: string): Promise<HTMLImageElement> => {
          return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = `data:image/png;base64,${base64}`;
          });
        };

        const before = await loadImage(beforeData);
        const after = await loadImage(afterData);

        const width = Math.max(before.width, after.width);
        const height = Math.max(before.height, after.height);

        const canvas1 = document.createElement("canvas");
        canvas1.width = width;
        canvas1.height = height;
        const ctx1 = canvas1.getContext("2d")!;
        ctx1.drawImage(before, 0, 0);
        const data1 = ctx1.getImageData(0, 0, width, height).data;

        const canvas2 = document.createElement("canvas");
        canvas2.width = width;
        canvas2.height = height;
        const ctx2 = canvas2.getContext("2d")!;
        ctx2.drawImage(after, 0, 0);
        const data2 = ctx2.getImageData(0, 0, width, height).data;

        let diffPixels = 0;
        const totalPixels = width * height;

        for (let i = 0; i < data1.length; i += 4) {
          const diff =
            Math.abs(data1[i] - data2[i]) +
            Math.abs(data1[i + 1] - data2[i + 1]) +
            Math.abs(data1[i + 2] - data2[i + 2]);
          if (diff > 30) diffPixels++;
        }

        return {
          diffPixels,
          totalPixels,
        };
      },
      { beforeData, afterData }
    );

    const diffPercentage = (result.diffPixels / result.totalPixels) * 100;

    return {
      hasDifferences: diffPercentage > 1,
      diffPercentage: Math.round(diffPercentage * 100) / 100,
    };
  }

  /**
   * Resize image using sharp-like processing in browser
   */
  private async resizeImage(
    buffer: Buffer,
    targetWidth: number,
    targetHeight: number
  ): Promise<{ buffer: Buffer; width: number; height: number }> {
    const base64 = buffer.toString("base64");

    const resizedBase64 = await this.page.evaluate(
      async ({ base64, targetWidth, targetHeight }) => {
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = reject;
          img.src = `data:image/png;base64,${base64}`;
        });

        const canvas = document.createElement("canvas");
        canvas.width = targetWidth;
        canvas.height = targetHeight;

        const ctx = canvas.getContext("2d")!;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

        return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
      },
      { base64, targetWidth, targetHeight }
    );

    return {
      buffer: Buffer.from(resizedBase64, "base64"),
      width: targetWidth,
      height: targetHeight,
    };
  }

  /**
   * Get element at specific coordinates in screenshot
   */
  async getElementAtCoordinate(
    x: number,
    y: number,
    elements: InteractiveElement[]
  ): Promise<InteractiveElement | null> {
    for (const el of elements) {
      if (!el.boundingBox) continue;
      const { x: ex, y: ey, width, height } = el.boundingBox;
      if (x >= ex && x <= ex + width && y >= ey && y <= ey + height) {
        return el;
      }
    }
    return null;
  }

  /**
   * Generate a visual legend for annotated elements
   */
  generateLegend(elements: InteractiveElement[]): string {
    const lines: string[] = ["Element Legend:"];

    for (const el of elements.slice(0, 50)) {
      const label = el.ariaLabel || el.text || el.placeholder || el.href || "";
      const truncated = label.length > 40 ? label.slice(0, 37) + "..." : label;
      const pos = el.boundingBox
        ? `(${Math.round(el.boundingBox.x)},${Math.round(el.boundingBox.y)})`
        : "";
      lines.push(`[${el.index}] <${el.tagName}> ${truncated} ${pos}`);
    }

    return lines.join("\n");
  }

  /**
   * Update page reference
   */
  setPage(page: Page): void {
    this.page = page;
  }
}

/**
 * Create annotated screenshot helper for quick use
 */
export async function createAnnotatedScreenshot(
  page: Page,
  elements: InteractiveElement[],
  options?: AnnotationOptions
): Promise<AnnotatedScreenshot> {
  const service = new ScreenshotService(page);
  return service.captureAnnotated(elements, options);
}

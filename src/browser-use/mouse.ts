/**
 * Browser-Use TypeScript Port - Mouse Operations
 *
 * Handles mouse operations with proper coordinate transforms
 * for viewport scaling and device pixel ratio adjustments.
 */

import type { Page } from "playwright";

export interface Position {
  x: number;
  y: number;
}

export interface ViewportInfo {
  width: number;
  height: number;
  devicePixelRatio: number;
  scrollX: number;
  scrollY: number;
}

export interface MouseOptions {
  /** Duration of the move animation in milliseconds */
  moveDuration?: number;
  /** Number of steps for the move animation */
  moveSteps?: number;
  /** Delay after click in milliseconds */
  clickDelay?: number;
}

/**
 * Mouse class for coordinate-based operations
 */
export class Mouse {
  private page: Page;
  private currentPosition: Position = { x: 0, y: 0 };
  private viewportInfo: ViewportInfo | null = null;
  private llmViewportSize: { width: number; height: number } | null = null;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Set the LLM viewport size for coordinate conversion
   * When screenshots are resized for LLM, coordinates need to be scaled back
   */
  setLLMViewportSize(width: number, height: number): void {
    this.llmViewportSize = { width, height };
  }

  /**
   * Get current viewport information
   */
  async getViewportInfo(): Promise<ViewportInfo> {
    if (this.viewportInfo) return this.viewportInfo;

    this.viewportInfo = await this.page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    }));

    return this.viewportInfo;
  }

  /**
   * Invalidate cached viewport info (call after navigation/resize)
   */
  invalidateViewportCache(): void {
    this.viewportInfo = null;
  }

  /**
   * Convert LLM coordinates to actual viewport coordinates
   */
  async convertCoordinates(llmX: number, llmY: number): Promise<Position> {
    const viewport = await this.getViewportInfo();

    if (this.llmViewportSize) {
      // Scale from LLM viewport to actual viewport
      const scaleX = viewport.width / this.llmViewportSize.width;
      const scaleY = viewport.height / this.llmViewportSize.height;

      return {
        x: Math.round(llmX * scaleX),
        y: Math.round(llmY * scaleY),
      };
    }

    // No scaling needed
    return { x: llmX, y: llmY };
  }

  /**
   * Move mouse to position with optional animation
   */
  async move(x: number, y: number, options: MouseOptions = {}): Promise<void> {
    const { moveDuration = 100, moveSteps = 10 } = options;

    const targetPos = await this.convertCoordinates(x, y);

    if (moveDuration > 0 && moveSteps > 1) {
      // Animated move
      const startX = this.currentPosition.x;
      const startY = this.currentPosition.y;
      const deltaX = targetPos.x - startX;
      const deltaY = targetPos.y - startY;
      const stepDelay = moveDuration / moveSteps;

      for (let i = 1; i <= moveSteps; i++) {
        const progress = i / moveSteps;
        // Eased progress (ease-out)
        const easedProgress = 1 - Math.pow(1 - progress, 2);

        const currentX = startX + deltaX * easedProgress;
        const currentY = startY + deltaY * easedProgress;

        await this.page.mouse.move(currentX, currentY);
        await this.page.waitForTimeout(stepDelay);
      }
    } else {
      // Instant move
      await this.page.mouse.move(targetPos.x, targetPos.y);
    }

    this.currentPosition = targetPos;
  }

  /**
   * Click at coordinates
   */
  async click(
    x: number,
    y: number,
    options: MouseOptions & {
      button?: "left" | "right" | "middle";
      clickCount?: number;
    } = {}
  ): Promise<void> {
    const { button = "left", clickCount = 1, clickDelay = 50 } = options;

    // Move to position first
    await this.move(x, y, options);

    // Click
    await this.page.mouse.click(this.currentPosition.x, this.currentPosition.y, {
      button,
      clickCount,
      delay: clickDelay,
    });
  }

  /**
   * Double click at coordinates
   */
  async doubleClick(x: number, y: number, options: MouseOptions = {}): Promise<void> {
    await this.click(x, y, { ...options, clickCount: 2 });
  }

  /**
   * Right click at coordinates
   */
  async rightClick(x: number, y: number, options: MouseOptions = {}): Promise<void> {
    await this.click(x, y, { ...options, button: "right" });
  }

  /**
   * Drag from one position to another
   */
  async drag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    options: MouseOptions = {}
  ): Promise<void> {
    // Move to start position
    await this.move(fromX, fromY, options);

    // Press mouse button
    await this.page.mouse.down();

    // Move to end position
    await this.move(toX, toY, options);

    // Release mouse button
    await this.page.mouse.up();
  }

  /**
   * Scroll at current or specified position
   */
  async scroll(
    deltaX: number,
    deltaY: number,
    position?: Position
  ): Promise<void> {
    if (position) {
      const targetPos = await this.convertCoordinates(position.x, position.y);
      await this.page.mouse.move(targetPos.x, targetPos.y);
      this.currentPosition = targetPos;
    }

    await this.page.mouse.wheel(deltaX, deltaY);
    this.invalidateViewportCache(); // Scroll changes viewport
  }

  /**
   * Hover over position
   */
  async hover(x: number, y: number, options: MouseOptions = {}): Promise<void> {
    await this.move(x, y, options);
    // Brief pause to trigger hover effects
    await this.page.waitForTimeout(100);
  }

  /**
   * Get element at coordinates
   */
  async getElementAtPosition(x: number, y: number): Promise<string | null> {
    const pos = await this.convertCoordinates(x, y);

    return this.page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        if (!el) return null;

        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : "";
        const classes = el.className
          ? `.${el.className.toString().split(" ").slice(0, 2).join(".")}`
          : "";
        const text = el.textContent?.trim().slice(0, 30) || "";

        return `${tag}${id}${classes} "${text}"`;
      },
      pos
    );
  }

  /**
   * Check if coordinates are within viewport
   */
  async isInViewport(x: number, y: number): Promise<boolean> {
    const viewport = await this.getViewportInfo();
    const pos = await this.convertCoordinates(x, y);

    return (
      pos.x >= 0 &&
      pos.x <= viewport.width &&
      pos.y >= 0 &&
      pos.y <= viewport.height
    );
  }

  /**
   * Get current mouse position
   */
  getPosition(): Position {
    return { ...this.currentPosition };
  }

  /**
   * Highlight a coordinate on the page (for debugging/demo)
   */
  async highlightPosition(
    x: number,
    y: number,
    duration: number = 1000
  ): Promise<void> {
    const pos = await this.convertCoordinates(x, y);

    await this.page.evaluate(
      ({ x, y, duration }) => {
        const marker = document.createElement("div");
        marker.style.cssText = `
          position: fixed;
          left: ${x - 10}px;
          top: ${y - 10}px;
          width: 20px;
          height: 20px;
          border-radius: 50%;
          background: rgba(255, 0, 0, 0.5);
          border: 2px solid red;
          pointer-events: none;
          z-index: 999999;
          animation: pulse 0.5s ease-in-out infinite;
        `;

        const style = document.createElement("style");
        style.textContent = `
          @keyframes pulse {
            0%, 100% { transform: scale(1); opacity: 1; }
            50% { transform: scale(1.5); opacity: 0.5; }
          }
        `;

        document.head.appendChild(style);
        document.body.appendChild(marker);

        setTimeout(() => {
          marker.remove();
          style.remove();
        }, duration);
      },
      { x: pos.x, y: pos.y, duration }
    );
  }
}

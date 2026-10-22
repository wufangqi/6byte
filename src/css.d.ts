declare module "*.css";

/** Test-only DOM. jsdom 30 ships no types, and this project does not load `@types/*` globally. */
declare module "jsdom" {
  export class JSDOM {
    constructor(html: string, options?: { pretendToBeVisual?: boolean; url?: string });
    readonly window: Window & typeof globalThis;
  }
}

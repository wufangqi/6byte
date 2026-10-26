// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { appShortcutBlocked } from "./shortcuts";

describe("app shortcuts", () => {
  it("lets the editor through and blocks dialogs and outside fields", () => {
    document.body.innerHTML = `
      <div class="cm-editor"><input class="cm-textfield" /></div>
      <input class="outside" />
      <div role="dialog"><button class="dialog-button" type="button">ok</button></div>
    `;
    const editorField = document.querySelector(".cm-textfield");
    const outside = document.querySelector(".outside");
    const dialogButton = document.querySelector(".dialog-button");

    expect(appShortcutBlocked(editorField, false)).toBe(false);
    expect(appShortcutBlocked(outside, false)).toBe(true);
    expect(appShortcutBlocked(dialogButton, true)).toBe(true);
    expect(appShortcutBlocked(document.body, false)).toBe(false);
  });
});

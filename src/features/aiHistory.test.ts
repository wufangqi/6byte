// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  AI_HISTORY_KEY,
  HISTORY_MAX_CONVERSATIONS,
  HISTORY_MAX_TEXT,
  type ChatEntry,
  clearHistory,
  conversationTitle,
  loadHistory,
  parseHistory,
  removeConversation,
  restoreEntries,
  saveConversation,
} from "./aiHistory";

const user = (text: string): ChatEntry => ({
  id: `u-${text}`,
  role: "user",
  mode: "rewrite",
  text,
  chips: [{ kind: "selection", label: "Selection · line 3" }],
});

describe("aiHistory", () => {
  beforeEach(() => localStorage.clear());

  it("titles a conversation by its first instruction on one line", () => {
    expect(conversationTitle([user("make it\n  shorter")])).toBe("make it shorter");
    expect(conversationTitle([user("x".repeat(60))])).toBe(`${"x".repeat(48)}…`);
    expect(conversationTitle([])).toBe("");
  });

  it("drops malformed data instead of throwing", () => {
    expect(parseHistory(null)).toEqual([]);
    expect(parseHistory("not json")).toEqual([]);
    expect(parseHistory('{"id":"a"}')).toEqual([]);
    expect(
      parseHistory(
        JSON.stringify([{ id: "a", entries: [{ role: "user" }, { id: "x", role: "tool" }] }])
      )
    ).toEqual([]);
  });

  it("closes entries that were still live when stored", () => {
    const [conversation] = parseHistory(
      JSON.stringify([
        {
          id: "a",
          updatedAt: 1,
          entries: [
            user("polish"),
            { id: "r", role: "rewrite", model: "m", original: "a", text: "b", status: "pending" },
            { id: "q", role: "ask", model: "m", answer: "", trace: [], sent: 0, status: "live" },
          ],
        },
      ])
    );
    expect(conversation.title).toBe("polish");
    expect(
      conversation.entries.map((entry) => ("status" in entry ? entry.status : "user"))
    ).toEqual(["user", "closed", "cancelled"]);
  });

  it("settles restored entries the same way", () => {
    const restored = restoreEntries({
      id: "a",
      title: "t",
      updatedAt: 1,
      entries: [{ id: "r", role: "rewrite", model: "m", original: "a", text: "b", status: "live" }],
    });
    expect(restored[0]).toMatchObject({ status: "closed" });
  });

  it("saves newest first, replaces by id and clips long text", () => {
    saveConversation({ id: "a", entries: [user("first")], updatedAt: 1 });
    saveConversation({ id: "b", entries: [user("second")], updatedAt: 2 });
    const list = saveConversation({
      id: "a",
      entries: [user("y".repeat(HISTORY_MAX_TEXT + 10))],
      updatedAt: 3,
    });
    expect(list.map((item) => item.id)).toEqual(["a", "b"]);
    const stored = loadHistory()[0].entries[0];
    expect(stored.role === "user" && stored.text.length).toBe(HISTORY_MAX_TEXT + 1);
  });

  it("keeps a bounded number of conversations and ignores empty ones", () => {
    for (let index = 0; index < HISTORY_MAX_CONVERSATIONS + 5; index += 1) {
      saveConversation({ id: `c${index}`, entries: [user(`n${index}`)], updatedAt: index });
    }
    expect(loadHistory()).toHaveLength(HISTORY_MAX_CONVERSATIONS);
    saveConversation({ id: "empty", entries: [] });
    expect(loadHistory().some((item) => item.id === "empty")).toBe(false);
  });

  it("removes one conversation or clears all", () => {
    saveConversation({ id: "a", entries: [user("a")], updatedAt: 1 });
    saveConversation({ id: "b", entries: [user("b")], updatedAt: 2 });
    expect(removeConversation("a").map((item) => item.id)).toEqual(["b"]);
    clearHistory();
    expect(localStorage.getItem(AI_HISTORY_KEY)).toBe("[]");
    expect(loadHistory()).toEqual([]);
  });
});

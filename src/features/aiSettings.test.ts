// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { completionChoices } from "./completionSettings";
import {
  AI_SETTINGS_KEY,
  EMPTY_AI_CATALOG,
  LEGACY_PROFILE_ID,
  isSavedKeyMask,
  addModel,
  addProvider,
  keepActiveModel,
  loadAiSettings,
  type AiCatalog,
  parseAiSettings,
  removeModel,
  removeProvider,
  saveAiSettings,
  serializeAiSettings,
  withOllamaPreset,
} from "./aiSettings";

describe("ai settings persistence", () => {
  it("treats an asterisk-only field as the saved-key mask", () => {
    expect(isSavedKeyMask("*****")).toBe(true);
    expect(isSavedKeyMask("  ****  ")).toBe(true);
    expect(isSavedKeyMask("sk-sp-real")).toBe(false);
    expect(isSavedKeyMask("")).toBe(false);
  });

  it("turns a legacy address into one provider and drops a stray api key", () => {
    const parsed = parseAiSettings(
      JSON.stringify({
        baseUrl: "https://api.example.com/v1",
        model: "demo",
        apiKey: "sk-secret",
      })
    );
    expect(parsed.providers).toEqual([
      {
        id: LEGACY_PROFILE_ID,
        name: "demo",
        baseUrl: "https://api.example.com/v1",
        models: [{ id: "default-model", name: "demo", model: "demo", enabled: true }],
      },
    ]);
    expect(parsed.activeProviderId).toBe(LEGACY_PROFILE_ID);
    expect(parsed.activeModelId).toBe("default-model");
    expect(serializeAiSettings(parsed)).not.toContain("sk-secret");
    expect(serializeAiSettings(parsed)).not.toContain("apiKey");
  });

  it("turns each saved model into its own provider and keeps the active one", () => {
    const parsed = parseAiSettings(
      JSON.stringify({
        activeId: "m2",
        profiles: [
          {
            id: "m1",
            name: "本地",
            baseUrl: "http://127.0.0.1:11434/v1",
            model: "llama3.2",
            apiKey: "nope",
          },
          { id: "m2", name: "云端", baseUrl: "https://api.example.com/v1", model: "demo" },
        ],
      })
    );
    expect(parsed.activeProviderId).toBe("m2");
    expect(parsed.activeModelId).toBe("m2-model");
    expect(parsed.providers.map((provider) => provider.id)).toEqual(["m1", "m2"]);
    expect(parsed.providers[0].models[0].model).toBe("llama3.2");
    expect(serializeAiSettings(parsed)).not.toContain("nope");
  });

  it("writes only the trimmed public fields of providers and their models", () => {
    localStorage.clear();
    saveAiSettings({
      activeProviderId: LEGACY_PROFILE_ID,
      activeModelId: "default-model",
      providers: [
        {
          id: LEGACY_PROFILE_ID,
          name: " llama ",
          baseUrl: "  http://127.0.0.1:11434/v1  ",
          models: [{ id: "default-model", name: " llama ", model: " llama3.2 ", enabled: true }],
        },
      ],
    });
    expect(localStorage.getItem(AI_SETTINGS_KEY)).toBe(
      JSON.stringify({
        activeProviderId: LEGACY_PROFILE_ID,
        activeModelId: "default-model",
        providers: [
          {
            id: LEGACY_PROFILE_ID,
            name: "llama",
            baseUrl: "http://127.0.0.1:11434/v1",
            models: [{ id: "default-model", name: "llama", model: "llama3.2", enabled: true }],
          },
        ],
      })
    );
    expect(loadAiSettings().providers[0].models[0].model).toBe("llama3.2");
  });

  it("drops an api key stored on a provider or a model", () => {
    const parsed = parseAiSettings(
      JSON.stringify({
        activeProviderId: "cloud",
        activeModelId: "fast",
        providers: [
          {
            id: "cloud",
            name: "云端",
            baseUrl: "https://api.example.com/v1",
            apiKey: "sk-provider",
            models: [
              { id: "fast", name: "快", model: "demo", apiKey: "sk-model" },
              { id: "fast", name: "重复", model: "other" },
            ],
          },
        ],
      })
    );
    expect(parsed.providers[0].models).toEqual([
      { id: "fast", name: "快", model: "demo", enabled: true },
    ]);
    expect(serializeAiSettings(parsed)).not.toContain("sk-");
  });

  it("falls back when the stored value is not JSON", () => {
    expect(parseAiSettings("not-json")).toEqual({
      activeProviderId: "",
      activeModelId: "",
      providers: [],
    });
    expect(parseAiSettings(null)).toEqual({
      activeProviderId: "",
      activeModelId: "",
      providers: [],
    });
  });

  it("adds models under one provider and reuses the Ollama provider", () => {
    const added = addProvider({ activeProviderId: "", activeModelId: "", providers: [] }, "云端");
    const withModel = addModel(added, added.activeProviderId, "demo", "demo");
    expect(withModel.providers).toHaveLength(1);
    expect(withModel.providers[0].models).toHaveLength(1);
    expect(withModel.activeModelId).toBe(withModel.providers[0].models[0].id);

    const ollama = withOllamaPreset(withModel);
    expect(ollama.providers).toHaveLength(2);
    expect(ollama.providers[1].baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(ollama.providers[1].models[0].model).toBe("llama3.2");
    expect(withOllamaPreset(ollama).providers).toHaveLength(2);

    const providerId = ollama.activeProviderId;
    const second = addModel(ollama, providerId, "其它", "qwen");
    expect(second.providers.find((provider) => provider.id === providerId)?.models).toHaveLength(2);
    const removedModel = removeModel(second, providerId, second.activeModelId);
    expect(
      removedModel.providers.find((provider) => provider.id === providerId)?.models
    ).toHaveLength(1);
    const removed = removeProvider(removedModel, providerId);
    expect(removed.providers).toHaveLength(1);
    expect(removed.activeProviderId).toBe(added.activeProviderId);
  });

  it("enables stored models unless they were switched off", () => {
    const parsed = parseAiSettings(
      JSON.stringify({
        providers: [
          {
            id: "p",
            baseUrl: "https://api.example.com/v1",
            models: [
              { id: "a", model: "a" },
              { id: "b", model: "b", enabled: false },
            ],
          },
        ],
      })
    );
    expect(parsed.providers[0].models.map((model) => model.enabled)).toEqual([true, false]);
    expect(serializeAiSettings(parsed)).toContain('"enabled":false');
  });

  it("keeps the chat model when a provider or model is added", () => {
    const base = addProvider(EMPTY_AI_CATALOG, "p");
    const start = addModel(base, base.activeProviderId, "chat", "chat");
    const added = keepActiveModel(start, addProvider(start, "q"));
    expect(added.providers).toHaveLength(2);
    expect(added.activeProviderId).toBe(start.activeProviderId);
    expect(added.activeModelId).toBe(start.activeModelId);
    const preset = keepActiveModel(start, withOllamaPreset(start));
    expect(preset.activeModelId).toBe(start.activeModelId);
  });
});

describe("model pickers", () => {
  const catalog: AiCatalog = {
    activeProviderId: "p",
    activeModelId: "on",
    providers: [
      {
        id: "p",
        name: "P",
        baseUrl: "https://api.example.com/v1",
        models: [
          { id: "on", name: "On", model: "on", enabled: true },
          { id: "off", name: "Off", model: "off", enabled: false },
        ],
      },
    ],
  };

  it("leaves disabled models out unless they are the current pick", () => {
    expect(completionChoices(catalog).map((choice) => choice.modelId)).toEqual(["on"]);
    expect(
      completionChoices(catalog, { providerId: "p", modelId: "off" }).map(
        (choice) => choice.modelId
      )
    ).toEqual(["on", "off"]);
  });
});

import { useEffect, useRef } from "react";
import { isTauri, onFileChanged, unwatchFile, watchFile } from "../ipc/api";
import type { FileChangeEvent } from "../ipc/types";
import { useWorkspace, type Tab } from "../stores/workspace";

/**
 * Keep native watchers aligned with open tabs and forward external changes to
 * the caller. Keeping this lifecycle outside App makes file operations easier
 * to reason about without changing the watcher protocol.
 */
export function useFileWatch(onExternalChange: (event: FileChangeEvent) => void): void {
  const watchedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!isTauri) return;
    const sync = (tabs: Tab[]) => {
      const next = new Set(
        tabs.map((tab) => tab.path).filter((path): path is string => Boolean(path))
      );
      for (const path of next) {
        if (watchedRef.current.has(path)) continue;
        watchedRef.current.add(path);
        void watchFile(path).catch(() => watchedRef.current.delete(path));
      }
      for (const path of [...watchedRef.current]) {
        if (next.has(path)) continue;
        watchedRef.current.delete(path);
        void unwatchFile(path);
      }
    };

    sync(useWorkspace.getState().tabs);
    const unsubscribe = useWorkspace.subscribe((state, previous) => {
      if (state.tabs !== previous.tabs) sync(state.tabs);
    });
    const watched = watchedRef.current;
    return () => {
      unsubscribe();
      for (const path of watched) void unwatchFile(path);
      watched.clear();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void onFileChanged((event) => onExternalChange(event)).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [onExternalChange]);
}

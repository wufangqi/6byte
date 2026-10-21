import { useMemo } from "react";
import { selectActiveTab, useWorkspace } from "../stores/workspace";

const EOL_LABEL: Record<string, string> = {
  lf: "LF",
  crlf: "CRLF",
  cr: "CR",
};

const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

export default function StatusBar() {
  const tab = useWorkspace(selectActiveTab);

  const stats = useMemo(() => {
    if (!tab) return null;
    const lines = tab.content.length === 0 ? 0 : tab.content.split("\n").length;
    const chars = tab.content.length;
    return { lines, chars };
  }, [tab]);

  if (!tab) {
    return (
      <footer className="statusbar">
        <span className="statusbar__item">就绪</span>
      </footer>
    );
  }

  return (
    <footer className="statusbar">
      <span className="statusbar__item statusbar__path" title={tab.path ?? undefined}>
        {tab.path ?? "未保存的新文件"}
      </span>

      {tab.meta.lossy && (
        <span className="statusbar__warn" title="文件包含无法解码的字节，保存可能损坏内容">
          编码有损
        </span>
      )}

      <span className="statusbar__spacer" />

      <span className="statusbar__item">{stats?.lines} 行</span>
      <span className="statusbar__item">{stats?.chars} 字符</span>
      <span className="statusbar__item">{formatSize(new Blob([tab.content]).size)}</span>
      <span className="statusbar__item" title="当前编码">
        {tab.meta.charset}
        {tab.meta.bom ? " BOM" : ""}
      </span>
      <span className="statusbar__item">{EOL_LABEL[tab.meta.eol] ?? tab.meta.eol}</span>
      <span className={`statusbar__item ${tab.dirty ? "statusbar__item--dirty" : ""}`}>
        {tab.dirty ? "未保存" : "已保存"}
      </span>
    </footer>
  );
}
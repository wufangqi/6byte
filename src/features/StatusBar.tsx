import { selectActiveTab, useWorkspace } from "../stores/workspace";
import { formatSize } from "../lib/format";

const EOL_LABEL: Record<string, string> = {
  lf: "LF",
  crlf: "CRLF",
  cr: "CR",
};

interface Props {
  previewOn?: boolean;
  canPreview?: boolean;
  onTogglePreview?: () => void;
}

export default function StatusBar({
  previewOn = false,
  canPreview = false,
  onTogglePreview,
}: Props) {
  const tab = useWorkspace(selectActiveTab);

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

      {tab.mode === "large" && (
        <span className="statusbar__warn" title="大文件只读预览（按区间加载，不加载全文）">
          只读
        </span>
      )}

      {tab.meta.lossy && (
        <span className="statusbar__warn" title="文件包含无法解码的字节，保存会被要求确认">
          编码有损
        </span>
      )}

      {tab.meta.mixedEol && (
        <span className="statusbar__warn" title="文件混合了多种换行符，保存时会统一为主导换行符">
          混合换行
        </span>
      )}

      <span className="statusbar__spacer" />

      {canPreview && onTogglePreview && (
        <button
          type="button"
          className={`statusbar__action ${previewOn ? "statusbar__action--on" : ""}`}
          title="切换 Markdown 分屏预览（Ctrl+Shift+M）"
          onClick={onTogglePreview}
        >
          预览
        </button>
      )}

      <span className="statusbar__item">{tab.lines} 行</span>
      <span className="statusbar__item">{tab.mode === "large" ? "—" : `${tab.chars} 字符`}</span>
      <span className="statusbar__item">{formatSize(tab.size)}</span>
      <span className="statusbar__item" title="当前编码">
        {tab.meta.charset}
        {tab.meta.bom ? " BOM" : ""}
      </span>
      <span
        className={`statusbar__item ${tab.meta.mixedEol ? "statusbar__item--mixed" : ""}`}
        title={tab.meta.mixedEol ? "混合换行，保存后统一为该换行符" : "当前换行符"}
      >
        {EOL_LABEL[tab.meta.eol] ?? tab.meta.eol}
      </span>
      {tab.mode === "large" ? (
        <span className="statusbar__item" title="大文件以只读方式打开，不写回磁盘">
          只读预览
        </span>
      ) : (
        <span className={`statusbar__item ${tab.dirty ? "statusbar__item--dirty" : ""}`}>
          {tab.dirty ? "未保存" : "已保存"}
        </span>
      )}
    </footer>
  );
}

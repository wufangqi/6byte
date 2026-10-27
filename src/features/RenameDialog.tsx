import { useEffect, useRef, useState } from "react";
import { fileNameProblem } from "./fileName";
import { useNamePrompt, type NamePromptRequest } from "./renamePrompt";
import { useI18n } from "../i18n";

const PROBLEM_KEY: Record<string, string> = {
  empty: "name.error.empty",
  dot: "name.error.dot",
  separator: "name.error.separator",
  control: "name.error.control",
  tooLong: "name.error.tooLong",
};

/** Single-field modal used by “重命名”. Enter confirms, Esc cancels. */
export default function RenameDialog() {
  const request = useNamePrompt((state) => state.request);
  const settle = useNamePrompt((state) => state.settle);
  if (!request) return null;
  // Remounting per request keeps the draft text local to each prompt.
  return <RenameForm key={request.initial + request.title} request={request} settle={settle} />;
}

function RenameForm({
  request,
  settle,
}: {
  request: NamePromptRequest;
  settle: (value: string | null) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(request.initial);
  const [problem, setProblem] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // Select the base name but keep the extension, like Explorer does.
    const dot = request.initial.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : request.initial.length);
  }, [request.initial]);

  const submit = () => {
    const builtIn = fileNameProblem(value);
    if (builtIn) {
      setProblem(t(PROBLEM_KEY[builtIn]));
      return;
    }
    const extra = request.validate?.(value.trim()) ?? null;
    if (extra) {
      setProblem(extra);
      return;
    }
    settle(value.trim());
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => settle(null)}>
      <div
        className="dialog name-prompt"
        role="dialog"
        aria-modal="true"
        aria-label={request.title}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            settle(null);
          }
        }}
      >
        <h2 className="dialog__title">{request.title}</h2>
        <label className="name-prompt__field">
          <span>{request.label}</span>
          <input
            ref={inputRef}
            type="text"
            value={value}
            placeholder={request.placeholder}
            spellCheck={false}
            aria-invalid={problem !== null}
            onChange={(event) => {
              setValue(event.target.value);
              if (problem) setProblem(null);
            }}
          />
        </label>
        <p className={`name-prompt__error${problem ? " is-on" : ""}`} role="alert">
          {problem ?? ""}
        </p>
        <div className="dialog__actions">
          <button type="button" className="btn" onClick={() => settle(null)}>
            {request.cancelLabel}
          </button>
          <button type="button" className="btn btn--primary" onClick={submit}>
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

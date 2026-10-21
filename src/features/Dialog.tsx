import { useEffect } from "react";
import { useDialog } from "./dialogStore";

export default function DialogHost() {
  const request = useDialog((state) => state.request);
  const choose = useDialog((state) => state.choose);

  useEffect(() => {
    if (!request) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        choose(null);
      } else if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        // Enter picks the primary action; destructive dialogs default to cancel.
        const primary = request.buttons.find((button) => button.variant === "primary");
        choose((primary ?? request.buttons[0]).value);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [request, choose]);

  if (!request) return null;

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => choose(null)}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={request.title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="dialog__title">{request.title}</h2>
        <p className="dialog__message">{request.message}</p>
        <div className="dialog__actions">
          {request.buttons.map((button) => (
            <button
              key={button.value}
              className={`btn ${button.variant === "primary" ? "btn--primary" : ""} ${
                button.variant === "danger" ? "btn--danger" : ""
              }`}
              onClick={() => choose(button.value)}
            >
              {button.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

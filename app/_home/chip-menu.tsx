import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { ChipOption } from "./request-text";

export interface ChipMenuProps<V extends string | number> {
  readonly label: string;
  readonly selected: boolean;
  readonly options: readonly ChipOption<V>[];
  readonly value: V | null;
  readonly onChoose: (value: V) => void;
  readonly footer?: (close: () => void) => ReactNode;
}

export function ChipMenu<V extends string | number>({
  label,
  selected,
  options,
  value,
  onChoose,
  footer,
}: ChipMenuProps<V>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    function onPointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return (
    <div className="home-chip" ref={rootRef}>
      <button
        type="button"
        className={selected ? "btn btn-secondary home-chip-selected" : "btn btn-secondary"}
        aria-expanded={open}
        aria-pressed={selected}
        aria-controls={menuId}
        onClick={() => setOpen((current) => !current)}
      >
        {label}
      </button>
      {open ? (
        <div className="home-menu" id={menuId} role="menu">
          {options.map((option) => (
            <button
              key={String(option.value)}
              type="button"
              role="menuitemradio"
              className="btn btn-secondary"
              aria-checked={option.value === value}
              onClick={() => {
                onChoose(option.value);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
          {footer ? footer(() => setOpen(false)) : null}
        </div>
      ) : null}
    </div>
  );
}

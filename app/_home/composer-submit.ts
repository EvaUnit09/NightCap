export interface ComposerSubmitUi {
  readonly disabled: boolean;
  readonly label: "Plan our night" | "Planning…";
  readonly status: "Planning your night" | null;
}

export function composerSubmitUi(busy: boolean, canSubmitText: boolean): ComposerSubmitUi {
  return {
    disabled: !canSubmitText || busy,
    label: busy ? "Planning…" : "Plan our night",
    status: busy ? "Planning your night" : null,
  };
}

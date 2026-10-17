export interface ComposerSubmitUi {
  readonly disabled: boolean;
  readonly label: "Plan our night" | "Planning…";
  readonly status: "Planning your night" | null;
}

export function composerSubmitUi(busy: boolean, canSubmitText: boolean): ComposerSubmitUi {
  return {
    disabled: !canSubmitText,
    label: "Plan our night",
    status: null,
  };
}

import { useTranslation } from "react-i18next";
import type { EditingMode, TextFormat, WritingStyle } from "../desktop/contracts";

export const editingModes: EditingMode[] = ["exact", "clean", "polished"];

export function ModePicker({
  value,
  disabled,
  onChange,
}: {
  value: EditingMode;
  disabled: boolean;
  onChange: (mode: EditingMode) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="segmented cleanup-picker" role="group" aria-label={t("editingMode")}>
      {editingModes.map((mode) => (
        <button
          key={mode}
          aria-pressed={value === mode}
          className={value === mode ? "selected" : ""}
          disabled={disabled}
          onClick={() => onChange(mode)}
          title={t(`modeDetail_${mode}`)}
        >
          {t(`mode_${mode}`)}
        </button>
      ))}
    </div>
  );
}

export function WritingOptions({
  value,
  disabled,
  onChange,
  id,
}: {
  value: { editingMode: EditingMode; style: WritingStyle; format: TextFormat };
  disabled: boolean;
  onChange: (patch: Partial<typeof value>) => void;
  id: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="writing-options">
      <label htmlFor={`${id}-style`}>
        <span>{t("writingStyle")}</span>
        <select
          id={`${id}-style`}
          value={value.style}
          disabled={disabled || value.editingMode === "exact"}
          onChange={(event) => onChange({ style: event.target.value as WritingStyle })}
        >
          {(["neutral", "chat", "email"] as WritingStyle[]).map((style) => (
            <option key={style} value={style}>
              {t(`style_${style}`)}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor={`${id}-format`}>
        <span>{t("format")}</span>
        <select
          id={`${id}-format`}
          value={value.format}
          disabled={disabled || value.editingMode === "exact"}
          onChange={(event) => onChange({ format: event.target.value as TextFormat })}
        >
          {(["prose", "paragraphs", "list"] as TextFormat[]).map((format) => (
            <option key={format} value={format}>
              {t(`format_${format}`)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

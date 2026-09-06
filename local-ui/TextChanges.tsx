import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { diffWords } from "./diff";

function WordChanges({ before, after }: { before: string; after: string }) {
  const { t } = useTranslation();
  const diff = useMemo(() => diffWords(before, after), [before, after]);
  return (
    <div className="changes-body">
      <div className="changes-legend" aria-label={t("changesLegend")}>
        <span className="change-added">+ {t("added")}</span>
        <span className="change-removed">− {t("removedWords")}</span>
      </div>
      {diff.coarse && <p className="form-hint">{t("changesGrouped")}</p>}
      <p className="word-changes">
        {diff.parts.map((part, index) =>
          part.kind === "add" ? (
            <ins key={index}>{part.text}</ins>
          ) : part.kind === "remove" ? (
            <del key={index}>{part.text}</del>
          ) : (
            <span key={index}>{part.text}</span>
          )
        )}
      </p>
    </div>
  );
}

export function TextChanges({
  before,
  after,
  label,
}: {
  before: string;
  after: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  if (before === after) return null;
  return (
    <details className="text-changes" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{label}</summary>
      {open && <WordChanges before={before} after={after} />}
    </details>
  );
}

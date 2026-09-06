import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import type { AppRule, Settings, Transcript } from "../desktop/contracts";
import { ModePicker, WritingOptions } from "./EditingControls";

export function AppRules({
  settings,
  transcripts,
  disabled,
  onChange,
}: {
  settings: Settings;
  transcripts: Transcript[];
  disabled: boolean;
  onChange: (rules: AppRule[]) => void;
}) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState("");
  const rules = settings.appRules || [];
  const seen = new Map<string, NonNullable<Transcript["targetApp"]>>();
  for (const item of transcripts) {
    const app = item.targetApp;
    if (app?.bundleId && app.name && !seen.has(app.bundleId)) seen.set(app.bundleId, app);
  }
  const available = [...seen.values()].filter(
    (app) => !rules.some((rule) => rule.bundleId === app.bundleId)
  );
  const selected = available.find((app) => app.bundleId === chosen) || available[0];
  const updateRule = (bundleId: string, patch: Partial<AppRule>) =>
    onChange(rules.map((rule) => (rule.bundleId === bundleId ? { ...rule, ...patch } : rule)));
  return (
    <section className="settings-group">
      <h2>{t("appRules")}</h2>
      <div className="settings-card">
        <div className="vocabulary-heading">
          <div>
            <span className="setting-label">{t("appRulesTitle")}</span>
            <p>{t("appRulesDetail")}</p>
          </div>
        </div>
        {rules.map((rule, index) => (
          <div className="app-rule" key={rule.bundleId}>
            <div className="app-rule-heading">
              <h3>{rule.name}</h3>
              <button
                className="icon-button delete-button"
                disabled={disabled}
                aria-label={t("removeAppRule", { name: rule.name })}
                onClick={() =>
                  onChange(rules.filter((current) => current.bundleId !== rule.bundleId))
                }
              >
                <Trash2 size={14} />
              </button>
            </div>
            <ModePicker
              value={rule.editingMode}
              disabled={disabled}
              onChange={(editingMode) => updateRule(rule.bundleId, { editingMode })}
            />
            <WritingOptions
              value={rule}
              disabled={disabled}
              id={`app-rule-${index}`}
              onChange={(patch) => updateRule(rule.bundleId, patch)}
            />
          </div>
        ))}
        {rules.length >= 32 ? (
          <p className="vocabulary-empty">{t("appRulesLimit")}</p>
        ) : available.length ? (
          <div className="app-rule-add">
            <label htmlFor="new-app-rule">{t("chooseApp")}</label>
            <div>
              <select
                id="new-app-rule"
                value={selected?.bundleId || ""}
                disabled={disabled}
                onChange={(event) => setChosen(event.target.value)}
              >
                {available.map((app) => (
                  <option key={app.bundleId} value={app.bundleId}>
                    {app.name}
                  </option>
                ))}
              </select>
              <button
                className="small-button"
                disabled={disabled || !selected}
                onClick={() => {
                  if (selected)
                    onChange([
                      ...rules,
                      {
                        ...selected,
                        editingMode: settings.editingMode,
                        style: settings.style,
                        format: settings.format,
                      },
                    ]);
                }}
              >
                <Plus size={13} />
                {t("addAppRule")}
              </button>
            </div>
          </div>
        ) : (
          <p className="vocabulary-empty">{t(rules.length ? "appRulesMore" : "appRulesEmpty")}</p>
        )}
        <p className="vocabulary-footnote">{t("appRulesDefault")}</p>
      </div>
    </section>
  );
}

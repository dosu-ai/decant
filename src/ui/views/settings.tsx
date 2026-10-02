import { useEffect, useState } from "react";
import { getJson } from "../api.ts";
import dosuDecantUrl from "../assets/dosu-decant.png";
import { dosuLink } from "../dosu-links.ts";
import { errorMessage, versionLabel } from "../format.ts";
import { Icon } from "../icons.tsx";
import type { ConfigView, SettingsInfo, UserSettings } from "../types.ts";

export function SettingsView({
  config,
  onSaved,
  settingsInfo,
}: {
  config: ConfigView | null;
  onSaved: () => void;
  settingsInfo: SettingsInfo | null;
}) {
  const [settings, setSettings] = useState<UserSettings | null>(settingsInfo?.settings ?? null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSettings(settingsInfo?.settings ?? null);
    setSaveError(null);
  }, [settingsInfo]);

  const save = (patch: Partial<UserSettings>) => {
    const base = settings ?? settingsInfo?.settings;
    if (base == null) {
      return;
    }
    const previous = settings;
    const next = { ...base, ...patch };
    setSettings(next);
    setSaveError(null);
    setSaving(true);
    void getJson<SettingsInfo>("/api/settings", {
      method: "POST",
      body: JSON.stringify(next),
    })
      .then((response) => {
        setSettings(response.settings);
        onSaved();
      })
      .catch((err: unknown) => {
        setSettings(previous ?? base);
        setSaveError(errorMessage(err));
      })
      .finally(() => setSaving(false));
  };

  return (
    <div className="settings-page">
      <header className="page-heading">
        <h1>Settings</h1>
        <p>
          How Decant opens things on your machine. We start from what we detect and remember your
          choices.
        </p>
      </header>

      <section className="panel">
        <div className="settings-form">
          <SettingSelect
            help="The agent the Run button opens first across Insights."
            label="Preferred agent"
            options={settingsInfo?.options.agents ?? []}
            value={settings?.agent ?? "claude"}
            onChange={(agent) => save({ agent })}
          />
          <SettingSelect
            help="Where a session opens when you run an agent."
            label="Terminal"
            options={settingsInfo?.options.terminals ?? []}
            value={settings?.terminal ?? "terminal"}
            onChange={(terminal) => save({ terminal })}
          />
          <SettingSelect
            help="Which editor Open in editor uses for a session's project."
            label="Editor"
            options={settingsInfo?.options.ides ?? []}
            value={settings?.ide ?? "vscode"}
            onChange={(ide) => save({ ide })}
          />
        </div>
        {saveError != null ? <div className="notice danger inline-notice">{saveError}</div> : null}
        <p className="settings-note">
          {saving
            ? "Saving preferences..."
            : settingsInfo?.can_launch === true
              ? "Native launcher is available on this Mac."
              : "Native launcher is unavailable on this platform."}
        </p>
      </section>

      <section className="panel about-decant">
        <div className="panel-heading">
          <div>
            <h2>About Decant</h2>
            <p>
              Local-first analytics for Claude Code, Codex, and Gemini CLI sessions. Decant is an
              open source tool from Dosu.
            </p>
          </div>
          <img alt="" src={dosuDecantUrl} />
        </div>
        <div className="panel-body">
          <div className="about-links">
            <a href={dosuLink("about")} rel="noopener" target="_blank">
              Visit Dosu ↗
            </a>
            <a href="https://github.com/dosu-ai/decant" rel="noopener" target="_blank">
              View source ↗
            </a>
            <a
              href="https://github.com/dosu-ai/decant/blob/main/LICENSE"
              rel="noopener"
              target="_blank"
            >
              Apache-2.0 license ↗
            </a>
          </div>
          <p className="about-version">Version {versionLabel(config?.version)}</p>
          <p className="about-privacy">
            Decant makes no outbound network calls. Your session logs stay on this machine.
          </p>
        </div>
      </section>
    </div>
  );
}

export function SettingSelect({
  help,
  label,
  options,
  value,
  onChange,
}: {
  help: string;
  label: string;
  options: [string, string][];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="setting-select">
      <span>
        <strong>{label}</strong>
        <small>{help}</small>
      </span>
      <span className="select-shell">
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {options.map(([key, name]) => (
            <option key={key} value={key}>
              {name}
            </option>
          ))}
        </select>
        <Icon name="chevronDown" />
      </span>
    </label>
  );
}

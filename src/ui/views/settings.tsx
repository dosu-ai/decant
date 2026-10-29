import { useEffect, useId, useState } from "react";
import { getJson } from "../api.ts";
import dosuDecantUrl from "../assets/dosu-decant.png";
import { dosuLink } from "../dosu-links.ts";
import { errorMessage, versionLabel } from "../format.ts";
import { Icon } from "../icons.tsx";
import type { ConfigView, SettingsInfo, UpdateStatus, UserSettings } from "../types.ts";

export function SettingsView({
  config,
  onSaved,
  settingsInfo,
  update,
}: {
  config: ConfigView | null;
  onSaved: () => void;
  settingsInfo: SettingsInfo | null;
  update: UpdateStatus | null;
}) {
  const [settings, setSettings] = useState<UserSettings | null>(settingsInfo?.settings ?? null);
  const [saveError, setSaveError] = useState<string | null>(null);

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
      });
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
      </section>

      <section className="panel">
        <div className="settings-form">
          {/* With DECANT_UPDATE_CHECK set, the switch shows what is in effect
              and saving the setting would change nothing. */}
          <SettingSwitch
            checked={
              update?.envOverride === true ? update.enabled : (settings?.updateCheck ?? false)
            }
            disabled={update?.envOverride === true}
            help="Once a day, ask the npm registry for the newest Decant version. The request carries no session data."
            label="Check for updates"
            onChange={(updateCheck) => save({ updateCheck })}
            status={updateNote(update, settings?.updateCheck ?? false)}
          />
        </div>
      </section>

      <section className="panel about-decant">
        <div className="panel-heading">
          <div>
            <h2>About Decant</h2>
            <p>
              Local-first analytics for Claude Code, Codex, Gemini CLI, and OpenCode sessions.
              Decant is an open source tool from Dosu.
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
            {update?.enabled === true
              ? "Decant contacts the npm registry once a day to check for a newer version. Your session logs stay on this machine."
              : "Decant makes no outbound network calls. Your session logs stay on this machine."}
          </p>
        </div>
      </section>
    </div>
  );
}

function updateNote(update: UpdateStatus | null, saved: boolean): string {
  if (update == null) {
    return "Loading update status...";
  }
  // A failed save rolls the toggle back, so a mismatch without an override
  // means the status reload after a save has not finished yet.
  if (!update.envOverride && update.enabled !== saved) {
    return saved ? "Checking for updates..." : "Saving...";
  }
  const override = update.envOverride
    ? " DECANT_UPDATE_CHECK in the environment overrides this setting."
    : "";
  if (!update.enabled) {
    return `Checks are off. Run decant update to check and install by hand.${override}`;
  }
  if (update.updateAvailable && update.latest != null) {
    return `Decant ${versionLabel(update.latest)} is available. Run ${update.command} to install it.${override}`;
  }
  if (update.channel === "source") {
    return `This is a source checkout, so Decant does not check for releases. Update it with git pull.${override}`;
  }
  if (update.latest != null) {
    const checked =
      update.checkedAt == null
        ? ""
        : ` Last checked ${new Date(update.checkedAt).toLocaleString()}.`;
    return `You have the newest release.${checked}${override}`;
  }
  if (update.error != null) {
    return `The last check failed: ${update.error}. Decant tries again tomorrow.${override}`;
  }
  return `No check has finished yet.${override}`;
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

export function SettingSwitch({
  checked,
  disabled = false,
  help,
  label,
  onChange,
  status,
}: {
  checked: boolean;
  disabled?: boolean;
  help: string;
  label: string;
  onChange: (checked: boolean) => void;
  status?: string;
}) {
  const id = useId();
  return (
    // A label activates its button, so clicking the title or help text flips the switch too.
    <label className="setting-select setting-switch" htmlFor={id}>
      <span>
        <strong id={`${id}-label`}>{label}</strong>
        <small id={`${id}-help`}>{help}</small>
        {status != null ? (
          <small aria-live="polite" className="setting-switch-status">
            {status}
          </small>
        ) : null}
      </span>
      <button
        aria-checked={checked}
        aria-describedby={`${id}-help`}
        aria-labelledby={`${id}-label`}
        className="switch"
        disabled={disabled}
        id={id}
        onClick={() => onChange(!checked)}
        role="switch"
        type="button"
      >
        <span className="switch-handle" />
      </button>
    </label>
  );
}

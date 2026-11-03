import { type PluginSurfaceProps, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import { type DevcontainerSettings, settingsDefinition } from "../shared/contract";

type TextField =
  | "installCommand"
  | "paseoHomesDir"
  | "dockerPath"
  | "devcontainerPath"
  | "dotfilesRepository"
  | "dotfilesTargetPath"
  | "dotfilesInstallCommand"
  | "sshAgentSocket";

function splitPaths(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((path) => path.trim())
    .filter(Boolean);
}

function parsePorts(text: string): number[] {
  return splitPaths(text)
    .map(Number)
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
}

export function DevcontainerSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(settingsDefinition);
  const [draft, setDraft] = useState<Partial<DevcontainerSettings>>({});
  const [advanced, setAdvanced] = useState(false);

  if (settings.status !== "ready") {
    const message = settings.status === "loading" ? "Loading…" : `Settings unavailable: ${settings.error}`;
    return <Text style={{ color: theme.colors.foregroundMuted }}>{message}</Text>;
  }
  const { values, revision } = settings;
  const current = { ...values, ...draft };
  const dirty = Object.keys(draft).length > 0;

  // Saving remounts the inputs (keyed by revision), so every save includes the draft.
  async function save(patch: Partial<DevcontainerSettings> = {}) {
    if (await settings.save({ ...values, ...draft, ...patch }, revision)) setDraft({});
  }

  const input = (key: TextField, label: string, hint?: string, placeholder?: string) => (
    <SettingsInput
      key={`${key}-${revision}`}
      label={label}
      hint={hint}
      placeholder={placeholder}
      initialValue={values[key]}
      onChangeText={(text) => setDraft((previous) => ({ ...previous, [key]: text.trim() }))}
    />
  );

  return (
    <View style={{ gap: 24 }}>
      <SettingsSection title="Discovery">
        <SettingsCard>
          <SettingsSwitch
            label="Scan Paseo projects"
            hint="List projects with a .devcontainer config."
            value={current.scanPaseoProjects}
            disabled={settings.saving}
            onValueChange={(scanPaseoProjects) => void save({ scanPaseoProjects })}
          />
          <SettingsInput
            key={`extra-${revision}`}
            label="Extra repositories"
            placeholder="/path/to/repo, …"
            initialValue={values.extraRepoPaths.join(", ")}
            onChangeText={(text) => setDraft((previous) => ({ ...previous, extraRepoPaths: splitPaths(text) }))}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Paseo in containers">
        <SettingsCard>
          <SettingsSwitch
            label="Install automatically"
            hint="Start and Rebuild install Paseo when it is missing."
            value={current.autoInstallPaseo}
            disabled={settings.saving}
            onValueChange={(autoInstallPaseo) => void save({ autoInstallPaseo })}
          />
          {input("installCommand", "Install command")}
          <SettingsSwitch
            label="Keep the Paseo home"
            hint="Store each container's Paseo home in a folder on this machine, so sessions survive rebuilds and git worktrees work from both sides. Applies to containers created afterwards."
            value={current.persistPaseoHome}
            disabled={settings.saving}
            onValueChange={(persistPaseoHome) => void save({ persistPaseoHome })}
          />
          {current.persistPaseoHome
            ? input("paseoHomesDir", "Paseo homes folder", "One subfolder per repository.", "~/.paseo/plugin-data/devcontainer-host/homes")
            : null}
          {current.persistPaseoHome ? (
            <SettingsSwitch
              label="Guard shared worktrees"
              hint="Snapshot the git worktree records this machine and the container share, and restore those an archive or a git worktree prune or repair on the other side breaks. Adds a small plugin to the container's Paseo daemon."
              value={current.guardWorktrees}
              disabled={settings.saving}
              onValueChange={(guardWorktrees) => void save({ guardWorktrees })}
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Builds">
        <SettingsCard>
          <SettingsSwitch
            label="Open the build log"
            hint="Rebuilds, and starts that create a container, open their log in a terminal of the workspace."
            value={current.openBuildLogs}
            disabled={settings.saving}
            onValueChange={(openBuildLogs) => void save({ openBuildLogs })}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Port forwarding">
        <SettingsCard>
          <SettingsSwitch
            label="Forward Paseo daemons"
            hint="Each container's daemon gets its own local port, kept across restarts. Pair it in Paseo at that address."
            value={current.forwardDaemon}
            disabled={settings.saving}
            onValueChange={(forwardDaemon) => void save({ forwardDaemon })}
          />
          <SettingsInput
            key={`daemonPortStart-${revision}`}
            label="First daemon port"
            hint="New containers take the next free port from here. Existing ones keep theirs."
            initialValue={String(values.daemonPortStart)}
            onChangeText={(text) => {
              const port = Number(text.trim());
              if (Number.isInteger(port) && port >= 1024 && port <= 65535) {
                setDraft((previous) => ({ ...previous, daemonPortStart: port }));
              }
            }}
          />
          <SettingsSwitch
            label="Forward detected ports"
            hint="Ports opened in a container, such as a dev server, on the same local port when free."
            value={current.forwardPorts}
            disabled={settings.saving}
            onValueChange={(forwardPorts) => void save({ forwardPorts })}
          />
          <SettingsInput
            key={`ignoredPorts-${revision}`}
            label="Ignored ports"
            placeholder="5432, 6379"
            initialValue={values.ignoredPorts.join(", ")}
            onChangeText={(text) => setDraft((previous) => ({ ...previous, ignoredPorts: parsePorts(text) }))}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Dotfiles">
        <SettingsCard>
          {input("dotfilesRepository", "Repository", "Cloned into new containers, like VS Code's dotfiles setting.", "owner/repo")}
          {input("dotfilesTargetPath", "Target path", undefined, "~/dotfiles")}
          {input("dotfilesInstallCommand", "Install command", undefined, "Detected")}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="SSH agent">
        <SettingsCard>
          <SettingsSwitch
            label="Forward SSH agent"
            hint="Keys loaded in this machine's agent work in new containers without a passphrase. Rebuild existing ones."
            value={current.forwardSshAgent}
            disabled={settings.saving}
            onValueChange={(forwardSshAgent) => void save({ forwardSshAgent })}
          />
          {input("sshAgentSocket", "Agent socket", "Path in Docker's VM on macOS, such as Colima's.", "Detected")}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Advanced">
        <SettingsCard>
          <SettingsSwitch label="Show tool paths" value={advanced} onValueChange={setAdvanced} />
          {advanced ? input("dockerPath", "docker path", undefined, "Detected") : null}
          {advanced ? input("devcontainerPath", "devcontainer path", undefined, "Detected") : null}
        </SettingsCard>
      </SettingsSection>

      {dirty || settings.saveError ? (
        <SettingsCard>
          <SettingsAction
            label="Unsaved changes"
            error={settings.saveError ?? undefined}
            actionLabel="Save"
            disabled={!dirty || settings.saving}
            onPress={() => void save()}
          />
        </SettingsCard>
      ) : null}
    </View>
  );
}

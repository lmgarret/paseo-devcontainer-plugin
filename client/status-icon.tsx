import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { Container, GuardWorktree } from "../shared/contract";
import { DEVCONTAINERS_ICON } from "./devcontainers-icon";
import type { ContainerView } from "./state";

// Status icons: a base (Lucide's box for a container, git-branch for a worktree, the Dev
// Containers logo for the sidebar entry) with its
// bottom-right corner cut out and a small status disc there. Used on sidebar workspace rows, the
// sidebar entry, its popover and the page, so a state looks the same everywhere.

type Colors = PluginTheme["colors"];
export type StatusTone = "muted" | "success" | "warning" | "danger" | "info";
type Base = "box" | "branch" | "logo";
type Glyph = "dot" | "pause" | "minus" | "x" | "bang" | "busy";

export interface StatusSpec {
  base: Base;
  glyph: Glyph;
  tone: StatusTone;
}

// Lucide "box" and "git-branch", drawn in the muted foreground.
const BASES: Record<Base, string> = {
  box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  branch:
    '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  // The Dev Containers logo's shapes, filled rather than stroked.
  logo: typeof DEVCONTAINERS_ICON === "string" ? "" : DEVCONTAINERS_ICON.svg.replace(/^<svg[^>]*>|<\/svg>$/g, ""),
};

// Small marks on the status disc, centred on (19, 19).
const GLYPHS: Record<Glyph, string> = {
  // The disc alone: a plain dot.
  dot: "",
  pause: '<path d="M17.6 16.9v4.2M20.4 16.9v4.2"/>',
  minus: '<path d="M16.8 19h4.4"/>',
  x: '<path d="M17 17l4 4M21 17l-4 4"/>',
  bang: '<path d="M19 16.4v3"/><path d="M19 21.5h.01"/>',
  busy: '<path d="M19 16a3 3 0 1 1-3 3"/>',
};

export function toneColor(tone: StatusTone, colors: Colors): string {
  if (tone === "success") return colors.statusSuccess;
  if (tone === "warning") return colors.statusWarning;
  if (tone === "danger") return colors.statusDanger;
  if (tone === "info") return colors.accent;
  return colors.foregroundMuted;
}

export function statusSvg(spec: StatusSpec, colors: Colors): string {
  const id = `dc-cut-${spec.base}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">` +
    `<mask id="${id}"><rect width="24" height="24" fill="#fff"/><circle cx="19" cy="19" r="7.4" fill="#000"/></mask>` +
    (spec.base === "logo"
      ? `<g mask="url(#${id})" fill="${colors.foregroundMuted}">${BASES.logo}</g>`
      : `<g mask="url(#${id})" stroke="${colors.foregroundMuted}" stroke-width="2">${BASES[spec.base]}</g>`) +
    `<circle cx="19" cy="19" r="5.6" fill="${toneColor(spec.tone, colors)}"/>` +
    `<g stroke="${colors.surface0}" stroke-width="1.9">${GLYPHS[spec.glyph]}</g>` +
    `</svg>`
  );
}

export function containerStatus(view: ContainerView): StatusSpec {
  const { container } = view;
  if (view.kind === "busy") return { base: "box", glyph: "busy", tone: "info" };
  if (view.kind === "online") return { base: "box", glyph: "dot", tone: "success" };
  if (view.kind === "stopped") return { base: "box", glyph: container.docker === "missing" ? "minus" : "pause", tone: "muted" };
  if (failedBuild(container)) return { base: "box", glyph: "x", tone: "danger" };
  return { base: "box", glyph: "bang", tone: "warning" };
}

function failedBuild(container: Container): boolean {
  return container.job?.state === "failed" && container.docker !== "running";
}

// The sidebar entry's icon: the logo, with the most urgent container's status when there is one.
export function logoStatus(view: ContainerView | undefined, colors: Colors): { svg: string } | null {
  if (!view) return null;
  return { svg: statusSvg({ ...containerStatus(view), base: "logo" }, colors) };
}

export function worktreeStatus(state: GuardWorktree["state"] | "broken" | "at-risk"): StatusSpec {
  return state === "broken" ? { base: "branch", glyph: "x", tone: "danger" } : { base: "branch", glyph: "bang", tone: "warning" };
}

export function StatusIcon({ spec, theme, size = 14 }: { spec: StatusSpec; theme: PluginTheme; size?: number }) {
  return <Icon icon={{ svg: statusSvg(spec, theme.colors) }} size={size} color={theme.colors.foregroundMuted} />;
}

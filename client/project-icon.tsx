import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Image, Text, View } from "react-native";
import { type Container, projectIconRpc } from "../shared/contract";

type Project = NonNullable<Container["project"]>;

// Paseo's identity palette and hash (app: identityColor / deriveIdentityColorName), so the
// fallback tile has the same colour as the project in the sidebar.
const IDENTITY_COLORS = [
  "#7a6aa8",
  "#3d7ea6",
  "#388068",
  "#a4673a",
  "#b05c80",
  "#6a70b8",
  "#368080",
  "#b06260",
  "#8f7838",
  "#5179b0",
];

function identityColor(viewKey: string): string {
  let hash = 0;
  for (const char of viewKey) hash = (31 * hash + char.charCodeAt(0)) >>> 0;
  return IDENTITY_COLORS[hash % IDENTITY_COLORS.length] as string;
}

function initialOf(name: string): string {
  const segments = name.trim().split("/").filter(Boolean);
  return (segments[segments.length - 1] ?? name).charAt(0).toUpperCase();
}

export function ProjectIcon({ project, hostId, size = 16 }: { project: Project; hostId: string; size?: number }) {
  const getIcon = useRpc(projectIconRpc);
  const icon = useQuery({
    queryKey: ["project-icon", project.id, project.iconRevision],
    queryFn: () => getIcon({ projectId: project.id }),
    staleTime: Number.POSITIVE_INFINITY,
  });
  // Paseo keys a project by its cross-host key, else by host and project ID.
  const viewKey = project.key ?? JSON.stringify([hostId, project.id]);
  const frame = useMemo(() => ({ width: size, height: size, borderRadius: Math.round(size * 0.25) }), [size]);
  const data = icon.data?.icon;

  if (data) {
    return <Image source={{ uri: `data:${data.mimeType};base64,${data.data}` }} style={frame} />;
  }
  return (
    <View style={[frame, { alignItems: "center", justifyContent: "center", backgroundColor: identityColor(viewKey) }]}>
      <Text style={{ color: "#ffffff", fontSize: Math.round(size * 0.5625) }}>{initialOf(project.name)}</Text>
    </View>
  );
}

// Folders that are not Paseo projects get a neutral tile with the same geometry.
export function FolderIcon({ theme, size = 16 }: { theme: PluginTheme; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.25),
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
      }}
    />
  );
}

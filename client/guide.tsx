import { openExternalUrl, type PluginScreenProps, useRpc } from "@getpaseo/plugin/client";
import { ExternalLink, Loading, Markdown, ScrollView } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { GUARD_DOCS_URL, worktreesGuideRpc } from "../shared/contract";

export const GUIDE_SCREEN_ID = "worktrees-guide";

// Rows and settings cannot navigate on their own; the entry point hands over its opener.
let opener: (() => void) | null = null;

export function setGuideOpener(open: () => void) {
  opener = open;
}

export function openGuide(): void {
  if (opener) opener();
  else void openExternalUrl(GUARD_DOCS_URL);
}

// docs/worktrees.md, read by the daemon from its copy of the plugin, so it matches the installed
// version and needs no network.
export function GuideScreen({ theme, layout }: PluginScreenProps) {
  const getGuide = useRpc(worktreesGuideRpc);
  const query = useQuery({
    queryKey: ["devcontainer-worktrees-guide"],
    queryFn: () => getGuide({}),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const markdown = query.data?.markdown ?? null;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{
        paddingHorizontal: layout.compact ? 12 : 24,
        paddingTop: layout.compact ? 16 : 32,
        paddingBottom: 48,
        maxWidth: 800,
        width: "100%",
        alignSelf: "center",
      }}
    >
      {query.isPending ? (
        <Loading />
      ) : markdown ? (
        <Markdown>{markdown}</Markdown>
      ) : (
        <View style={{ gap: 8 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
            The guide could not be read from this plugin's folder.
          </Text>
          <ExternalLink href={GUARD_DOCS_URL}>Read it on GitHub</ExternalLink>
        </View>
      )}
    </ScrollView>
  );
}

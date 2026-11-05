import type { PluginHostProps } from "@getpaseo/plugin/client";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Dimensions, Platform, Pressable, Text, View, type ViewStyle } from "react-native";

type Theme = PluginHostProps["theme"];

export const TOOLTIP_DELAY_MS = 350;
// Safety net for a missed hover-out.
const TOOLTIP_MAX_MS = 4_000;
const WIDTH = 240;
const GAP = 6;

interface Anchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

// One tooltip at a time across the plugin.
let activeTooltip: { current: () => void } | null = null;

// A delayed hover tooltip. `ref` goes on the element it describes, which is measured when the tooltip
// shows so the bubble can be placed in the window, above everything else. Handlers read refs
// because the web Pressable can keep the first handler it was given.
export function useTooltip(delayMs: number, onChange?: (shown: boolean) => void) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const ref = useRef<View>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const hideRef = useRef<() => void>(() => {});

  hideRef.current = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setAnchor(null);
    onChangeRef.current?.(false);
    if (activeTooltip === hideRef) activeTooltip = null;
  };
  const showLater = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const show = (measured: Anchor) => {
        if (activeTooltip && activeTooltip !== hideRef) activeTooltip.current();
        activeTooltip = hideRef;
        setAnchor(measured);
        onChangeRef.current?.(true);
        timer.current = setTimeout(() => hideRef.current(), TOOLTIP_MAX_MS);
      };
      if (ref.current) ref.current.measureInWindow((x, y, width, height) => show({ x, y, width, height }));
      else show({ x: 0, y: 0, width: 0, height: 0 });
    }, delayMs);
  };
  useEffect(() => () => hideRef.current(), []);
  return { ref, shown: anchor !== null, anchor, showLater, hide: () => hideRef.current() };
}

// An opaque bubble. On the web it is fixed in the window beside its anchor, centred and kept on
// screen, below it or above when there is no room; elsewhere it sits under the anchor.
export function TooltipBubble({ theme, text, anchor }: { theme: Theme; text: string; anchor: Anchor | null }) {
  let place: ViewStyle = { position: "absolute", top: (anchor?.height ?? 20) + GAP, left: 0, width: WIDTH };
  if (Platform.OS === "web" && anchor) {
    const { width: screenWidth, height: screenHeight } = Dimensions.get("window");
    const left = Math.min(Math.max(8, anchor.x + anchor.width / 2 - WIDTH / 2), screenWidth - WIDTH - 8);
    const below = anchor.y + anchor.height + GAP;
    place = {
      // react-native-web supports fixed positioning; React Native's types do not list it.
      position: "fixed" as unknown as ViewStyle["position"],
      left,
      width: WIDTH,
      ...(below + 60 > screenHeight ? { bottom: screenHeight - anchor.y + GAP } : { top: below }),
    };
  }
  return (
    <View pointerEvents="none" style={[place, { alignItems: "center", zIndex: 1000 }]}>
      <View
        style={{
          maxWidth: WIDTH,
          paddingHorizontal: 8,
          paddingVertical: 4,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface0,
          shadowColor: "#000",
          shadowOpacity: 0.45,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 4 },
        }}
      >
        <Text style={{ color: theme.colors.foreground, fontSize: 12, lineHeight: 17 }}>{text}</Text>
      </View>
    </View>
  );
}

// Shows `text` on hover. Presses go to `onPress`, so wrapping part of a pressable row keeps the row
// working.
export function WithTooltip({
  theme,
  text,
  children,
  onPress,
}: {
  theme: Theme;
  text: string;
  children: ReactNode;
  onPress?: () => void;
}) {
  const tip = useTooltip(TOOLTIP_DELAY_MS);
  return (
    <Pressable accessible={false} onPress={onPress} onHoverIn={tip.showLater} onHoverOut={tip.hide}>
      <View ref={tip.ref} collapsable={false}>
        {children}
      </View>
      {tip.shown ? <TooltipBubble theme={theme} text={text} anchor={tip.anchor} /> : null}
    </Pressable>
  );
}

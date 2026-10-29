import { type ReactNode, useState } from "react";
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from "react-native";

// Pressable with a hover background on web and desktop, and the same background while pressed.
export function HoverPressable({
  style,
  hoveredStyle,
  children,
  ...props
}: Omit<PressableProps, "style" | "children"> & {
  style: StyleProp<ViewStyle>;
  hoveredStyle: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      {...props}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => [style, (hovered || pressed) && hoveredStyle]}
    >
      {children}
    </Pressable>
  );
}

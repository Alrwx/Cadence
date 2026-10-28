// The main view's More menu: the ways to the other views, and the actions that used to float in the top bar.
import { create } from "zustand";
import { useConsent } from "../consent.ts";
import { requestPlaceListener, useListener } from "../layout/ListenerAnchor.tsx";
import { requestRecenter } from "../layout/UIAnchor.tsx";
import { resetConversation } from "../session.ts";
import { t } from "../strings.ts";
import { Button3D } from "./Button3D.tsx";
import { remember } from "./ConsentView.tsx";
import { ignoreRays } from "./glass.ts";
import { GlassPanel } from "./GlassPanel.tsx";
import { Icon3D } from "./Icon3D.tsx";
import type { IconName } from "./icons.ts";
import { notify, showView } from "./views.ts";

/** Open while the menu shows; every other main-view button, and the replies beside the listener, wait for it to close. */
export const useMoreMenu = create<{ open: boolean }>(() => ({ open: false }));

const WIDTH = 0.36;
const PAD = 0.01;
const ROW_WIDTH = WIDTH - 2 * PAD;
const ROW_HEIGHT = 0.052;
const ROW_GAP = 0.008;
const RULE_HEIGHT = 0.017;
const FONT = 0.02;
const CHEVRON = 0.02;

interface Row {
  label: string;
  icon: IconName;
  /** Opens another view, so it shows a trailing chevron. */
  opens?: boolean;
  onPress: () => void;
}

/** The menu's right edge sits at `right` and its bottom at `bottom`; it rises from there. */
export function MoreMenu({ right, bottom }: { right: number; bottom: number }) {
  const storeChat = useConsent((s) => s.storeChat);
  const placed = useListener((s) => s.spot !== null);

  const items: (Row | "rule")[] = [
    { label: t("top.recenter"), icon: "crosshair", onPress: requestRecenter },
    { label: placed ? t("menu.moveListener") : t("listener.place"), icon: "user", onPress: requestPlaceListener },
    "rule",
    { label: t("top.conversations"), icon: "message", opens: true, onPress: () => showView({ kind: "conversations" }) },
    { label: t("memories.tab"), icon: "bookOpen", opens: true, onPress: () => showView({ kind: "conversations", tab: "memories" }) },
    { label: t("memories.remember"), icon: "pin", onPress: () => (storeChat ? remember() : showView({ kind: "consent" })) },
    "rule",
    { label: t("top.settings"), icon: "sliders", opens: true, onPress: () => showView({ kind: "settings" }) },
    {
      label: t("main.shift"),
      icon: "shift",
      onPress: () => {
        resetConversation();
        notify(t("status.shifted"));
      },
    },
  ];

  let y = -PAD;
  const placedItems = items.map((item, i) => {
    if (item === "rule") {
      y -= RULE_HEIGHT;
      return { item, y: y + RULE_HEIGHT / 2 };
    }
    if (i > 0 && items[i - 1] !== "rule") y -= ROW_GAP;
    y -= ROW_HEIGHT;
    return { item, y: y + ROW_HEIGHT / 2 };
  });
  const height = PAD - y;

  return (
    <GlassPanel width={WIDTH} height={height} radius={0.03} position={[right - WIDTH / 2, bottom + height / 2, 0.02]}>
      {placedItems.map(({ item, y: rowY }, i) =>
        item === "rule" ? (
          <mesh key={`rule${i}`} position={[0, height / 2 + rowY, 0.002]} raycast={ignoreRays}>
            <planeGeometry args={[ROW_WIDTH - 0.028, 0.0015]} />
            <meshBasicMaterial color="white" transparent opacity={0.18} depthWrite={false} />
          </mesh>
        ) : (
          <Button3D
            key={item.label}
            label={item.label}
            icon={item.icon}
            variant="clear"
            align="start"
            width={ROW_WIDTH}
            height={ROW_HEIGHT}
            radius={0.02}
            fontSize={FONT}
            position={[0, height / 2 + rowY, 0.004]}
            onPress={() => {
              useMoreMenu.setState({ open: false });
              item.onPress();
            }}
          >
            {item.opens && <Icon3D name="chevronRight" size={CHEVRON} opacity={0.6} position={[ROW_WIDTH / 2 - 0.018 - CHEVRON / 2, 0, 0.004]} />}
          </Button3D>
        ),
      )}
    </GlassPanel>
  );
}

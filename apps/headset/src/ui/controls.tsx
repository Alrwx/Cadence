// Pieces every view shares: the Back circle, paging, and a tray of choices.
import { useEffect, useState } from "react";
import { ShapeGeometry, Shape } from "three";
import { layout } from "../config.ts";
import { t } from "../strings.ts";
import { Button3D } from "./Button3D.tsx";
import { ignoreRays } from "./glass.ts";
import { GlassPanel } from "./GlassPanel.tsx";
import type { IconName } from "./icons.ts";
import { showView } from "./views.ts";

/** Center height of every view's header row: Back, and the title or tabs (panel coordinates, meters). */
export const HEADER_Y = 0.345;
/** Center of the Back circle, at the header's left (meters). */
export const BACK_X = -0.43;

/** The one way back to the main view, at the same spot on every view. */
export function BackButton() {
  return (
    <Button3D
      label={t("nav.back")}
      icon="back"
      iconOnly
      width={layout.buttonHeight}
      position={[BACK_X, HEADER_Y, 0]}
      onPress={() => showView({ kind: "main" })}
    />
  );
}

/**
 * A delete that takes a second press on the same item. `confirming` is the item waiting for it; it stops waiting
 * after layout.confirmMs.
 */
export function useConfirm() {
  const [confirming, setConfirming] = useState<string | null>(null);
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(null), layout.confirmMs);
    return () => clearTimeout(timer);
  }, [confirming]);
  const press = (id: string, confirmed: () => void) => {
    if (confirming !== id) return setConfirming(id);
    setConfirming(null);
    confirmed();
  };
  return { confirming, press };
}

interface PagerProps {
  /** Zero-based. */
  page: number;
  pages: number;
  onPage: (page: number) => void;
  /** Distance from x = 0 to each arrow's center (meters). */
  halfSpan: number;
  /** Height of the arrows' centers. */
  y: number;
  /** Height of the page dots' centers. */
  dotsY: number;
}

/** Previous and next circles either side of a list or grid, and a dot per page; nothing when it fits on one page. */
export function Pager({ page, pages, onPage, halfSpan, y, dotsY }: PagerProps) {
  if (pages <= 1) return null;
  const circle = layout.buttonHeight;
  return (
    <>
      <Button3D
        label={t("pager.prev")}
        icon="chevronLeft"
        iconOnly
        width={circle}
        disabled={page <= 0}
        position={[-halfSpan, y, 0]}
        onPress={() => onPage(page - 1)}
      />
      <Button3D
        label={t("pager.next")}
        icon="chevronRight"
        iconOnly
        width={circle}
        disabled={page >= pages - 1}
        position={[halfSpan, y, 0]}
        onPress={() => onPage(page + 1)}
      />
      <PageDots page={page} pages={pages} y={dotsY} />
    </>
  );
}

const DOT = 0.01;
const CURRENT_DOT = 0.026;

function pill(width: number, height: number): ShapeGeometry {
  const r = height / 2;
  const x = width / 2 - r;
  return new ShapeGeometry(new Shape().absarc(x, 0, r, -Math.PI / 2, Math.PI / 2).absarc(-x, 0, r, Math.PI / 2, (3 * Math.PI) / 2), 8);
}

const dotGeometry = pill(DOT, DOT);
const currentDotGeometry = pill(CURRENT_DOT, DOT);

function PageDots({ page, pages, y }: { page: number; pages: number; y: number }) {
  const left = -((pages - 1) * 2 * DOT + CURRENT_DOT) / 2;
  return (
    <group position={[0, y, 0]}>
      {Array.from({ length: pages }, (_, i) => {
        const current = i === page;
        const x = left + i * 2 * DOT + (i > page ? CURRENT_DOT - DOT : 0) + (current ? CURRENT_DOT : DOT) / 2;
        return (
          <mesh key={i} geometry={current ? currentDotGeometry : dotGeometry} position={[x, 0, 0]} raycast={ignoreRays}>
            <meshBasicMaterial color="white" transparent opacity={current ? 1 : 0.4} depthWrite={false} />
          </mesh>
        );
      })}
    </group>
  );
}

export interface SegmentedOption<T> {
  value: T;
  label: string;
  icon?: IconName;
  /** False for an option that could lock a hands-free user out. */
  headSelectable?: boolean;
  /** Shown as a second-press confirm ("Delete all?"). */
  danger?: boolean;
  disabled?: boolean;
}

const OPTION_HEIGHT = 0.048;
const OPTION_FONT = 0.019;
const TRAY_GAP = 0.004;

/** Width of a Segmented tray (meters), for lining its edge up with something else. */
export const segmentedWidth = (count: number, optionWidth: number): number => count * (optionWidth + TRAY_GAP) + TRAY_GAP;

interface SegmentedProps<T> {
  options: SegmentedOption<T>[];
  /** The option shown as chosen; one matching none shows none chosen. */
  value: T;
  onChange: (value: T) => void;
  /** Center of the tray. */
  position: [number, number, number];
  optionWidth: number;
}

/** A glass tray of pill options, the chosen one in accent; the tray is 0.056 m tall. */
export function Segmented<T extends string | number | null>({ options, value, onChange, position, optionWidth }: SegmentedProps<T>) {
  const step = optionWidth + TRAY_GAP;
  return (
    <GlassPanel width={segmentedWidth(options.length, optionWidth)} height={OPTION_HEIGHT + 2 * TRAY_GAP} position={position}>
      {options.map((option, i) => (
        <Button3D
          key={String(option.value)}
          label={option.label}
          icon={option.icon}
          variant={option.danger ? "danger" : "clear"}
          selected={option.value === value}
          disabled={option.disabled}
          headSelectable={option.headSelectable}
          width={optionWidth}
          height={OPTION_HEIGHT}
          fontSize={OPTION_FONT}
          position={[(i - (options.length - 1) / 2) * step, 0, 0]}
          onPress={() => onChange(option.value)}
        />
      ))}
    </GlassPanel>
  );
}

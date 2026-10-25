// Every Button3D registers here so the head pointer can find and press it.
import type { Object3D } from "three";
import { create } from "zustand";

export interface DwellTarget {
  object: Object3D;
  label: string;
  /** Size of the button face before world scaling (meters). */
  width: number;
  height: number;
  press: () => void;
  selectable: () => boolean;
}

export const dwellTargets = new Map<string, DwellTarget>();

/** The target under the head reticle, for highlighting. */
export const useHeadHover = create<{ id: string | null }>(() => ({ id: null }));

import { createXRStore } from "@react-three/xr";

// Passthrough AR on the Quest 3S; hands are the primary input, controllers also work.
// Desktop dev gets an emulated Quest from dev/emulator.ts instead of the library's `emulate` option.
export const xrStore = createXRStore({ hand: true, controller: true, emulate: false });

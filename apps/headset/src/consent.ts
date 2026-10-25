// The person's store_chat consent as the gateway last reported it; off until it says otherwise.
import { create } from "zustand";

export const useConsent = create(() => ({ storeChat: false }));

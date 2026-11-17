"use client";

import { atom } from "jotai";
import type { SettingsBook } from "@/lib/session-settings";

/** Outlives the panels, which unmount with their tab and change with the session. */
export const sessionSettingsAtom = atom<SettingsBook>({});

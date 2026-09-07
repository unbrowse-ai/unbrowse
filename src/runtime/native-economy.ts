/**
 * native-economy — merged FDRY + AIKO native identity headers for outbound calls.
 */
import { contractClientHeaders } from "./aiko-identity.js";
import { aikoNativeHeaders } from "./aiko-native.js";
import { fdryNativeHeaders } from "../values/fdry-native.js";

export function unbrowseNativeHeaders(): Record<string, string> {
  return {
    ...contractClientHeaders(),
    ...fdryNativeHeaders(),
    ...aikoNativeHeaders(),
  };
}
import { redirect } from "next/navigation";

export default function ShadowApisRedirect() {
  redirect("/internal-apis-are-all-you-need");
}

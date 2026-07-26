import "server-only";

import { cookies } from "next/headers";
import type { AppLanguage } from "@/lib/domain/types";
import { store } from "@/lib/repositories/store";

export const LANGUAGE_COOKIE_NAME = "neraxon-language";

export async function getInitialLanguage(): Promise<AppLanguage> {
  const cookieStore = await cookies();
  const cookieLanguage = cookieStore.get(LANGUAGE_COOKIE_NAME)?.value;
  if (cookieLanguage === "tr" || cookieLanguage === "en") return cookieLanguage;
  return store.getLanguage();
}

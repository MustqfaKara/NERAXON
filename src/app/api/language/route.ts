import { NextResponse } from "next/server";
import { z } from "zod";
import { store } from "@/lib/repositories/store";
import { apiError } from "@/lib/utils/api";
import { assertSameOrigin } from "@/lib/security/same-origin";
import { LANGUAGE_COOKIE_NAME } from "@/lib/server-language";

const schema = z.object({ language: z.enum(["tr", "en"]) });

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const { language } = schema.parse(await request.json());
    store.setLanguage(language);
    const response = NextResponse.json({ language });
    response.cookies.set(LANGUAGE_COOKIE_NAME, language, {
      httpOnly: false,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
    return response;
  } catch (error) {
    return apiError(error);
  }
}

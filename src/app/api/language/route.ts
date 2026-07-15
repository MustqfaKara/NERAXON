import { NextResponse } from "next/server";
import { z } from "zod";
import { store } from "@/lib/repositories/store";
import { apiError } from "@/lib/utils/api";

const schema = z.object({ language: z.enum(["tr", "en"]) });

export async function PUT(request: Request) {
  try {
    const { language } = schema.parse(await request.json());
    store.setLanguage(language);
    return NextResponse.json({ language });
  } catch (error) {
    return apiError(error);
  }
}

import { NextResponse } from "next/server";
import { ADMIN_SESSION_COOKIE } from "@/lib/security/admin-auth";
import { assertSameOrigin } from "@/lib/security/same-origin";
import { apiError } from "@/lib/utils/api";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const response = NextResponse.json({ authenticated: false });
    response.cookies.set(ADMIN_SESSION_COOKIE, "", {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 0,
    });
    return response;
  } catch (error) {
    return apiError(error);
  }
}

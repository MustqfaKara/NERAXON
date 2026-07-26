"use client";

import Image from "next/image";
import { FormEvent, useState } from "react";
import { LockKeyhole, RefreshCw } from "lucide-react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Giriş başarısız.");
      const destination = new URLSearchParams(window.location.search).get("next");
      window.location.assign(destination?.startsWith("/") ? destination : "/overview");
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Giriş başarısız.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-shell">
      <form className="login-panel" onSubmit={submit}>
        <div className="login-brand">
          <Image src="/neraxon-symbol-v2.png" width={42} height={42} alt="" priority />
          <div><strong>NERAXON</strong><span>Canlı işlem çalışma alanı</span></div>
        </div>
        <div className="login-copy">
          <span className="eyebrow">Güvenli erişim</span>
          <h1>Yönetici girişi</h1>
          <p>Canlı portföyü ve entegrasyon anahtarlarını yönetmek için oturum açın.</p>
        </div>
        <label className="login-field">
          <span>Yönetici parolası</span>
          <div><LockKeyhole size={16} /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus autoComplete="current-password" /></div>
        </label>
        {error && <p className="login-error">{error}</p>}
        <button className="submit-button" disabled={busy || !password}>
          {busy ? <RefreshCw size={16} className="spin" /> : <LockKeyhole size={16} />}
          Giriş yap
        </button>
      </form>
    </main>
  );
}

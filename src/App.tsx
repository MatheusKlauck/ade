import { useEffect, useState } from "react";
import { subscribeNotify } from "./lib/ipc";

export default function App() {
  const [toast, setToast] = useState<{
    level: string;
    code: string;
    message: string;
  } | null>(null);

  useEffect(() => {
    let unsub: (() => void) | null = null;
    subscribeNotify((payload) => {
      setToast(payload);
      setTimeout(() => setToast(null), 6000);
    }).then((u) => {
      unsub = u;
    });
    return () => {
      if (unsub) unsub();
    };
  }, []);

  return (
    <div style={{ position: "relative", minHeight: "100vh" }}>
      {toast && (
        <div
          style={{
            position: "fixed",
            top: 16,
            right: 16,
            padding: "12px 16px",
            borderRadius: 6,
            background: toast.level === "error" ? "#c0392b" : "#2980b9",
            color: "#fff",
            zIndex: 9999,
          }}
        >
          <strong>{toast.code}</strong>: {toast.message}
        </div>
      )}
      <h1>ADE</h1>
      <p>App carregado.</p>
    </div>
  );
}

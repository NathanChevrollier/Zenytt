import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { api, errorMessage, type Server } from "../lib/api";
import { barSequence, withMods, type BarKey } from "../lib/keys";
import { ProblemCard } from "../ui";

const BAR: { key: BarKey; label: string }[] = [
  { key: "esc", label: "Échap" },
  { key: "tab", label: "Tab" },
  { key: "left", label: "←" },
  { key: "up", label: "↑" },
  { key: "down", label: "↓" },
  { key: "right", label: "→" },
  { key: "|", label: "|" },
  { key: "~", label: "~" },
  { key: "/", label: "/" },
];

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function TerminalView({ server }: { server: Server }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const termId = useRef<number | null>(null);
  const mods = useRef({ ctrl: false, alt: false });
  const [ctrl, setCtrl] = useState(false);
  const [alt, setAlt] = useState(false);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState(0);

  const send = useCallback((data: string) => {
    const id = termId.current;
    if (id === null) return;
    api.termWrite(id, data).catch(() => setEnded(true));
  }, []);

  // Ctrl et Alt sont « collants » : ils servent pour la touche suivante, puis retombent.
  const setMods = (next: { ctrl: boolean; alt: boolean }) => {
    mods.current = next;
    setCtrl(next.ctrl);
    setAlt(next.alt);
  };

  useEffect(() => {
    const t = new Terminal({
      fontFamily: css("--font-mono"),
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: css("--term"), foreground: css("--fg") },
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current!);
    f.fit();
    term.current = t;
    fit.current = f;
    setEnded(false);
    setError(null);

    let closed = false;
    const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    api
      .termOpen(server.id, t.cols, t.rows, (e) => {
        if (e.type === "data") t.write(decode(e.data));
        else setEnded(true);
      })
      .then((id) => {
        if (closed) void api.termClose(id);
        else termId.current = id;
      })
      .catch((e) => setError(errorMessage(e)));

    const input = t.onData((data) => {
      send(withMods(data, mods.current));
      if (mods.current.ctrl || mods.current.alt) setMods({ ctrl: false, alt: false });
    });
    const resize = t.onResize(({ cols, rows }) => {
      if (termId.current !== null) void api.termResize(termId.current, cols, rows).catch(() => {});
    });
    const onSize = () => f.fit();
    window.visualViewport?.addEventListener("resize", onSize);
    window.addEventListener("resize", onSize);
    // iOS coupe le socket en arrière-plan : au retour, on voit tout de suite si la session est tombée.
    const onVisible = () => {
      if (!document.hidden && termId.current !== null) api.termWrite(termId.current, "").catch(() => setEnded(true));
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      closed = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.visualViewport?.removeEventListener("resize", onSize);
      window.removeEventListener("resize", onSize);
      input.dispose();
      resize.dispose();
      if (termId.current !== null) void api.termClose(termId.current);
      termId.current = null;
      t.dispose();
    };
  }, [server.id, session, send]);

  const press = (key: BarKey) => {
    const appCursor = term.current?.modes.applicationCursorKeysMode ?? false;
    send(barSequence(key, mods.current, appCursor));
    setMods({ ctrl: false, alt: false });
    term.current?.focus();
  };

  return (
    <div className="term-wrap">
      {error && <ProblemCard serverId={server.id} error={error} onRetry={() => setSession((s) => s + 1)} />}
      {ended && !error && (
        <div className="card warn" style={{ margin: 8, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ flex: 1 }}>Session interrompue.</span>
          <button className="btn primary" onClick={() => setSession((s) => s + 1)}>
            Reconnecter
          </button>
        </div>
      )}
      <div className="term-host" ref={host} />
      <div className="keybar" role="toolbar" aria-label="Touches du terminal">
        {/* onPointerDown + preventDefault : le terminal garde le focus, donc le clavier reste ouvert. */}
        <button aria-pressed={ctrl} onPointerDown={(e) => { e.preventDefault(); setMods({ ctrl: !mods.current.ctrl, alt: mods.current.alt }); }}>
          Ctrl
        </button>
        <button aria-pressed={alt} onPointerDown={(e) => { e.preventDefault(); setMods({ ctrl: mods.current.ctrl, alt: !mods.current.alt }); }}>
          Alt
        </button>
        {BAR.map((b) => (
          <button key={b.key} onPointerDown={(e) => { e.preventDefault(); press(b.key); }}>
            {b.label}
          </button>
        ))}
      </div>
    </div>
  );
}

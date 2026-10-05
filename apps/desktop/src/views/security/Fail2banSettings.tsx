// Réglages de fail2ban : règles par défaut (durée, nombre d'échecs, fenêtre), bannissement
// progressif, jails activées et règles propres à chacune. Zenytt les écrit dans son propre fichier
// (jail.d/zz-zenytt-settings.local), lu en dernier : les fichiers du serveur ne sont pas modifiés.
import { useEffect, useMemo, useState } from "react";
import { Plus, RotateCcw, Save, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { api, errorMessage, MANUAL_JAILS, type F2bJail, type F2bJailSettings, type F2bRules, type F2bSettings } from "../../lib/api";
import { banDurationText } from "../../lib/fail2ban";
import { useAppPick } from "../../lib/store";
import { Badge, Button, ErrorState, Input, Loading, Modal, Select, Switch } from "../../components/ui";

/** Jails utiles sur un VPS, proposées même inactives (si fail2ban les connaît). */
const RECOMMENDED = ["sshd", "recidive", "nginx-http-auth", "nginx-botsearch", "nginx-bad-request", "nginx-limit-req"];

const DESCRIPTIONS: Record<string, string> = {
  sshd: "Connexions SSH",
  recidive: "Rebannit longtemps les adresses déjà bannies plusieurs fois, tous jails confondus",
  "nginx-http-auth": "Mots de passe nginx (auth_basic)",
  "nginx-botsearch": "Robots qui cherchent des pages vulnérables",
  "nginx-bad-request": "Requêtes HTTP malformées",
  "nginx-limit-req": "Dépassements de limit_req nginx",
  "apache-auth": "Mots de passe Apache",
  "apache-badbots": "Robots malveillants connus (Apache)",
  postfix: "Serveur de mail Postfix",
  dovecot: "IMAP / POP3 (Dovecot)",
  "mysqld-auth": "Connexions MySQL refusées",
  vsftpd: "FTP (vsftpd)",
};

type Unit = "server" | "min" | "h" | "d" | "w" | "forever";
const UNIT_SECS: Record<"min" | "h" | "d" | "w", number> = { min: 60, h: 3600, d: 86400, w: 7 * 86400 };

/** Secondes → nombre + unité la plus grande qui tombe juste. */
function split(secs: number | null): { n: string; unit: Unit } {
  if (secs === null) return { n: "", unit: "server" };
  if (secs < 0) return { n: "", unit: "forever" };
  for (const u of ["w", "d", "h", "min"] as const) if (secs % UNIT_SECS[u] === 0) return { n: String(secs / UNIT_SECS[u]), unit: u };
  return { n: String(Math.max(1, Math.round(secs / 60))), unit: "min" };
}

/** Durée : nombre + unité ; « réglage du serveur » (null) ou « définitif » (-1). */
function DurationInput({ value, onChange, allowForever, label }: { value: number | null; onChange: (v: number | null) => void; allowForever?: boolean; label: string }) {
  const parsed = split(value);
  const [n, setN] = useState(parsed.n);
  const [unit, setUnit] = useState<Unit>(parsed.unit);
  const toSecs = (num: string, u: Unit): number | null => {
    if (u === "server") return null;
    if (u === "forever") return -1;
    const x = Math.round(Number(num));
    return Number.isFinite(x) && x > 0 ? x * UNIT_SECS[u] : null;
  };
  // Valeur changée de l'extérieur (réinitialisation) : on la reprend, sans écraser une saisie en cours.
  useEffect(() => {
    if (value !== toSecs(n, unit)) {
      const p = split(value);
      setN(p.n);
      setUnit(p.unit);
    }
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const emit = (num: string, u: Unit) => onChange(toSecs(num, u));
  const numeric = unit !== "server" && unit !== "forever";
  return (
    <span className="flex min-w-0 gap-1.5">
      <Input
        size_="sm"
        type="number"
        min={1}
        aria-label={label}
        className="w-16! text-right tabular-nums"
        disabled={!numeric}
        placeholder={numeric ? "" : "—"}
        value={numeric ? n : ""}
        onChange={(e) => {
          setN(e.target.value);
          emit(e.target.value, unit);
        }}
      />
      <Select<Unit>
        size="sm"
        aria-label={`${label} : unité`}
        className="w-28"
        value={unit}
        onChange={(u) => {
          const num = (u === "server" || u === "forever") ? n : n || "1";
          setUnit(u);
          setN(num);
          emit(num, u);
        }}
        options={[
          { value: "server", label: "serveur" },
          { value: "min", label: "minutes" },
          { value: "h", label: "heures" },
          { value: "d", label: "jours" },
          { value: "w", label: "semaines" },
          ...(allowForever ? [{ value: "forever" as const, label: "définitif" }] : []),
        ]}
      />
    </span>
  );
}

function CountInput({ value, onChange, label }: { value: number | null; onChange: (v: number | null) => void; label: string }) {
  return (
    <Input
      size_="sm"
      type="number"
      min={1}
      max={1000}
      aria-label={label}
      className="w-20! text-right tabular-nums"
      placeholder="—"
      value={value ?? ""}
      onChange={(e) => {
        const x = Math.round(Number(e.target.value));
        onChange(e.target.value === "" || !Number.isFinite(x) || x < 1 ? null : x);
      }}
    />
  );
}

/** Les trois règles d'un jail ou par défaut, sur une ligne lisible. */
function RulesEditor({ rules, onChange }: { rules: F2bRules; onChange: (r: F2bRules) => void }) {
  const set = <K extends keyof F2bRules>(k: K, v: F2bRules[K]) => onChange({ ...rules, [k]: v });
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px] text-muted">
      <span>Bannir</span>
      <DurationInput label="Durée du bannissement" allowForever value={rules.bantime} onChange={(v) => set("bantime", v)} />
      <span>après</span>
      <CountInput label="Nombre d'échecs" value={rules.maxretry} onChange={(v) => set("maxretry", v)} />
      <span>échec(s) en</span>
      <DurationInput label="Fenêtre d'observation" value={rules.findtime} onChange={(v) => set("findtime", v)} />
    </div>
  );
}

const NO_RULES: F2bRules = { bantime: null, findtime: null, maxretry: null };
const hasRules = (r: F2bRules) => r.bantime !== null || r.findtime !== null || r.maxretry !== null;
/** Aucun réglage écrit par Zenytt : le serveur garde les siens. */
const isEmpty = (s: F2bSettings) => !hasRules(s.defaults) && !s.increment && s.jails.length === 0;

export default function Fail2banSettings({ serverId, jails, onClose, onSaved }: { serverId: string; jails: F2bJail[]; onClose: () => void; onSaved: () => void }) {
  const { ask, notify } = useAppPick("ask", "notify");
  const [settings, setSettings] = useState<F2bSettings | null>(null);
  const [initial, setInitial] = useState<string>("");
  const [available, setAvailable] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState("");
  /** Jails dont les règles propres sont dépliées. */
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.f2bSettings(serverId).then(
      (v) => {
        setSettings(v.settings);
        setInitial(JSON.stringify(v.settings));
        setAvailable(v.available);
        setOpen(new Set(v.settings.jails.filter(hasRules).map((j) => j.name)));
      },
      (e) => setError(errorMessage(e)),
    );
  }, [serverId]);

  const active = useMemo(() => new Map(jails.filter((j) => !(j.name in MANUAL_JAILS)).map((j) => [j.name, j])), [jails]);
  /** Jails affichées : actives, réglées par Zenytt, puis les recommandées que fail2ban connaît. */
  const shown = useMemo(() => {
    if (!settings) return [];
    const names = [...active.keys(), ...settings.jails.map((j) => j.name), ...RECOMMENDED.filter((n) => available.includes(n))];
    return [...new Set(names)];
  }, [settings, active, available]);

  if (error) return <Modal title="Réglages de fail2ban" onClose={onClose}><ErrorState message={error} /></Modal>;
  if (!settings) return <Modal title="Réglages de fail2ban" onClose={onClose}><Loading rows={5} /></Modal>;

  const jailOf = (name: string): F2bJailSettings => settings.jails.find((j) => j.name === name) ?? { name, enabled: null, ...NO_RULES };
  const setJail = (name: string, patch: Partial<F2bJailSettings>) =>
    setSettings((s) => {
      if (!s) return s;
      const next = { ...jailOf(name), ...patch };
      const rest = s.jails.filter((j) => j.name !== name);
      // Une jail sans réglage n'est pas écrite (et disparaît du fichier).
      return { ...s, jails: next.enabled === null && !hasRules(next) ? rest : [...rest, next] };
    });
  const isOn = (name: string) => jailOf(name).enabled ?? active.has(name);
  const dirty = JSON.stringify(settings) !== initial;
  const sshdOff = shown.includes("sshd") && !isOn("sshd");
  const addable = available.filter((n) => !shown.includes(n));

  const save = async (s: F2bSettings, message: string) => {
    setSaving(true);
    try {
      await api.f2bSettingsSet(serverId, s);
      notify(message, "success");
      onSaved();
      onClose();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!(await ask({ title: "Revenir aux réglages du serveur ?", body: "Les règles définies dans Zenytt sont retirées : fail2ban reprend celles de jail.conf et jail.local. Les bannissements en cours sont conservés.", confirmLabel: "Revenir aux réglages du serveur" }))) return;
    void save({ defaults: { ...NO_RULES }, increment: false, incrementMax: null, jails: [] }, "Réglages fail2ban du serveur rétablis");
  };

  return (
    <Modal
      title="Réglages de fail2ban"
      description="Écrits par Zenytt dans son propre fichier (jail.d/zz-zenytt-settings.local), lu en dernier : tes fichiers ne sont pas modifiés. La configuration est testée avant d'être appliquée ; les bannissements en cours sont conservés."
      width="max-w-3xl"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" className="mr-auto" icon={<RotateCcw size={13} />} disabled={saving || isEmpty(JSON.parse(initial) as F2bSettings)} onClick={() => void reset()}>
            Réglages du serveur
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" icon={<Save size={13} />} loading={saving} disabled={!dirty} onClick={() => void save(settings, "Réglages fail2ban appliqués")}>
            Appliquer
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Règles par défaut</h3>
          <p className="text-xs text-faint">Pour tous les jails qui n'ont pas de règle propre. « serveur » ou vide : la valeur de jail.conf / jail.local reste en vigueur.</p>
          <RulesEditor rules={settings.defaults} onChange={(defaults) => setSettings({ ...settings, defaults })} />
        </section>

        <section className="flex flex-col gap-2 rounded-lg border border-border bg-subtle px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <h3 className="text-sm font-medium">Bannissement progressif</h3>
              <p className="text-xs text-faint">Chaque nouveau bannissement d'une même adresse dure deux fois plus longtemps que le précédent. Les bannissements manuels (7 j, 30 j, définitif) gardent leur durée.</p>
            </div>
            <Switch label="Bannissement progressif" checked={settings.increment} onChange={(increment) => setSettings({ ...settings, increment, incrementMax: increment ? (settings.incrementMax ?? 5 * 7 * 86400) : null })} />
          </div>
          {settings.increment && (
            <div className="flex items-center gap-2 text-[13px] text-muted">
              <span>Sans dépasser</span>
              <DurationInput label="Plafond du bannissement progressif" value={settings.incrementMax} onChange={(incrementMax) => setSettings({ ...settings, incrementMax })} />
            </div>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Jails</h3>
          <ul className="divide-y divide-border/60 rounded-lg border border-border">
            {shown.map((name) => {
              const j = jailOf(name);
              const eff = active.get(name);
              const on = isOn(name);
              const changed = j.enabled !== null && j.enabled !== active.has(name);
              return (
                <li key={name} className="flex flex-col gap-2 px-3 py-2.5">
                  <div className="flex items-center gap-3">
                    <Switch label={`Activer ${name}`} checked={on} onChange={(v) => setJail(name, { enabled: v === active.has(name) ? null : v })} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-[13px]">{name}</span>
                        {changed ? <Badge tone="accent">{on ? "sera activé" : "sera désactivé"}</Badge> : eff ? <Badge tone="ok">actif</Badge> : <Badge>inactif</Badge>}
                      </span>
                      <span className="block truncate text-xs text-faint">
                        {DESCRIPTIONS[name] ?? "Jail fournie par fail2ban"}
                        {eff && ` · aujourd'hui : ${banDurationText(eff.bantime)} après ${eff.maxretry} échec(s) en ${banDurationText(eff.findtime)}`}
                      </span>
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<SlidersHorizontal size={13} />}
                      onClick={() => setOpen((o) => (o.has(name) ? new Set([...o].filter((x) => x !== name)) : new Set([...o, name])))}
                    >
                      {hasRules(j) ? "Règles propres" : "Personnaliser"}
                    </Button>
                  </div>
                  {open.has(name) && (
                    <div className="ml-12 flex flex-col gap-1">
                      <RulesEditor rules={j} onChange={(r) => setJail(name, r)} />
                      <span className="text-[11px] text-faint">« serveur » ou vide : la règle par défaut ci-dessus s'applique.</span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {addable.length > 0 && (
            <div className="flex items-center gap-2">
              <Select<string>
                size="sm"
                className="w-64"
                aria-label="Autre jail"
                value={adding}
                onChange={setAdding}
                options={[{ value: "", label: "Autre jail fournie par fail2ban…" }, ...addable.map((n) => ({ value: n, label: n }))]}
              />
              <Button
                size="sm"
                icon={<Plus size={13} />}
                disabled={!adding}
                onClick={() => {
                  setJail(adding, { enabled: true });
                  setAdding("");
                }}
              >
                Activer
              </Button>
            </div>
          )}
          {sshdOff && (
            <p className="flex items-center gap-2 text-xs text-warn">
              <TriangleAlert size={13} /> Sans le jail sshd, plus rien ne bloque les essais de mots de passe sur SSH.
            </p>
          )}
          <p className="text-[11px] text-faint">Un jail ne bannit que si le journal qu'il surveille existe (par exemple ceux de nginx pour les jails nginx-…).</p>
        </section>
      </div>
    </Modal>
  );
}

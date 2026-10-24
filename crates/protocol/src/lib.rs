//! Types et parseurs partagés entre l'app desktop et l'agent `zenyttd`.
//!
//! Les parseurs travaillent sur le texte de `/proc` : l'app les applique à la sortie d'une
//! commande SSH (mode sans agent), l'agent directement aux fichiers locaux.

use serde::{Deserialize, Serialize};

pub mod proc;

/// Version du protocole, vérifiée à la connexion pour détecter un agent obsolète.
pub const PROTOCOL_VERSION: u32 = 1;

/// Chemin du socket unix de l'agent.
pub const SOCKET_PATH: &str = "/run/zenyttd/zenyttd.sock";
/// Fichier de configuration de l'agent.
pub const CONFIG_PATH: &str = "/etc/zenyttd/config.json";

/// Compteurs bruts relevés à un instant : les taux (CPU %, débit réseau) se calculent
/// entre deux relevés.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawSample {
    /// Horodatage Unix en millisecondes.
    pub timestamp: i64,
    pub cpu: proc::CpuTimes,
    pub cpu_count: u32,
    pub mem: proc::MemInfo,
    pub load: [f64; 3],
    pub uptime_secs: f64,
    pub net_rx_bytes: u64,
    pub net_tx_bytes: u64,
    pub disks: Vec<proc::Disk>,
}

/// Métriques calculées, prêtes à afficher.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub timestamp: i64,
    pub cpu_percent: f32,
    pub cpu_count: u32,
    pub mem_used: u64,
    pub mem_total: u64,
    pub swap_used: u64,
    pub swap_total: u64,
    pub load: [f64; 3],
    pub uptime_secs: f64,
    /// Octets/seconde.
    pub net_rx_rate: f64,
    pub net_tx_rate: f64,
    pub disks: Vec<proc::Disk>,
}

impl Metrics {
    pub fn mem_percent(&self) -> f32 {
        percent(self.mem_used, self.mem_total)
    }

    /// Taux d'occupation du disque le plus rempli (généralement `/`), hors montages en lecture
    /// seule ou écartés par l'utilisateur.
    pub fn disk_percent(&self) -> f32 {
        self.disks.iter().filter(|d| d.counts()).map(|d| percent(d.used, d.total)).fold(0.0, f32::max)
    }
}

pub fn percent(used: u64, total: u64) -> f32 {
    if total == 0 {
        0.0
    } else {
        (used as f64 / total as f64 * 100.0) as f32
    }
}

/// Calcule les métriques à partir du relevé courant et, si disponible, du précédent.
pub fn compute(prev: Option<&RawSample>, cur: &RawSample) -> Metrics {
    let (cpu_percent, rx, tx) = match prev {
        Some(p) => {
            let dt = ((cur.timestamp - p.timestamp) as f64 / 1000.0).max(0.001);
            (
                cur.cpu.usage_since(&p.cpu),
                cur.net_rx_bytes.saturating_sub(p.net_rx_bytes) as f64 / dt,
                cur.net_tx_bytes.saturating_sub(p.net_tx_bytes) as f64 / dt,
            )
        }
        None => (0.0, 0.0, 0.0),
    };
    Metrics {
        timestamp: cur.timestamp,
        cpu_percent,
        cpu_count: cur.cpu_count,
        mem_used: cur.mem.used(),
        mem_total: cur.mem.total,
        swap_used: cur.mem.swap_total.saturating_sub(cur.mem.swap_free),
        swap_total: cur.mem.swap_total,
        load: cur.load,
        uptime_secs: cur.uptime_secs,
        net_rx_rate: rx,
        net_tx_rate: tx,
        disks: cur.disks.clone(),
    }
}

/// Écart minimal entre deux relevés pour calculer CPU % et débits : en dessous, la fenêtre est trop
/// courte (quelques jiffies) et le pourcentage n'a pas de sens.
pub const MIN_SAMPLE_GAP_MS: i64 = 1500;

/// Relevés bruts récents d'un serveur, partagés par tous les appelants (supervision, accueil,
/// barre du terminal). Chaque calcul se fait contre le relevé le plus récent qui a au moins
/// [`MIN_SAMPLE_GAP_MS`] : deux appels rapprochés ne faussent plus le CPU l'un de l'autre.
#[derive(Debug, Default)]
pub struct Baseline(std::collections::VecDeque<RawSample>);

impl Baseline {
    pub fn compute(&mut self, cur: RawSample) -> Metrics {
        let at = cur.timestamp;
        let base = self.0.iter().rev().find(|p| at - p.timestamp >= MIN_SAMPLE_GAP_MS).or(self.0.front());
        let metrics = compute(base, &cur);
        self.0.push_back(cur);
        // Ne garder, en tête, que le plus récent relevé assez ancien : il reste la base des suivants.
        while self.0.len() > 1 && at - self.0[1].timestamp >= MIN_SAMPLE_GAP_MS {
            self.0.pop_front();
        }
        while self.0.len() > 16 {
            self.0.pop_front();
        }
        metrics
    }
}

/// Point d'historique compact (moyenne sur une période).
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPoint {
    pub t: i64,
    pub cpu: f32,
    pub mem: f32,
    pub disk: f32,
    pub load: f32,
    pub rx: f32,
    pub tx: f32,
}

impl From<&Metrics> for HistoryPoint {
    fn from(m: &Metrics) -> Self {
        Self {
            t: m.timestamp,
            cpu: m.cpu_percent,
            mem: m.mem_percent(),
            disk: m.disk_percent(),
            load: m.load[0] as f32,
            rx: m.net_rx_rate as f32,
            tx: m.net_tx_rate as f32,
        }
    }
}

impl HistoryPoint {
    /// Moyenne d'un groupe de points, horodatée au dernier.
    pub fn average(points: &[HistoryPoint]) -> Option<HistoryPoint> {
        let last = points.last()?;
        let n = points.len() as f32;
        let sum = |f: fn(&HistoryPoint) -> f32| points.iter().map(f).sum::<f32>() / n;
        Some(HistoryPoint {
            t: last.t,
            cpu: sum(|p| p.cpu),
            mem: sum(|p| p.mem),
            disk: sum(|p| p.disk),
            load: sum(|p| p.load),
            rx: sum(|p| p.rx),
            tx: sum(|p| p.tx),
        })
    }
}

// ---------- Configuration et alertes de l'agent ----------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum AlertMetric {
    Cpu,
    Memory,
    Disk,
    Load,
}

impl AlertMetric {
    pub fn label(self) -> &'static str {
        match self {
            Self::Cpu => "CPU",
            Self::Memory => "Mémoire",
            Self::Disk => "Disque",
            Self::Load => "Charge (load 1 min)",
        }
    }

    pub fn value(self, m: &Metrics) -> f64 {
        match self {
            Self::Cpu => m.cpu_percent as f64,
            Self::Memory => m.mem_percent() as f64,
            Self::Disk => m.disk_percent() as f64,
            Self::Load => m.load[0],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AlertRule {
    pub metric: AlertMetric,
    /// Seuil : pourcentage, ou valeur brute pour la charge.
    pub threshold: f64,
    /// Durée pendant laquelle le seuil doit être dépassé avant d'alerter.
    pub for_secs: u64,
    #[serde(default = "yes")]
    pub enabled: bool,
}

/// Vérification HTTP périodique d'un site (supervision de disponibilité).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HttpCheck {
    pub name: String,
    pub url: String,
    #[serde(default = "yes")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Notifiers {
    /// URL de webhook Discord.
    #[serde(default)]
    pub discord_webhook: Option<String>,
    /// URL complète d'un topic ntfy (ex. https://ntfy.sh/mon-topic).
    #[serde(default)]
    pub ntfy_url: Option<String>,
    /// Webhook générique : reçoit un POST JSON `{title, message, severity}`.
    #[serde(default)]
    pub webhook_url: Option<String>,
}

/// Valeur affichée à la place d'une URL de notification pour un client non root.
pub const REDACTED: &str = "(masqué)";

impl Notifiers {
    /// Copie sans les URL (ce sont des secrets : qui les connaît peut envoyer des messages).
    pub fn redacted(&self) -> Self {
        let hide = |v: &Option<String>| v.as_ref().filter(|s| !s.trim().is_empty()).map(|_| REDACTED.to_string());
        Self { discord_webhook: hide(&self.discord_webhook), ntfy_url: hide(&self.ntfy_url), webhook_url: hide(&self.webhook_url) }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    /// Nom affiché dans les notifications (par défaut : hostname).
    #[serde(default)]
    pub server_name: Option<String>,
    #[serde(default = "default_interval")]
    pub sample_interval_secs: u64,
    #[serde(default)]
    pub rules: Vec<AlertRule>,
    #[serde(default)]
    pub http_checks: Vec<HttpCheck>,
    #[serde(default = "default_http_interval")]
    pub http_check_interval_secs: u64,
    #[serde(default)]
    pub notifiers: Notifiers,
    /// Points de montage exclus de l'alerte « Disque » (ex. racine d'un hébergement mutualisé).
    #[serde(default)]
    pub disk_ignore: Vec<String>,
}

fn yes() -> bool {
    true
}
fn default_interval() -> u64 {
    5
}
fn default_http_interval() -> u64 {
    60
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            server_name: None,
            sample_interval_secs: default_interval(),
            rules: vec![
                AlertRule { metric: AlertMetric::Cpu, threshold: 90.0, for_secs: 300, enabled: true },
                AlertRule { metric: AlertMetric::Memory, threshold: 90.0, for_secs: 300, enabled: true },
                AlertRule { metric: AlertMetric::Disk, threshold: 85.0, for_secs: 0, enabled: true },
            ],
            http_checks: Vec::new(),
            http_check_interval_secs: default_http_interval(),
            notifiers: Notifiers::default(),
            disk_ignore: Vec::new(),
        }
    }
}

/// Alerte actuellement déclenchée.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveAlert {
    pub key: String,
    pub title: String,
    pub message: String,
    /// Horodatage Unix (ms) du déclenchement.
    pub since: i64,
}

/// Événement du journal d'alertes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AlertEvent {
    pub t: i64,
    pub key: String,
    pub title: String,
    pub message: String,
    pub resolved: bool,
}

// ---------- Requêtes / réponses sur le socket de l'agent ----------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Request {
    Status,
    /// Derniers relevés à pleine résolution (un par intervalle d'échantillonnage).
    Live {
        count: usize,
    },
    /// Historique sur une fenêtre, sous-échantillonné à `points` points au plus.
    History {
        range_secs: u64,
        points: usize,
    },
    TestNotify,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub version: String,
    pub protocol: u32,
    pub started_at: i64,
    pub hostname: String,
    pub config: AgentConfig,
    pub config_error: Option<String>,
    pub active_alerts: Vec<ActiveAlert>,
    pub recent_events: Vec<AlertEvent>,
    pub latest: Option<Metrics>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Response {
    Status(Box<AgentStatus>),
    Live { metrics: Vec<Metrics> },
    History { points: Vec<HistoryPoint> },
    Ok { message: String },
    Error { message: String },
}

/// Sous-échantillonne une série en moyennant des groupes consécutifs.
pub fn downsample(points: &[HistoryPoint], max: usize) -> Vec<HistoryPoint> {
    if max == 0 || points.len() <= max {
        return points.to_vec();
    }
    let size = points.len().div_ceil(max);
    points.chunks(size).filter_map(HistoryPoint::average).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(t: i64, total: u64, busy: u64) -> RawSample {
        RawSample { timestamp: t, cpu: proc::CpuTimes { total, busy }, ..Default::default() }
    }

    #[test]
    fn baseline_ignores_too_close_samples() {
        let mut b = Baseline::default();
        b.compute(sample(0, 1000, 100));
        // Appel d'une autre vue 2 s plus tard : 50 % sur la fenêtre.
        assert_eq!(b.compute(sample(2000, 2000, 600)).cpu_percent, 50.0);
        // 100 ms après : trop court, calculé contre le relevé de t=0 (et non sur 100 ms).
        assert_eq!(b.compute(sample(2100, 2200, 700)).cpu_percent, 50.0);
        // Le suivant, 2 s plus tard, part du relevé de t=2100 (le plus récent assez ancien).
        assert_eq!(b.compute(sample(4000, 3200, 800)).cpu_percent, 10.0);
    }

    #[test]
    fn downsample_averages_groups() {
        let pts: Vec<_> = (0..10).map(|i| HistoryPoint { t: i, cpu: i as f32, ..Default::default() }).collect();
        let out = downsample(&pts, 5);
        assert_eq!(out.len(), 5);
        assert_eq!(out[0].cpu, 0.5);
        assert_eq!(out[4].t, 9);
    }

    #[test]
    fn request_roundtrip() {
        let json = serde_json::to_string(&Request::History { range_secs: 3600, points: 300 }).unwrap();
        assert_eq!(json, r#"{"type":"history","rangeSecs":3600,"points":300}"#);
        let back: Request = serde_json::from_str(&json).unwrap();
        assert_eq!(back, Request::History { range_secs: 3600, points: 300 });
    }

    #[test]
    fn default_config_roundtrip() {
        let cfg = AgentConfig::default();
        let json = serde_json::to_string_pretty(&cfg).unwrap();
        let back: AgentConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back, cfg);
        let minimal: AgentConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(minimal.sample_interval_secs, 5);
    }
}

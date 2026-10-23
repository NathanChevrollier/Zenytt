//! zenytt-sync : garde, pour chaque jeton, la dernière version des réglages de Zenytt.
//!
//! Le serveur ne voit jamais les réglages en clair : il reçoit une enveloppe chiffrée par l'app
//! (AES-256-GCM, clé tirée de la phrase de passe de synchronisation, inconnue du serveur) et
//! refuse tout contenu non chiffré. Chaque envoi indique la révision sur laquelle il se base :
//! s'il y en a eu une autre entre-temps, il est refusé (409) et l'app fusionne avant de renvoyer.
//!
//! Configuration (variables d'environnement) :
//! - `ZENYTT_SYNC_TOKENS` : jetons autorisés, séparés par des virgules (24 caractères minimum),
//!   un espace de stockage distinct par jeton ;
//! - `ZENYTT_SYNC_DATA` : dossier des données (défaut `/data`) ;
//! - `ZENYTT_SYNC_ADDR` : adresse d'écoute (défaut `0.0.0.0:8080`).

mod relay;

use std::collections::HashSet;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::Mutex;

/// Taille maximale d'un envoi (les réglages chiffrés pèsent quelques dizaines de Ko).
const MAX_BODY: usize = 1024 * 1024;
const MIN_TOKEN_LEN: usize = 24;

/// Compteur par clé sur une fenêtre fixe : au plus `max` évènements par `window`.
pub struct Limiter {
    max: u32,
    window: Duration,
    hits: std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, u32)>>,
}

impl Limiter {
    pub fn new(max: u32, window: Duration) -> Self {
        Self { max, window, hits: Default::default() }
    }

    /// Compte un évènement pour `key` ; `false` si la limite est dépassée.
    pub fn allow(&self, key: &str) -> bool {
        let now = std::time::Instant::now();
        let mut hits = self.hits.lock().unwrap_or_else(|e| e.into_inner());
        if hits.len() > 10_000 {
            let window = self.window;
            hits.retain(|_, (start, _)| now.duration_since(*start) < window);
        }
        let entry = hits.entry(key.to_string()).or_insert((now, 0));
        if now.duration_since(entry.0) >= self.window {
            *entry = (now, 0);
        }
        entry.1 += 1;
        entry.1 <= self.max
    }
}

/// Réponses « jeton invalide » en attente (chacune dort 400 ms) : au-delà, refus immédiat, pour
/// qu'un flot de requêtes sans jeton ne puisse pas accumuler des milliers de tâches endormies.
static PENDING_REFUSALS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(64);

pub struct App {
    dir: PathBuf,
    /// Envois de réglages par espace : un PC normal en fait quelques-uns par heure.
    writes: Limiter,
    /// Ouvertures de sessions de partage par espace.
    room_opens: Limiter,
    /// Empreintes SHA-256 des jetons autorisés (les jetons eux-mêmes ne sont pas gardés).
    tokens: HashSet<String>,
    /// Sérialise les écritures : la vérification de révision et l'écriture sont atomiques.
    write: Mutex<()>,
    /// Sessions de terminaux partagés en cours.
    rooms: relay::Rooms,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    rev: u64,
    updated: i64,
    data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Push {
    base_rev: u64,
    data: String,
}

fn sha256_hex(s: &str) -> String {
    ring::digest::digest(&ring::digest::SHA256, s.as_bytes()).as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

impl App {
    pub fn new(dir: PathBuf, tokens: HashSet<String>) -> Self {
        Self {
            dir,
            writes: Limiter::new(60, Duration::from_secs(60)),
            room_opens: Limiter::new(30, Duration::from_secs(3600)),
            tokens,
            write: Mutex::new(()),
            rooms: relay::Rooms::default(),
        }
    }

    /// Fichier de l'espace du jeton présenté, ou `None` si le jeton est inconnu.
    pub fn space(&self, headers: &HeaderMap) -> Option<PathBuf> {
        let token = headers.get("authorization")?.to_str().ok()?.strip_prefix("Bearer ")?.trim();
        let hash = sha256_hex(token);
        self.tokens.contains(&hash).then(|| self.dir.join(format!("space-{}.json", &hash[..24])))
    }
}

fn read_stored(path: &Path) -> Result<Option<Stored>, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|e| format!("données illisibles : {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Refus des contenus en clair : seule une enveloppe d'export Zenytt chiffrée est acceptée.
fn is_encrypted_envelope(data: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(data)
        .ok()
        .is_some_and(|v| v["format"] == "zenytt-export" && v["encrypted"] == true && v["data"].is_string())
}

pub async fn unauthorized() -> Response {
    // Freine les essais de jetons au hasard, dans la limite des refus déjà en attente.
    if let Ok(_permit) = PENDING_REFUSALS.try_acquire() {
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    error(StatusCode::UNAUTHORIZED, "jeton invalide")
}

/// Identifiant court d'un espace (pour les limites), tiré du nom de son fichier.
pub fn space_key(path: &Path) -> String {
    path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

async fn get_state(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    let Some(path) = app.space(&headers) else { return unauthorized().await };
    match read_stored(&path) {
        Ok(Some(s)) => Json(s).into_response(),
        Ok(None) => error(StatusCode::NOT_FOUND, "aucun contenu"),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

async fn put_state(State(app): State<Arc<App>>, headers: HeaderMap, body: Body) -> Response {
    let Some(path) = app.space(&headers) else { return unauthorized().await };
    if !app.writes.allow(&space_key(&path)) {
        return error(StatusCode::TOO_MANY_REQUESTS, "trop d'envois : réessaie dans une minute");
    }
    // Le corps n'est lu qu'une fois le jeton vérifié : un anonyme ne fait rien allouer au serveur.
    let announced = headers.get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<usize>().ok());
    if announced.is_some_and(|n| n > MAX_BODY) {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "envoi trop volumineux");
    }
    let Ok(bytes) = axum::body::to_bytes(body, MAX_BODY).await else {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "envoi trop volumineux");
    };
    let Ok(push) = serde_json::from_slice::<Push>(&bytes) else {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "corps JSON invalide");
    };
    if !is_encrypted_envelope(&push.data) {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "contenu refusé : seules les données chiffrées par Zenytt sont acceptées");
    }
    let _guard = app.write.lock().await;
    let current = match read_stored(&path) {
        Ok(s) => s.map(|s| s.rev).unwrap_or(0),
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    };
    if current != push.base_rev {
        return (StatusCode::CONFLICT, Json(json!({ "error": "révision dépassée", "rev": current }))).into_response();
    }
    let stored = Stored { rev: current + 1, updated: now_ms(), data: push.data };
    let tmp = path.with_extension("tmp");
    let written = serde_json::to_vec(&stored).map_err(|e| e.to_string()).and_then(|bytes| {
        std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
    });
    match written {
        Ok(()) => Json(json!({ "rev": stored.rev })).into_response(),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/v1/state", get(get_state).put(put_state))
        // Terminaux partagés : ouverture d'une session, puis WebSocket (hôte et invités).
        .route("/v1/relay", axum::routing::post(relay::create))
        .route("/v1/relay/{session}", get(relay::connect))
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .with_state(app)
}

fn parse_tokens(raw: &str) -> Result<HashSet<String>, String> {
    let tokens: Vec<&str> = raw.split(',').map(str::trim).filter(|t| !t.is_empty()).collect();
    if tokens.is_empty() {
        return Err("ZENYTT_SYNC_TOKENS est vide : définis au moins un jeton (openssl rand -hex 32)".into());
    }
    if let Some(short) = tokens.iter().find(|t| t.len() < MIN_TOKEN_LEN) {
        return Err(format!(
            "jeton trop court ({} caractères, {MIN_TOKEN_LEN} minimum) : génère-le avec openssl rand -hex 32",
            short.len()
        ));
    }
    Ok(tokens.into_iter().map(sha256_hex).collect())
}

/// Arrêt propre sur Ctrl+C ou SIGTERM (`docker stop`).
async fn shutdown() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal SIGTERM");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

/// Variable d'environnement, ou son ancien nom (serveurs installés avant le renommage de l'app).
fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().or_else(|| std::env::var(name.replacen("ZENYTT", "HELM", 1)).ok())
}

#[tokio::main]
async fn main() {
    let tokens = match parse_tokens(&env("ZENYTT_SYNC_TOKENS").unwrap_or_default()) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("zenytt-sync : {e}");
            std::process::exit(2);
        }
    };
    let dir = PathBuf::from(env("ZENYTT_SYNC_DATA").unwrap_or_else(|| "/data".into()));
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("zenytt-sync : dossier {} : {e}", dir.display());
        std::process::exit(2);
    }
    let addr: SocketAddr = env("ZENYTT_SYNC_ADDR").unwrap_or_else(|| "0.0.0.0:8080".into()).parse().expect("ZENYTT_SYNC_ADDR invalide");
    let count = tokens.len();
    let app = Arc::new(App::new(dir, tokens));
    // Ménage régulier des sessions de partage expirées.
    let sweeper = app.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            sweeper.rooms.sweep().await;
        }
    });
    let listener = tokio::net::TcpListener::bind(addr).await.expect("écoute impossible");
    println!("zenytt-sync {} : écoute sur {addr}, {count} jeton(s)", env!("CARGO_PKG_VERSION"));
    axum::serve(listener, router(app)).with_graceful_shutdown(shutdown()).await.expect("serveur arrêté");
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";

    async fn serve() -> (String, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let app = Arc::new(App::new(dir.path().to_path_buf(), parse_tokens(TOKEN).unwrap()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router(app)).await.unwrap() });
        (format!("{addr}"), dir)
    }

    async fn request(addr: &str, method: &str, token: &str, body: Option<&str>) -> (u16, String) {
        request_path(addr, method, "/v1/state", token, body).await
    }

    /// Requête HTTP/1.1 minimale (pas de client HTTP en dépendance juste pour les tests).
    async fn request_path(addr: &str, method: &str, path: &str, token: &str, body: Option<&str>) -> (u16, String) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
        let body = body.unwrap_or("");
        let req = format!(
            "{method} {path} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        s.write_all(req.as_bytes()).await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        let status = out[9..12].parse().unwrap();
        (status, out.split("\r\n\r\n").nth(1).unwrap_or("").to_string())
    }

    fn envelope(v: &str) -> String {
        json!({ "baseRev": 0, "data": json!({ "format": "zenytt-export", "version": 1, "encrypted": true, "data": v }).to_string() })
            .to_string()
    }

    #[tokio::test]
    async fn revisions_and_auth() {
        let (addr, _dir) = serve().await;
        assert_eq!(request(&addr, "GET", "mauvais-jeton-mauvais-jeton-xx", None).await.0, 401);
        assert_eq!(request(&addr, "GET", TOKEN, None).await.0, 404);
        let (status, body) = request(&addr, "PUT", TOKEN, Some(&envelope("a"))).await;
        assert_eq!((status, body.contains("\"rev\":1")), (200, true));
        // Même révision de base : un autre PC a envoyé entre-temps.
        assert_eq!(request(&addr, "PUT", TOKEN, Some(&envelope("b"))).await.0, 409);
        let (status, body) = request(&addr, "GET", TOKEN, None).await;
        assert_eq!(status, 200);
        assert!(body.contains("\\\"a\\\""));
        // Contenu en clair refusé.
        let plain = json!({ "baseRev": 1, "data": "{\"format\":\"zenytt-export\",\"encrypted\":false,\"data\":{}}" }).to_string();
        assert_eq!(request(&addr, "PUT", TOKEN, Some(&plain)).await.0, 422);
    }

    /// Ouverture d'une session de partage, puis échanges hôte ↔ invité.
    #[tokio::test]
    async fn relay_between_host_and_guest() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message as Ws;

        let (addr, _dir) = serve().await;
        let (status, body) = request_path(&addr, "POST", "/v1/relay", TOKEN, Some("")).await;
        assert_eq!(status, 200);
        let session = body.split("\"session\":\"").nth(1).unwrap().split('"').next().unwrap().to_string();
        assert_eq!(request_path(&addr, "POST", "/v1/relay", "mauvais-jeton-mauvais-jeton-x", Some("")).await.0, 401);

        let connect = |role: &str| {
            let url = format!("ws://{addr}/v1/relay/{session}?role={role}");
            async move { tokio_tungstenite::connect_async(url).await.unwrap().0 }
        };
        let mut host = connect("host").await;
        let mut guest = connect("guest").await;
        // Un seul hôte par session.
        assert!(tokio_tungstenite::connect_async(format!("ws://{addr}/v1/relay/{session}?role=host")).await.is_err());

        host.send(Ws::Text("sortie-chiffrée".into())).await.unwrap();
        assert_eq!(guest.next().await.unwrap().unwrap().into_text().unwrap().as_str(), "sortie-chiffrée");
        guest.send(Ws::Text("frappe-chiffrée".into())).await.unwrap();
        assert_eq!(host.next().await.unwrap().unwrap().into_text().unwrap().as_str(), "frappe-chiffrée");

        // Une session expirée coupe aussi les connexions déjà ouvertes (TTL réduit en test).
        let mut guest2 = tokio_tungstenite::connect_async(format!("ws://{addr}/v1/relay/{session}?role=guest")).await.unwrap().0;
        let ended = tokio::time::timeout(std::time::Duration::from_secs(5), async { while let Some(Ok(_)) = guest2.next().await {} }).await;
        assert!(ended.is_ok(), "le TTL aurait dû couper la connexion de l'invité");
        // L'hôte parti, la session disparaît : plus personne ne peut la rejoindre.
        let _ = host.close(None).await;
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            if tokio_tungstenite::connect_async(format!("ws://{addr}/v1/relay/{session}?role=guest")).await.is_err() {
                return;
            }
        }
        panic!("la session aurait dû être fermée avec le départ de l'hôte");
    }

    #[tokio::test]
    async fn body_is_not_read_without_token_and_is_capped() {
        let (addr, _dir) = serve().await;
        // Taille annoncée trop grande, sans corps envoyé : refus avant toute lecture.
        let raw = |token: &str| {
            format!(
                "PUT /v1/state HTTP/1.1
Host: x
Authorization: Bearer {token}
Content-Length: {}
Connection: close

",
                MAX_BODY + 1
            )
        };
        for (token, expected) in [("mauvais-jeton-mauvais-jeton-xx", "401"), (TOKEN, "413")] {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut s = tokio::net::TcpStream::connect(&addr).await.unwrap();
            s.write_all(raw(token).as_bytes()).await.unwrap();
            // Une seule lecture : le serveur attend le corps annoncé avant de fermer.
            let mut buf = [0u8; 64];
            let n = tokio::time::timeout(std::time::Duration::from_secs(3), s.read(&mut buf)).await.expect("pas de réponse").unwrap();
            assert_eq!(&String::from_utf8_lossy(&buf[..n])[9..12], expected);
        }
        assert_eq!(request(&addr, "PUT", TOKEN, Some("pas du json")).await.0, 422);
    }

    #[test]
    fn limiter_counts_per_key_and_window() {
        let l = Limiter::new(2, Duration::from_millis(50));
        assert!(l.allow("a") && l.allow("a"));
        assert!(!l.allow("a"), "troisième envoi dans la fenêtre : refusé");
        assert!(l.allow("b"), "les autres espaces ne sont pas touchés");
        std::thread::sleep(Duration::from_millis(60));
        assert!(l.allow("a"), "nouvelle fenêtre");
    }

    #[test]
    fn tokens_are_checked() {
        assert!(parse_tokens("").is_err());
        assert!(parse_tokens("court").is_err());
        assert_eq!(parse_tokens(&format!("{TOKEN}, {TOKEN}x")).unwrap().len(), 2);
    }
}

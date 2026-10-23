//! Relais de terminaux partagés : un hôte (celui qui partage) et des invités s'échangent des
//! messages par WebSocket. Le serveur ne fait que transmettre : le contenu est chiffré de bout en
//! bout par Zenytt avec une clé qui ne figure que dans le lien d'invitation, jamais ici.
//!
//! - `POST /v1/relay` (jeton requis) ouvre une session et renvoie son identifiant ;
//! - `GET  /v1/relay/{session}?role=host` connecte celui qui partage (un seul à la fois) ;
//! - `GET  /v1/relay/{session}?role=guest` connecte un invité (l'identifiant suffit).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::{broadcast, mpsc, Mutex};

use crate::App;

/// Durée de vie maximale d'une session, et délai au-delà duquel une session sans hôte est fermée.
const SESSION_TTL: Duration = if cfg!(test) { Duration::from_millis(1500) } else { Duration::from_secs(8 * 3600) };
const WITHOUT_HOST: Duration = Duration::from_secs(120);
const MAX_GUESTS: usize = 16;
/// Sessions ouvertes en même temps : par espace (jeton), et au total.
const MAX_ROOMS_PER_SPACE: usize = 8;
const MAX_ROOMS: usize = 512;
/// Messages d'invités en attente de l'hôte : au-delà, l'invité attend (plus de file sans fin).
const HOST_QUEUE: usize = 256;
/// Taille maximale d'un message relayé (une frappe ou un écran de terminal chiffré).
const MAX_FRAME: usize = 256 * 1024;

pub struct Room {
    /// Messages de l'hôte vers les invités.
    to_guests: broadcast::Sender<String>,
    /// Messages des invités vers l'hôte.
    to_host: mpsc::Sender<String>,
    /// Réception côté hôte, prise par sa connexion (une seule à la fois).
    host_inbox: Mutex<Option<mpsc::Receiver<String>>>,
    /// Espace (jeton) qui a ouvert la session.
    space: String,
    created: Instant,
    /// Dernier moment où l'hôte était connecté.
    host_seen: Mutex<Instant>,
}

#[derive(Default)]
pub struct Rooms(Mutex<HashMap<String, Arc<Room>>>);

impl Rooms {
    async fn get(&self, session: &str) -> Option<Arc<Room>> {
        self.0.lock().await.get(session).cloned()
    }

    /// Ferme les sessions expirées ou abandonnées par leur hôte.
    pub async fn sweep(&self) {
        let now = Instant::now();
        let mut rooms = self.0.lock().await;
        let mut closed = Vec::new();
        for (id, room) in rooms.iter() {
            let idle = now.duration_since(*room.host_seen.lock().await);
            if now.duration_since(room.created) > SESSION_TTL || idle > WITHOUT_HOST {
                closed.push(id.clone());
            }
        }
        for id in closed {
            rooms.remove(&id);
        }
    }
}

fn session_id() -> String {
    let mut bytes = [0u8; 16];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes).expect("aléa indisponible");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Ouverture d'une session de partage : réservée aux porteurs d'un jeton.
pub async fn create(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    let Some(path) = app.space(&headers) else {
        return crate::unauthorized().await;
    };
    let space = crate::space_key(&path);
    if !app.room_opens.allow(&space) {
        return (StatusCode::TOO_MANY_REQUESTS, "trop de partages ouverts cette heure-ci").into_response();
    }
    app.rooms.sweep().await;
    let (to_guests, _) = broadcast::channel(256);
    let (to_host, host_inbox) = mpsc::channel(HOST_QUEUE);
    let id = session_id();
    let room = Room {
        to_guests,
        to_host,
        host_inbox: Mutex::new(Some(host_inbox)),
        space: space.clone(),
        created: Instant::now(),
        host_seen: Mutex::new(Instant::now()),
    };
    let mut rooms = app.rooms.0.lock().await;
    if rooms.len() >= MAX_ROOMS || rooms.values().filter(|r| r.space == space).count() >= MAX_ROOMS_PER_SPACE {
        return (StatusCode::TOO_MANY_REQUESTS, "trop de partages en cours : arrête-en un avant d'en ouvrir un autre").into_response();
    }
    rooms.insert(id.clone(), Arc::new(room));
    drop(rooms);
    Json(json!({ "session": id, "ttlSecs": SESSION_TTL.as_secs() })).into_response()
}

#[derive(Deserialize)]
pub struct Role {
    role: String,
}

pub async fn connect(State(app): State<Arc<App>>, Path(session): Path<String>, Query(q): Query<Role>, ws: WebSocketUpgrade) -> Response {
    let Some(room) = app.rooms.get(&session).await else {
        return (StatusCode::NOT_FOUND, "session inconnue ou terminée").into_response();
    };
    let host = q.role == "host";
    if host {
        let Some(inbox) = room.host_inbox.lock().await.take() else {
            return (StatusCode::CONFLICT, "cette session a déjà un hôte").into_response();
        };
        let (room, app, session) = (room.clone(), app.clone(), session.clone());
        return ws.max_message_size(MAX_FRAME).on_upgrade(move |socket| host_loop(socket, room, inbox, app, session));
    }
    if room.to_guests.receiver_count() >= MAX_GUESTS {
        return (StatusCode::TOO_MANY_REQUESTS, "trop d'invités sur cette session").into_response();
    }
    ws.max_message_size(MAX_FRAME).on_upgrade(move |socket| guest_loop(socket, room))
}

/// Hôte : ses messages partent vers tous les invités, et il reçoit les leurs.
async fn host_loop(socket: WebSocket, room: Arc<Room>, mut inbox: mpsc::Receiver<String>, app: Arc<App>, session: String) {
    use futures_util::{SinkExt, StreamExt};
    let (mut tx, mut rx) = socket.split();
    let expiry = tokio::time::sleep_until((room.created + SESSION_TTL).into());
    tokio::pin!(expiry);
    loop {
        tokio::select! {
            // La durée de vie vaut aussi pour les connexions déjà ouvertes.
            _ = &mut expiry => break,
            incoming = rx.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    let _ = room.to_guests.send(text.to_string());
                    *room.host_seen.lock().await = Instant::now();
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Binary(_))) => {}
                _ => break,
            },
            from_guest = inbox.recv() => match from_guest {
                Some(text) => {
                    if tx.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                None => break,
            },
        }
    }
    // L'hôte est parti : la session se ferme (les invités reçoivent la fin du canal).
    app.rooms.0.lock().await.remove(&session);
}

/// Invité : il reçoit ce que l'hôte diffuse et lui envoie ses frappes.
async fn guest_loop(socket: WebSocket, room: Arc<Room>) {
    use futures_util::{SinkExt, StreamExt};
    let (mut tx, mut rx) = socket.split();
    let mut feed = room.to_guests.subscribe();
    let expiry = tokio::time::sleep_until((room.created + SESSION_TTL).into());
    tokio::pin!(expiry);
    loop {
        tokio::select! {
            _ = &mut expiry => break,
            incoming = rx.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    if room.to_host.send(text.to_string()).await.is_err() {
                        break;
                    }
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Binary(_))) => {}
                _ => break,
            },
            broadcasted = feed.recv() => match broadcasted {
                Ok(text) => {
                    if tx.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            },
        }
    }
}
